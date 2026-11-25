/** Drives the real service worker (background.js) against a stubbed chrome.* so
 *  the download bookkeeping — the part that used to report "undefined" — is checked.
 */
import { readFileSync } from 'node:fs';
import { setTimeout as realSetTimeout } from 'node:timers';

const src = readFileSync(new URL('../long-screenshot/background.js', import.meta.url), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const RENDER_RESULT = {
  ok: true,
  files: [{ name: 'page.png', width: 2400, height: 7040, dataUrl: 'data:image/png;base64,' + 'A'.repeat(204) }],
  thumb: 'data:image/jpeg;base64,JPEGDATA',
  message: ''
};

/** mode: complete | interrupted | hang | no-record | blocked-api
 *  page: what the injected driver would report — scroll positions are absolute, so
 *  a range run is the place where offset normalisation has to show up. */
function makeChrome(mode, searchResult, page = {}) {
  const cfg = {
    docHeight: 3520,
    viewport: 800,
    // the capture spans the window, so it is wider than the content box by the scrollbar
    cssWidth: 1200,
    winW: 1215,
    left: 0,
    top: 0,
    ys: [0, 680, 1360, 2040, 2720],
    range: null,
    region: null,
    // how many upcoming calls should answer with the transient「tab not reachable」error
    transientCaptures: 0,
    transientInjects: 0,
    // a shot taken before the new scroll position was painted returns the previous pixels
    staleCaptures: 0,
    pinnedCaptures: 0,
    transientError: 'Cannot access contents of url "". Extension manifest must request permission to access this host.',
    ...page
  };
  const events = [];
  const messages = [];
  const downloads = [];
  const changeListeners = [];
  let onMessage = null;
  let runCommand = null;
  let lastFrameUrl = null;

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => (onMessage = fn) },
      sendMessage: async (msg) => {
        messages.push(msg);
        if (msg.type === 'LS_EVENT') {
          events.push(msg.state);
          return {};
        }
        if (msg.type === 'LS_RENDER') return RENDER_RESULT;
        return { ok: true };
      },
      // used as the idle keep-alive while the region overlay is open
      getPlatformInfo: async (cb) => cb && cb({ os: 'win' }),
      getURL: (path) => `chrome-extension://test/${path}`
    },
    tabs: {
      get: async (id) => ({ id, windowId: 7, active: true, url: 'https://example.com/doc', title: 'Doc' }),
      query: async () => [{ id: 1, windowId: 7, url: 'https://example.com/doc', title: 'Doc' }],
      captureVisibleTab: async () => {
        state.captures += 1;
        if (cfg.transientCaptures > 0) {
          cfg.transientCaptures -= 1;
          throw new Error(cfg.transientError);
        }
        /* Two different things look the same on screen: a shot that lost the race with the
         * paint repeats the previous pixels once, a pinned section repeats them forever. */
        if (cfg.pinnedCaptures > 0 && lastFrameUrl) {
          cfg.pinnedCaptures -= 1;
          return lastFrameUrl;
        }
        if (cfg.staleCaptures > 0 && lastFrameUrl) {
          cfg.staleCaptures -= 1;
          return lastFrameUrl;
        }
        lastFrameUrl = `data:image/png;base64,FRAME${state.captures}`;
        return lastFrameUrl;
      }
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        state.injections += 1;
        if (cfg.transientInjects > 0 && (!cfg.injectFailOn || func.name === cfg.injectFailOn)) {
          cfg.transientInjects -= 1;
          throw new Error(cfg.transientError);
        }
        if (func.name === 'FUNC_REGION') return [{ result: cfg.region || null }];
        if (func.name === 'FUNC_INSTALL') {
          cfg.lastInstall = args[0] || {};
          const asked = (args[0] || {}).range;
          const range = asked && asked.end - asked.start >= 20 ? asked : null;
          return [{ result: { cssWidth: cfg.cssWidth, viewport: cfg.viewport, frame: { winW: cfg.winW, left: cfg.left, top: cfg.top }, scrollY: range ? range.start : 0, docHeight: cfg.docHeight, range, dpr: 2, scrollable: true, visible: true } }];
        }
        if (func.name === 'FUNC_CALL') {
          const [name] = args;
          if (name === 'prepass') return [{ result: { ok: true, docHeight: cfg.docHeight } }];
          if (name === 'restore') return [{ result: { ok: true } }];
          const i = state.step++;
          const scrollY = cfg.ys[Math.min(i, cfg.ys.length - 1)];
          const last = i >= cfg.ys.length - 1;
          return [{ result: { ok: true, scrollY, viewport: cfg.viewport, docHeight: cfg.docHeight, cssWidth: cfg.cssWidth, frame: { winW: cfg.winW, left: cfg.left, top: cfg.top }, done: last } }];
        }
        return [{ result: { error: 'unexpected injection' } }];
      }
    },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    storage: { local: { get: async () => ({}) } },
    commands: { onCommand: { addListener: (fn) => { runCommand = fn; } } },
    downloads:
      mode === 'blocked-api'
        ? undefined
        : {
            download: (opts) => {
              const id = downloads.push({ ...opts, state: 'in_progress' });
              if (mode === 'complete' || mode === 'interrupted') {
                realSetTimeout(() => {
                  const delta =
                    mode === 'complete'
                      ? { id, state: { current: 'complete' } }
                      : { id, state: { current: 'interrupted' }, error: { current: 'FILE_BLOCKED' } };
                  changeListeners.forEach((fn) => fn(delta));
                }, 0);
              }
              return id;
            },
            onChanged: {
              addListener: (fn) => changeListeners.push(fn),
              removeListener: (fn) => {
                const at = changeListeners.indexOf(fn);
                if (at >= 0) changeListeners.splice(at, 1);
              }
            },
            search: async () => (mode === 'no-record' ? [] : searchResult ? [{ ...searchResult }] : [{ filename: '' }]),
            show: () => {}
          }
  };
  const state = {
    api: chrome,
    cfg,
    events,
    messages,
    downloads,
    getListener: () => onMessage,
    command: async (name) => runCommand && runCommand(name),
    step: 0,
    captures: 0,
    injections: 0
  };
  return state;
}

function boot(mode, searchResult, page) {
  const env = makeChrome(mode, searchResult, page);
  // Cap the download deadline so the "hang" branch is testable without waiting 25s.
  const setTimeoutStub = (fn, ms) => realSetTimeout(fn, Math.min(ms, 20));
  new Function('chrome', 'setTimeout', src)(env.api, setTimeoutStub);
  return env;
}

function send(env, type, payload) {
  return new Promise((resolve) => env.getListener()({ type, ...payload }, {}, resolve));
}

/** Waits for a terminal state reported after `since` events, so a second run on the
 *  same environment is not mistaken for the first run's leftover. */
async function settle(env, since = 0) {
  const done = () => env.events.slice(since).some((s) => s.status === 'done' || s.status === 'error');
  for (let i = 0; i < 40 && !done(); i++) {
    await new Promise((r) => realSetTimeout(r, 25));
  }
  return env.events[env.events.length - 1];
}

async function runOnce(mode, options, searchResult, page) {
  const env = boot(mode, searchResult, page);
  const res = await send(env, 'LS_START', { tabId: 1, options: options || {} });
  if (!res.ok) return { env, res, states: env.events };
  return { env, res, final: await settle(env), states: env.events };
}

const ABSOLUTE = { filename: 'C:\\Users\\me\\Pictures\\Screenshots\\LongShot\\example.com-Doc-2026-11-24-18-30.png', state: 'complete' };

console.log('download completes');
{
  const { final, env } = await runOnce('complete', {}, ABSOLUTE);
  check('reaches done', final.status === 'done', final);
  check('reports the absolute path', final.file === ABSOLUTE.filename, final.file);
  check('no undefined in the message', !/undefined/.test(JSON.stringify(final)));
  check('downloaded into the LongShot subfolder', (env.downloads[0] || {}).filename?.startsWith('LongShot/'), env.downloads[0]);
  check('passes the image data through', (env.downloads[0] || {}).url?.length > 200);
  check('offscreen document closed', true);
  check('a full-page run still hides the fixed layer', env.cfg.lastInstall.hideFixed === true, env.cfg.lastInstall);
}

console.log('download interrupted by the browser');
{
  const { final, env } = await runOnce('interrupted', {}, { filename: '', state: 'interrupted', error: 'FILE_BLOCKED' });
  check('reports an error instead of success', final.status === 'error', final);
  check('explains the block in chinese', /拦截/.test(final.error || ''), final.error);
}

console.log('downloads API unavailable (stale service worker)');
{
  const { final } = await runOnce('blocked-api', {});
  check('reports an error', final.status === 'error', final);
  check('tells the user to reload the extension', /重新加载/.test(final.error || ''), final.error);
}

console.log('save-as dialog still open when the deadline passes');
{
  const { final, env } = await runOnce('hang', { saveAs: true });
  check('reaches done', final.status === 'done', final);
  check('falls back to the suggested path', final.file === 'LongShot/page.png', final.file);
  check('asked the browser for a dialog', (env.downloads[0] || {}).saveAs === true, env.downloads[0]);
}

console.log('downloader leaves no record');
{
  const { final } = await runOnce('no-record', {});
  check('reaches done', final.status === 'done', final);
  check('still names the file', final.file === 'LongShot/page.png', final.file);
}

console.log('download already finished before the listener attached');
{
  const { final } = await runOnce('already', {}, ABSOLUTE);
  check('reaches done', final.status === 'done', final);
  check('reads the path from the record', final.file === ABSOLUTE.filename, final.file);
}

console.log('hand-marked range 1000 -> 3000 on a 6000px page');
{
  const { env, final } = await runOnce(
    'complete',
    { range: { start: 1000, end: 3000 } },
    ABSOLUTE,
    { docHeight: 6000, ys: [1000, 1680, 2200] }
  );
  const offsets = env.messages.filter((m) => m.type === 'LS_FRAME').map((m) => m.offsetY);
  check('offsets made relative to the range start', offsets.join(',') === '0,680,1200', offsets);
  const frame = env.messages.find((m) => m.type === 'LS_FRAME');
  check('each screen carries the viewport it was captured from', frame.viewportCss === 800 && frame.frame.winW === 1215, frame);
  const render = env.messages.find((m) => m.type === 'LS_RENDER');
  check('height clipped to the range', render.docHeightCss === 2000, render.docHeightCss);
  check('window box forwarded once for the whole run', render.frame && render.frame.winW === 1215 && render.frame.left === 0, render.frame);
  check('dedupe flag forwarded', render.dedupe === true, render.dedupe);
  check('reaches done', final.status === 'done', final);
}

console.log('cached result feeds the copy / open-in-tab buttons');
{
  const { env, final } = await runOnce('complete', {}, ABSOLUTE);
  check('reaches done', final.status === 'done', final);
  check('the done event advertises the result', !!final.shot, final.shot);
  const { shot } = await send(env, 'LS_GET_SHOT');
  check('one part handed to the viewer', shot && shot.parts.length === 1, shot);
  check('pixels travel as a blob url, not a message', /^(blob:|data:)/.test(shot.parts[0].url), shot.parts[0].url);
  check('size and type reported', shot.parts[0].bytes === 153 && shot.parts[0].type === 'image/png', shot.parts[0]);
  check('dimensions forwarded from the stitcher', shot.parts[0].width === 2400 && shot.parts[0].height === 7040, shot.parts[0]);
  check('the saved path is carried along', shot.file === ABSOLUTE.filename, shot.file);

  const firstUrl = shot.parts[0].url;
  env.step = 0;
  await send(env, 'LS_START', { tabId: 1, options: {} });
  const again = await settle(env, env.events.length);
  const next = (await send(env, 'LS_GET_SHOT')).shot;
  check('a second run still succeeds', again.status === 'done', again);
  check('the viewer now points at the new image', next.parts[0].url !== firstUrl, { firstUrl, next: next.parts[0].url });
}

console.log('framed region: 400 px wide band at document y 1700..2600');
{
  const region = { xRatio: 100 / 1200, widthRatio: 400 / 1200, width: 400, height: 900, top: 1700, bottom: 2600 };
  const env = boot('complete', ABSOLUTE, { docHeight: 6000, ys: [1700, 2200, 2600], region });
  const res = await send(env, 'LS_REGION', { tabId: 1, options: {} });
  check('the selection started a job', res.ok === true && !res.cancelled, res);
  const final = await settle(env, 0);
  const frames = env.messages.filter((m) => m.type === 'LS_FRAME').map((m) => m.offsetY);
  const render = env.messages.find((m) => m.type === 'LS_RENDER');
  check('the vertical band became the scroll range', frames.join(',') === '0,500,900', frames);
  check('height clipped to the band', render.docHeightCss === 900, render.docHeightCss);
  check('band forwarded to the stitcher', render.crop && Math.abs(render.crop.xRatio - 100 / 1200) < 1e-9 && Math.abs(render.crop.widthRatio - 400 / 1200) < 1e-9, render.crop);
  check('box handed to the driver as the scroll range', env.cfg.lastInstall.range.start === 1700 && env.cfg.lastInstall.range.end === 2600, env.cfg.lastInstall.range);
  check('the fixed layer stays visible inside a framed box', env.cfg.lastInstall.hideFixed === false, env.cfg.lastInstall);
  check('reaches done', final.status === 'done', final);
}

console.log('region cancelled with Esc');
{
  const env = boot('complete', ABSOLUTE, { region: null });
  const res = await send(env, 'LS_REGION', { tabId: 1, options: {} });
  check('reports the cancellation', res.ok === true && res.cancelled === true, res);
  const { state } = await send(env, 'LS_STATE');
  check('no job was started', state.status === 'idle', state.status);
}

console.log('region too small to be useful');
{
  const region = { xRatio: 0, widthRatio: 0.5, width: 600, height: 10, top: 100, bottom: 110 };
  const env = boot('complete', ABSOLUTE, { region });
  const res = await send(env, 'LS_REGION', { tabId: 1, options: {} });
  check('rejected before any scrolling', res.ok === false && /太小/.test(res.error), res);
  const { state } = await send(env, 'LS_STATE');
  check('nothing left running', state.status === 'idle', state.status);
}

console.log('region hotkey');
{
  const region = { xRatio: 0, widthRatio: 1, width: 1200, height: 500, top: 200, bottom: 700 };
  const env = boot('complete', ABSOLUTE, { docHeight: 6000, ys: [200], region });
  await env.command('capture-region');
  const final = await settle(env, 0);
  const render = env.messages.find((m) => m.type === 'LS_RENDER');
  check('the hotkey starts the framed capture', final.status === 'done', final);
  check('only the box height is kept', render.docHeightCss === 500, render.docHeightCss);
  check('the rest of the screen cannot stretch the image', render.lastViewportCss === 500, render.lastViewportCss);
  check('a box that spans the width is not cropped', !render.crop, render.crop);
}

console.log('region hotkey with a box the driver will not accept');
{
  const region = { xRatio: 0, widthRatio: 0.5, width: 600, height: 10, top: 100, bottom: 110 };
  const env = boot('complete', ABSOLUTE, { region });
  await env.command('capture-region');
  const { state } = await send(env, 'LS_STATE');
  check('the reason waits for the next popup open', /太小/.test(state.error || ''), state.error);
  check('and nothing is running', state.status === 'idle', state.status);
  await env.command('capture-other');
  check('unregistered commands are ignored', env.events.length === 1, env.events.length);
}

console.log('state query');

{
  const env = boot('complete');
  const { state } = await send(env, 'LS_STATE');
  check('idle snapshot has a build stamp', typeof state.build === 'string' && state.build.length > 0, state.build);
  check('idle snapshot has an empty file string', state.file === '', state.file);
  check('idle snapshot has no cached result', state.shot === null, state.shot);
}

console.log('the tab is briefly unreachable in the middle of a run');
{
  const { env, final } = await runOnce('complete', {}, ABSOLUTE, { transientCaptures: 2 });
  const frames = env.messages.filter((m) => m.type === 'LS_FRAME').length;
  check('a hiccup does not kill the run', final.status === 'done', final);
  check('every screen still made it to the stitcher', frames === 5, frames);
  check('only the two failed frames were retaken', env.captures === 7, env.captures);
}

console.log('the shot is taken before the new scroll position is painted');
{
  const { env, final } = await runOnce('complete', {}, ABSOLUTE, { staleCaptures: 1 });
  const urls = env.messages.filter((m) => m.type === 'LS_FRAME').map((m) => m.dataUrl);
  check('the run still finishes', final.status === 'done', final);
  // One screen came back identical, so it was shot a second time.
  check('the stale screen is re-shot instead of folded away', env.captures === 6, env.captures);
  check('no two screens carry the same pixels', new Set(urls).size === urls.length, urls);
  check('the offsets are untouched by the retry', urls.length === 5, urls.length);
}

console.log('a section really is pinned to the viewport');
{
  const { env, final } = await runOnce('complete', {}, ABSOLUTE, { pinnedCaptures: 99 });
  check('the run still finishes', final.status === 'done', final);
  // Two repeats get the extra wait; after that the run stops paying for a page that
  // never changes and leaves the repetition to the stitcher.
  check('the wait is not paid on every screen', env.captures === 7, env.captures);
  check('the repeats still reach the stitcher with their offsets', env.messages.filter((m) => m.type === 'LS_FRAME').length === 5, env.messages.length);
}

console.log('the page script is briefly unreachable');
{
  const { env, final } = await runOnce('complete', {}, ABSOLUTE, { transientInjects: 2, injectFailOn: 'FUNC_CALL' });
  const offsets = env.messages.filter((m) => m.type === 'LS_FRAME').map((m) => m.offsetY);
  check('a rejected injection is replayed', final.status === 'done', final);
  // A rejected executeScript never ran the driver, so replaying must not skip a step.
  check('no screen is skipped by the replay', offsets.join(',') === '0,680,1360,2040,2720', offsets);
}

console.log('the page stays unreachable until the retries run out');
{
  const { final } = await runOnce('complete', {}, ABSOLUTE, { transientCaptures: 99 });
  check('the run gives up', final.status === 'error', final.status);
  check('says the page has to stay visible', /页面不在前台/.test(final.error || ''), final.error);
  check('does not leak chrome\'s permission text', !/manifest must request/.test(final.error || ''), final.error);
}

console.log(failures ? `${failures} background check(s) failed` : 'all background checks passed');
process.exit(failures ? 1 : 0);
