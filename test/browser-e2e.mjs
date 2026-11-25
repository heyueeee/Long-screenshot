/* End-to-end checks against a real Chromium browser: the extension is loaded
 * unpacked, a fixture page is captured through the shipped code path, and the
 * downloaded PNG is measured instead of eyeballed.
 *
 *   node test/browser-e2e.mjs capture     长截图 + 拼接几何 + 下载落盘
 *   node test/browser-e2e.mjs range       两次 LS_MARK 定范围，成品逐行对齐整页图
 *   node test/browser-e2e.mjs anim        页面自带 smooth+snap：偏移与像素必须一致
 *   node test/browser-e2e.mjs region      LS_REGION 真实拖框：顶部/下滚/跨吸顶栏/单击选元素/容器内
 *   node test/browser-e2e.mjs container   只滚动内部容器（Feishu/Notion 那类）的页面
 *   node test/browser-e2e.mjs dedupe      去重判据：离屏文档里相邻帧的真实行差
 *   node test/browser-e2e.mjs jpeg        JPEG + 2× 清晰度档位，与同页 PNG 比体积
 *   node test/browser-e2e.mjs ocr         结果页里的离线识别（CSP / wasm worker / 语言包）
 *   node test/browser-e2e.mjs annotate    工具栏画一笔 + 撤销 + 导出
 *   node test/browser-e2e.mjs clipboard   复制到剪贴板：拦截交给剪贴板 API 的 PNG（LS_HEADED=1 再读回系统剪贴板）
 *   node test/browser-e2e.mjs cancel      跑到一半 LS_STOP，状态与页面都要复原
 *   node test/browser-e2e.mjs stale       杀掉 service worker 后结果页的兜底提示
 *   node test/browser-e2e.mjs all         全部按上面的顺序连着跑
 *
 * Every stage implies capture first: the editor works on the shot the service worker
 * keeps in memory, and stale deliberately ends the run by discarding it.
 *
 * Needs Edge (branded Chrome ignores --load-extension since 137). */
import { spawn } from 'node:child_process';
import { statSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as nodeSleep } from 'node:timers/promises';

import { CDP, launch, serve } from './cdp.mjs';
import { pngSize, jpegSize, decodeRgb, rowSignatures, longestRepeat, longestIdenticalRun, rowMatch, bestCropMatch } from './png.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const EXT = `${ROOT}/long-screenshot`;
const BIN = process.env.BROWSER_BIN || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = process.env.LS_PROFILE || 'C:\\Users\\80495\\AppData\\Local\\Temp\\ls-e2e';
const PORT = Number(process.env.PORT || 9445);
const WEB_PORT = Number(process.env.WEB_PORT || 8791);
const FIXTURE = `http://127.0.0.1:${WEB_PORT}/e2e-page.html`;
const STAGES = process.argv[2] || 'capture';

let bad = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) bad += 1;
};
const section = (title) => console.log(`\n=== ${title} ===`);

async function up() {
  const headless = !/^(1|true|yes)$/i.test(process.env.LS_HEADED || '');
  const { server } = await serve(`${ROOT}/test`, WEB_PORT);
  const { child, version } = await launch({ bin: BIN, ext: EXT, profile: PROFILE, port: PORT, headless });
  console.log(`browser: ${version.Browser}  cdp: ${PORT}  ${headless ? '无头' : '有头'}`);
  const cdp = await CDP.open(version.webSocketDebuggerUrl);
  const id = await ourExtensionId(PROFILE);
  const sw = (await cdp.targets()).find((t) => t.type === 'service_worker' && t.url.includes(id));
  console.log(`extension: ${id} · service worker ${sw ? '已注册' : '未注册'}`);
  check('扩展被浏览器加载且 worker 起来了', !!id && !!sw, { id, sw: !!sw });
  /* A browser left running by an earlier run answers on the same port, and its windows are
   * not in the foreground — captureVisibleTab then returns pixels from a scroll position this
   * run never asked for. Better to stop here than to report that as a product defect. */
  const pages = (await cdp.targets()).filter((t) => t.type === 'page' && !/^edge:|^chrome:|^devtools:/.test(String(t.url || '')));
  check('端口上就是本次启动的浏览器', pages.length === 1 && /about:blank/.test(String(pages[0].url)), pages.map((t) => t.url));
  /* One popup window for the whole run: captureVisibleTab grabs the visible tab of
   * the *target's* window, so the driver UI must never live in the page's window. */
  const popup = await cdp.attach(await cdp.newTarget(`chrome-extension://${id}/popup.html`, true));
  const popupTab = await cdp.eval(popup, `const t = await chrome.tabs.getCurrent(); return t ? t.id : null;`);
  return { server, child, cdp, id, popup, popupTab, headless };
}

/* Edge re-parents its own process tree, so SIGKILL on the child can leave the browser
 * (and the profile lock) alive behind the next run. Escalate to the whole tree. */
async function shutdown(ctx) {
  try { ctx.cdp.close(); } catch {}
  try { ctx.child.kill('SIGKILL'); } catch {}
  for (let i = 0; i < 20; i += 1) {
    if (!ctx.child || ctx.child.exitCode !== null) break;
    await nodeSleep(250);
  }
  if (ctx.child && ctx.child.exitCode === null) {
    const { spawnSync } = await import('node:child_process');
    spawnSync('taskkill', ['/PID', String(ctx.child.pid), '/T', '/F'], { stdio: 'ignore' });
    console.log('用 taskkill 收掉了还没退出的浏览器进程树');
  }
  ctx.server.close();
}

/* The unpacked id is derived from its path, so the fresh profile's prefs are the
 * least fragile way to find it: built-in extensions have background.js too. */
async function ourExtensionId(profile) {
  const file = `${profile.replace(/\\/g, '/')}/Default/Secure Preferences`;
  for (let i = 0; i < 20; i += 1) {
    try {
      const prefs = JSON.parse(readFileSync(file, 'utf8'));
      const settings = (prefs.extensions && prefs.extensions.settings) || {};
      const id = Object.keys(settings).find((k) => String(settings[k].path || '').replace(/\\/g, '/').includes('long-screenshot'));
      if (id) return id;
    } catch {}
    await nodeSleep(1000);
  }
  throw new Error('扩展没有出现在新配置文件的已安装列表里');
}

async function waitForState(cdp, sessionId, timeoutMs = 240000) {
  const started = Date.now();
  let last = null;
  let polls = 0;
  while (Date.now() - started < timeoutMs) {
    const res = await cdp.eval(sessionId, `return await chrome.runtime.sendMessage({ type: 'LS_STATE' });`);
    last = res && res.state;
    if (!last) {
      console.log('  LS_STATE 没有返回内容，重试');
    } else if (last.status !== 'running') {
      if (last.status === 'error' && watcher && watcher.log.length > 1) {
        console.log(`  收尾前的窗口状态 ${JSON.stringify(watcher.log.slice(-3))}`);
      }
      return last;
    } else if (polls % 4 === 0) {
      console.log(`  …${last.phase || ''} ${last.frames} 屏 ${last.percent}%`);
    }
    polls += 1;
    await nodeSleep(1500);
  }
  return { ...(last || {}), timedOut: true };
}

/* ------------------------------------------------------------- shared plumbing */

/** The worker aborts a run when the target tab stops being the visible one, and in a
 *  headless browser there is nobody watching to say what did it. Record every change
 *  of tab/window state while a job runs so a failure comes with a timeline.
 *  Each window carries its own active tab's URL: captureVisibleTab grabs the *window's*
 *  visible tab, so a window whose active tab has no committed URL explains
 *  「Cannot access contents of url ""」 better than any guess about focus. */
let watcher = null;

function watchTab(ctx, tabId, every = 700) {
  const log = [];
  const started = Date.now();
  let previous = null;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    ctx.cdp
      .eval(ctx.popup, `
        const t = await chrome.tabs.get(${tabId}).catch(() => null);
        const w = await chrome.windows.getAll({ populate: true });
        return t ? {
          tabId: t.id, active: t.active, windowId: t.windowId, status: t.status, hidden: t.hidden === true,
          windows: w.map((x) => ({ id: x.id, focused: x.focused, type: x.type, n: (x.tabs || []).length,
            vis: ((x.tabs || []).find((y) => y.active) || {}).url || null }))
        } : { gone: true };
      `)
      .then((now) => {
        const same = previous && JSON.stringify(now) === JSON.stringify(previous);
        if (!same) {
          previous = now;
          log.push({ t: Date.now() - started, ...now });
          console.log(`  标签页状态 +${log[log.length - 1].t}ms ${JSON.stringify(now)}`);
        }
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, every);
  return { log, stop: () => clearInterval(timer) };
}

/** A headless window only treats its frontmost tab as visible, and both
 *  captureVisibleTab's quota and navigator.clipboard silently refuse a document the
 *  browser thinks is hidden — so every stage that needs real rendering or a trusted
 *  click has to pull its own tab to the front first. */
async function ensureVisible(ctx, page, tabId) {
  let state = await ctx.cdp.eval(page, `return [document.visibilityState, document.hasFocus()].join('/');`);
  for (let i = 0; i < 20 && !state.startsWith('visible'); i += 1) {
    await ctx.cdp.eval(ctx.popup, `
      const t = await chrome.tabs.get(${tabId});
      await chrome.tabs.update(${tabId}, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return true;
    `);
    await nodeSleep(500);
    state = await ctx.cdp.eval(page, `return [document.visibilityState, document.hasFocus()].join('/');`);
  }
  return { visible: state.startsWith('visible'), focused: state.endsWith('true'), state };
}

/** Open another copy of a fixture page in its own window and report the tab id the
 *  background uses. A private window matters twice over: captureVisibleTab shoots the
 *  *visible tab of the window*, so a fixture that shares a window with the popup (or
 *  with a tab something else opened) is at the mercy of whoever activates last. */
async function openTab(ctx, url, match, at = 0) {
  const before = await ctx.cdp.eval(ctx.popup, `const l = await chrome.tabs.query({}); return l.map((t) => t.id);`);
  const target = await ctx.cdp.newTarget(url, true);
  const page = await ctx.cdp.attach(target);
  await ctx.cdp.eval(page, `window.scrollTo(0, ${at}); return document.readyState;`);
  await nodeSleep(600);
  const after = await ctx.cdp.eval(ctx.popup, `const l = await chrome.tabs.query({}); return l.map((t) => ({ id: t.id, url: t.url, windowId: t.windowId }));`);
  const fresh = after.filter((t) => !before.includes(t.id) && String(t.url).includes(match));
  if (!fresh.length) throw new Error(`${match} 标签页没有开出来`);
  const tabId = fresh[fresh.length - 1].id;
  const vis = await ensureVisible(ctx, page, tabId);
  if (!vis.visible) console.log(`  夹具窗口始终没有转前台：${vis.state}`);
  const alone = await ctx.cdp.eval(ctx.popup, `
    const t = await chrome.tabs.get(${tabId});
    const list = await chrome.tabs.query({ windowId: t.windowId });
    // The popup is this script's own command channel — closing its tab ends the run.
    for (const x of list) if (x.id !== ${tabId} && x.id !== ${ctx.popupTab}) await chrome.tabs.remove(x.id).catch(() => {});
    return list.length;
  `);
  if (alone > 1) console.log(`  夹具窗口里本来有 ${alone} 个标签页，已只留下夹具`);
  if (watcher) watcher.stop();
  watcher = watchTab(ctx, tabId, 300);
  return { target, page, tabId };
}

async function openFixture(ctx, at = 0) {
  return openTab(ctx, FIXTURE, 'e2e-page', at);
}

async function closeTargets(ctx, list) {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
  for (const targetId of list) {
    try { await ctx.cdp.send('Target.closeTarget', { targetId }); } catch {}
  }
}

const sendStart = (ctx, tabId, options) =>
  ctx.cdp.eval(
    ctx.popup,
    `return await chrome.runtime.sendMessage({ type: 'LS_START', tabId: ${tabId}, options: ${JSON.stringify(options)} });`
  );

/** Downloads are async, and 已导出 only means the queue accepted the job. */
async function newestDownload(ctx, pattern) {
  for (let i = 0; i < 30; i += 1) {
    const items = await ctx.cdp.eval(ctx.popup, `
      const l = await chrome.downloads.search({ limit: 10, orderBy: ['-startTime'] });
      return l.map((i) => ({ file: i.filename, state: i.state, size: i.fileSize }));
    `);
    const hit = items.find((d) => (!pattern || pattern.test(String(d.file))) && d.state === 'complete');
    if (hit) return hit;
    await nodeSleep(1000);
  }
  return null;
}

const imgOf = (file) => {
  const { width, height, rgb } = decodeRgb(file);
  return { width, height, rgb, sig: rowSignatures({ width, height, rgb }, 24) };
};

/* The fixtures paint a ruler the stitched image can be measured against, because a
 * frame placed a few pixels off is invisible to the eye but moves a repeating mark.
 * Along one text-free column: the page fixture flips its alternating section
 * background every 480 px, the container fixture draws a dark card rule every 380 px.
 * Runs (not single flips) are what matter — the page's 3 px section border sits at the
 * *bottom* of a section, so it must not be allowed to end a run early: read dark rows
 * as "whatever was above me", otherwise every other mark lands 3 px before the grid. */
function ruleStarts({ width, height, rgb }, x, mode) {
  const raw = (y) => {
    const d = (y * width + x) * 3;
    const r = rgb[d];
    const g = rgb[d + 1];
    const b = rgb[d + 2];
    return { tint: b - r > 4, dark: r + g + b < 300 };
  };
  const at = (y, carry) => {
    const s = raw(y);
    return mode === 'dark' ? s.dark : s.dark ? carry : s.tint;
  };
  const out = [];
  let runStart = 0;
  let previous = at(0, false);
  for (let y = 1; y <= height; y += 1) {
    const now = y < height ? at(y, previous) : !previous;
    if (now !== previous) {
      if (y - runStart >= 60) out.push(runStart);
      runStart = y;
      previous = now;
    }
  }
  return out;
}

/** Every mark should land on origin + k·pitch. Returns how many were found and the
 *  largest way any sits off that grid, which is exactly the drift a misregistered
 *  frame causes. Marks above `origin` belong to the header/sticky bar, not the ruler. */
function ruleCheck(img, x, pitch, mode, origin) {
  const starts = ruleStarts(img, x, mode).filter((y) => y >= origin);
  const drift = starts.map((y) => y - (origin + Math.round((y - origin) / pitch) * pitch));
  return { marks: starts.length, worst: drift.length ? Math.max(...drift.map(Math.abs)) : 999, at: starts.slice(0, 3) };
}

async function captureStage(ctx) {
  const { cdp, popup } = ctx;
  section('长截图：真实拼接 + 下载');

  const fixture = await openFixture(ctx, 0);
  const geom = await cdp.eval(fixture.page, `
    window.scrollTo(0, 0);
    return Object.assign({
      scrollHeight: document.documentElement.scrollHeight,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      clientWidth: document.documentElement.clientWidth,
      dpr: window.devicePixelRatio,
      title: document.title
    }, window.__FIXTURE__);
  `);
  console.log(`fixture: ${geom.title} · ${geom.scrollHeight} px 高 · 视口 ${geom.viewport.w}×${geom.viewport.h} · 内容宽 ${geom.clientWidth} · dpr ${geom.dpr} · 每节 ${geom.sectionHeight}`);
  check('夹具页面加载成功', geom.scrollHeight > 6000 && geom.title.includes('夹具'), geom);

  const tab = await cdp.eval(popup, `
    const list = await chrome.tabs.query({});
    return list.filter((t) => String(t.url).includes('e2e-page')).map((t) => ({ id: t.id, active: t.active, windowId: t.windowId }));
  `);
  check('夹具标签页可见', tab.some((t) => t.id === fixture.tabId && t.active), tab);
  const build = await cdp.eval(popup, `return await chrome.runtime.sendMessage({ type: 'LS_STATE' });`);
  console.log(`后台 build: ${build.state.build} · 状态 ${build.state.status}`);
  check('后台版本与 manifest 一致', build.state.build === JSON.parse(readFileSync(`${EXT}/manifest.json`, 'utf8')).version, build.state.build);

  const before = Date.now();
  const started = await sendStart(ctx, fixture.tabId, {
    format: 'png', scale: 'device', overlap: 120, waitMs: 120, preload: false, hideFixed: true, dedupe: true
  });
  check('LS_START 接受任务', started && started.ok === true, started);
  ctx.fixture = fixture;

  const state = await waitForState(cdp, popup);
  console.log(`状态: ${state.status} · ${state.frames} 屏 · ${(Date.now() - before) / 1000}s · file=${state.file || '-'}`);
  check('任务成功结束', state.status === 'done' && !state.error, { status: state.status, error: state.error, timedOut: state.timedOut });
  if (state.status !== 'done') console.log(`  运行期间标签页/窗口状态变化 ${Math.max(0, (watcher && watcher.log.length || 1) - 1)} 次`);
  check('拿到真实文件路径', !!state.file && /^[a-zA-Z]:[\\/].+\.png$/.test(state.file), state.file);

  const dl = await newestDownload(ctx);
  console.log('落盘:', dl && `${dl.state} ${dl.size}B ${String(dl.file).split(/[\\/]/).pop()}`);
  check('浏览器记录里下载完成', !!dl && dl.state === 'complete', dl);

  let png = null;
  let file = dl && dl.file;
  try {
    const st = statSync(file);
    png = { size: st.size, ...pngSize(file) };
    console.log(`文件: ${(st.size / 1024 / 1024).toFixed(1)} MB · ${png.width}×${png.height} · colorType=${png.colorType}`);
  } catch (e) {
    check('成品文件在磁盘上', false, String(e.message));
    return { file: null, geom };
  }
  check('成品不是空文件', png.size > 200 * 1024, png);
  // captureVisibleTab paints the content box, so the classic scrollbar is not in it.
  check('宽度等于可视区宽（不含滚动条）', png.width === geom.clientWidth, { png: png.width, clientWidth: geom.clientWidth });
  const drift = png.height - geom.scrollHeight;
  check('总高度贴合文档高度（±一屏）', Math.abs(drift) <= geom.viewport.h, { height: png.height, scroll: geom.scrollHeight, drift });

  const full = imgOf(file);
  const rep = longestRepeat(full.sig, Math.round(geom.viewport.h * 0.6), Math.round(geom.viewport.h * 1.4));
  // Two screens of this fixture really do share rows — the English marker line is the
  // same words 960 px apart — so only a band around one viewport long means the
  // offsets went wrong, not any repeated row at all.
  check('没有整屏重复带（去重生效）', rep.run < geom.viewport.h * 0.5, rep);
  // Blank bands only mean something once they are screen-sized: the fixture leaves
  // ~250 px of whitespace per section, a stuck frame would blank a whole viewport.
  const stuck = longestIdenticalRun(full.sig);
  check('没有整屏空白带', stuck < geom.viewport.h * 0.6, { stuckRows: stuck, viewport: geom.viewport.h });

  const ruler = ruleCheck(full, Math.round(geom.clientWidth * 0.72), 480, 'tint', geom.headerHeight + 480);
  console.log(`分节背景 ${ruler.marks} 条（首条 ${ruler.at[0]}，吸顶栏 ${geom.headerHeight} + 一节 480）· 网格最大偏差 ${ruler.worst} px`);
  check('分节线严格落在 480 px 网格上（逐屏没有错位）', ruler.marks >= 22 && ruler.worst <= 1, ruler);
  check('拼接自报没有空白行', !/空白/.test(state.message || ''), state.message);
  return { file, png, geom, ...full };
}

/* --------------------------------------------------------------- editor glue */

/** The result page reads the shot out of the service worker's memory, so a capture
 *  has to have run first in this same browser session — and it has to be the *whole*
 *  page: a range or region crop from an earlier stage would leave the editor with a
 *  570 px scrap to recognise and annotate. */
async function shotFullPage(ctx) {
  const fixture = await openFixture(ctx, 0);
  const started = await sendStart(ctx, fixture.tabId, {
    format: 'png', scale: 'device', overlap: 120, waitMs: 120, preload: false, hideFixed: true, dedupe: true
  });
  const state = await waitForState(ctx.cdp, ctx.popup);
  check('为编辑器重新截了一次整页', started.ok === true && state.status === 'done' && !state.error, { status: state.status, error: state.error });
  const dl = await newestDownload(ctx);
  if (!dl) throw new Error('整页截图没有落盘，编辑器无从打开');
  const img = imgOf(dl.file);
  await closeTargets(ctx, [fixture.target]);
  return { file: dl.file, png: { width: img.width, height: img.height }, ...img };
}

/** Open the annotation editor on the shot kept in memory. */
async function openEditor(ctx) {
  /* One editor at a time: several of them stacked in the same window is how a later
   * stage ends up clicking a page that is no longer the visible one. */
  if (ctx.editorTarget) {
    await closeTargets(ctx, [ctx.editorTarget]);
    ctx.editorTarget = null;
  }
  const target = await ctx.cdp.newTarget(`chrome-extension://${ctx.id}/edit.html`);
  ctx.editorTarget = target;
  const session = await ctx.cdp.attach(target);
  let last = null;
  for (let i = 0; i < 40; i += 1) {
    /* The scripts at the bottom of edit.html are what declare these, so evaluating
     * too early is a ReferenceError rather than an empty page. */
    last = await ctx.cdp.eval(session, `
      const booted = typeof editors !== 'undefined';
      return { booted, parts: booted ? editors.length : 0, ready: document.readyState, meta: booted ? $('meta').textContent : '' };
    `);
    if (last && last.booted && last.parts > 0) return { session, ready: last };
    await nodeSleep(500);
  }
  /* render() fills #meta before it builds the editors, so a page that got that far
   * but has no editor threw somewhere in between. Reproduce it for the stack. */
  const diag = await ctx.cdp
    .eval(session, `
      try {
        createPart((shot && shot.parts && shot.parts[0]) || {}, 0);
        return { ok: true, parts: editors.length, hasShot: !!shot };
      } catch (err) {
        return { ok: false, err: String((err && (err.stack || err.message)) || err).slice(0, 260) };
      }
    `)
    .catch((err) => ({ ok: false, err: String(err.message).slice(0, 260) }));
  throw new Error(`结果页没有把长图读进来：${JSON.stringify(last)} ${JSON.stringify(diag)}`);
}

/** Where the painted canvas actually is on screen, clamped to the viewport. */
async function canvasBox(cdp, session) {
  return cdp.eval(session, `
    const r = active.figure.querySelector('canvas').getBoundingClientRect();
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    return { x, y, w: Math.min(innerWidth, r.right) - x, h: Math.min(innerHeight, r.bottom) - y, zoom: active.state().zoomLabel };
  `);
}

async function dragRect(cdp, session, box, from, to) {
  const at = (f) => [Math.round(box.x + box.w * f[0]), Math.round(box.y + box.h * f[1])];
  const [x0, y0] = at(from);
  const [x1, y1] = at(to);
  await cdp.mouse(session, 'mousePressed', x0, y0, 1);
  await cdp.mouse(session, 'mouseMoved', Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2), 1);
  await cdp.mouse(session, 'mouseMoved', x1, y1, 1);
  await cdp.mouse(session, 'mouseReleased', x1, y1, 1);
}

async function pick(cdp, session, id) {
  await cdp.eval(session, `document.getElementById('${id}').click(); return true;`);
}

/* ------------------------------------------------------------------- ocr */

async function ocrStage(ctx) {
  section('文字识别：真实 wasm 引擎 + 语言包 + CSP');
  await shotFullPage(ctx);
  const { session } = await openEditor(ctx);
  const box = await canvasBox(ctx.cdp, session);
  check('结果页拿到了可标注的画布', box.w > 60 && box.h > 60, box);

  await ctx.cdp.eval(session, `active.setTool('rect'); return true;`);
  await dragRect(ctx.cdp, session, box, [0.06, 0.08], [0.72, 0.42]);
  const sel = await ctx.cdp.eval(session, `const b = active.ocrRegion(); return { n: active.shapes.length, label: b && b.label, w: b && b.w, h: b && b.h };`);
  check('框住一段正文用于识别', sel.n === 1 && sel.w > 40 && sel.h > 20, sel);

  await pick(ctx.cdp, session, 'ocr');
  const started = Date.now();
  const seen = new Set();
  let fin = null;
  while (Date.now() - started < 200000) {
    const st = await ctx.cdp.eval(session, `return {
      status: $('ocrStatus').textContent,
      scope: $('ocrScope').textContent,
      len: $('ocrText').value.length,
      copyDisabled: $('ocrCopy').disabled
    };`);
    if (st.status && !seen.has(st.status)) {
      seen.add(st.status);
      console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s ${st.status}`);
    }
    if (/置信度|识别失败|没识别到文字/.test(st.status)) { fin = st; break; }
    await nodeSleep(1500);
  }
  const text = await ctx.cdp.eval(session, `return $('ocrText').value;`);
  console.log(`识别用时 ${((Date.now() - started) / 1000).toFixed(1)}s · ${text.length} 字 · ${fin ? fin.scope : '-'}`);
  console.log(`  片段: ${JSON.stringify(text.slice(0, 70))}`);

  check('离线引擎启动并完成识别', !!fin && !/识别失败/.test(fin.status), fin && fin.status);
  check('识别范围用的是选中区域', !!fin && /^选中区域/.test(fin.scope || ''), fin && fin.scope);
  const conf = fin ? Number((/置信度(?:只有)?\s*(\d+)%/.exec(fin.status) || [])[1] || 0) : 0;
  check('置信度达到可用线（≥45）', conf >= 45, { conf, status: fin && fin.status });
  check('认出了夹具里的文字', /夹具|吸顶栏|第\s*0*\d+\s*段|paragraph|marker/.test(text), text.slice(0, 40));
  check('有文字时复制按钮解禁', !!fin && fin.copyDisabled === false, fin);

  await pick(ctx.cdp, session, 'ocrCopy');
  const copied = await ctx.cdp.eval(session, `return $('ocrStatus').textContent;`);
  check('复制文字走剪贴板', /已复制|失败/.test(copied) && !/失败/.test(copied), copied);

  await pick(ctx.cdp, session, 'ocrClose');
  const closed = await ctx.cdp.eval(session, `return { hidden: $('ocrPanel').hidden };`);
  check('关闭面板会释放引擎', closed.hidden === true, closed);
  return { session, text, conf };
}

/* -------------------------------------------------------------- annotate */

async function annotateStage(ctx) {
  section('标注：真实拖拽 + 撤销重做 + 导出文件');
  const reference = await shotFullPage(ctx);
  const { session } = await openEditor(ctx);
  const box = await canvasBox(ctx.cdp, session);
  const blank = await ctx.cdp.eval(session, `return { n: active.shapes.length, undo: active.canUndo, redo: active.canRedo };`);
  check('刚打开时没有任何标注', blank.n === 0 && !blank.undo && !blank.redo, blank);

  await ctx.cdp.eval(session, `active.setTool('rect'); return true;`);
  await dragRect(ctx.cdp, session, box, [0.08, 0.1], [0.5, 0.42]);
  const afterRect = await ctx.cdp.eval(session, `const s = active.shapes[0] || {}; return { n: active.shapes.length, kind: s.kind, w: s.w, h: s.h, color: s.color, undo: active.canUndo };`);
  check('拖出一个矩形并记进历史', afterRect.n === 1 && afterRect.kind === 'rect' && afterRect.w > 40 && afterRect.undo, afterRect);

  await ctx.cdp.eval(session, `active.setTool('arrow'); return true;`);
  await dragRect(ctx.cdp, session, box, [0.56, 0.12], [0.86, 0.36]);
  const afterArrow = await ctx.cdp.eval(session, `const s = active.shapes[1] || {}; return { n: active.shapes.length, kind: s.kind, pts: (s.points || []).length };`);
  check('再画一支箭头', afterArrow.n === 2 && afterArrow.kind === 'arrow' && afterArrow.pts === 2, afterArrow);

  await ctx.cdp.eval(session, `toolbarApi.undo(); return true;`);
  const undone = await ctx.cdp.eval(session, `return { n: active.shapes.length, redo: active.canRedo };`);
  check('撤销回到只剩矩形', undone.n === 1 && undone.redo, undone);
  await ctx.cdp.eval(session, `toolbarApi.redo(); return true;`);
  const redone = await ctx.cdp.eval(session, `return { n: active.shapes.length, redo: active.canRedo };`);
  check('重做找回箭头', redone.n === 2 && !redone.redo, redone);

  await pick(ctx.cdp, session, 'export');
  let note = '';
  for (let i = 0; i < 60; i += 1) {
    note = await ctx.cdp.eval(session, `return $('notice').textContent;`);
    if (/已导出|失败/.test(note)) break;
    await nodeSleep(1000);
  }
  console.log(`导出提示: ${note}`);
  check('导出成功提示出现', /已导出/.test(note), note);

  let anno = null;
  let dl = [];
  for (let i = 0; i < 30 && !anno; i += 1) {
    dl = await ctx.cdp.eval(session, `
      const items = await chrome.downloads.search({ limit: 6, orderBy: ['-startTime'] });
      return items.map((i) => ({ file: i.filename, state: i.state, size: i.fileSize }));
    `);
    anno = dl.find((d) => /-标注-/.test(String(d.file)) && d.state === 'complete');
    if (!anno) await nodeSleep(1000);
  }
  check('浏览器下载的是「-标注-」文件', !!anno && anno.size > 200 * 1024, dl[0]);
  if (!anno) return {};

  const size = pngSize(anno.file);
  if (reference && reference.png) {
    check('标注导出不改变尺寸', size.width === reference.png.width && size.height === reference.png.height, { exported: size, original: reference.png });
  }
  const { rgb } = decodeRgb(anno.file);
  let red = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    if (rgb[i] > 190 && rgb[i + 1] < 110 && rgb[i + 2] < 100) red += 1;
  }
  console.log(`标注文件: ${(anno.size / 1024 / 1024).toFixed(1)} MB · ${size.width}×${size.height} · 红色像素 ${red}`);
  check('导出图里能读到画上去的红色标注', red > 800, red);
  return { file: anno.file };
}

/* ------------------------------------------------------------- range / region */

async function dragBox(cdp, session, box) {
  await cdp.mouse(session, 'mousePressed', box.x0, box.y0, 1);
  await cdp.mouse(session, 'mouseMoved', Math.round((box.x0 + box.x1) / 2), Math.round((box.y0 + box.y1) / 2), 1);
  await cdp.mouse(session, 'mouseMoved', box.x1, box.y0, 1);
  await cdp.mouse(session, 'mouseMoved', box.x1, box.y1, 1);
  await cdp.mouse(session, 'mouseReleased', box.x1, box.y1, 1);
}

async function rangeStage(ctx, full) {
  section('范围标记：只截两次标记之间的那段');
  const { cdp, popup } = ctx;
  const fixture = await openFixture(ctx, 0);

  await cdp.eval(fixture.page, `window.scrollTo(0, 3200); return true;`);
  await nodeSleep(600);
  const a = await cdp.eval(popup, `return await chrome.runtime.sendMessage({ type: 'LS_MARK', tabId: ${fixture.tabId} });`);
  await cdp.eval(fixture.page, `window.scrollTo(0, 8000); return true;`);
  await nodeSleep(600);
  const b = await cdp.eval(popup, `return await chrome.runtime.sendMessage({ type: 'LS_MARK', tabId: ${fixture.tabId} });`);
  console.log(`标记: ${a.scrollY} → ${b.scrollY} px · 视口 ${a.viewport} · 文档 ${a.docHeight}`);
  check('标记读到真实滚动位置', a.ok && b.ok && a.scrollY === 3200 && b.scrollY === 8000, { a, b });

  const range = { start: Math.min(a.scrollY, b.scrollY), end: Math.max(a.scrollY, b.scrollY) };
  await sendStart(ctx, fixture.tabId, {
    format: 'png', scale: 'device', overlap: 120, waitMs: 120, preload: false, hideFixed: true, dedupe: true, range
  });
  const state = await waitForState(cdp, popup);
  check('范围任务成功结束', state.status === 'done' && !state.error, { status: state.status, error: state.error, frames: state.frames });

  const dl = await newestDownload(ctx);
  const size = dl && pngSize(dl.file);
  const span = range.end - range.start;
  const fullHeight = full && full.png && full.png.height;
  console.log(`范围 ${range.start}→${range.end}（${span} px）→ 成品 ${size ? `${size.width}×${size.height}` : '无'}`);
  check('高度正好是范围跨度', !!size && Math.abs(size.height - span) <= 2, { height: size && size.height, span });
  // Only meaningful next to a whole-page shot: a range run must be clearly shorter.
  if (fullHeight) {
    check('没有把整页都截进来', !!size && size.height < fullHeight - 2000, { height: size && size.height, full: fullHeight });
  }
  if (dl && full && full.sig) {
    const crop = imgOf(dl.file);
    const m = rowMatch(crop.sig, full.sig, range.start, 8);
    console.log(`逐行对齐整页图：最佳 offset ${m.offset}（标记 ${range.start}）· 命中 ${(m.ratio * 100).toFixed(1)}%`);
    check('截的确实是那一段', m.ratio > 0.98 && m.offset === range.start, m);
    /* Same ruler as the whole page, shifted by the range start: the marks inside the
     * crop must still land on the 480 grid, which they cannot if the frames inside the
     * range were placed with a different scale than the range offset was. */
    const first = 544 + 480 * Math.ceil((range.start - 544) / 480);
    const ruler = ruleCheck(crop, Math.round(full.width * 0.72), 480, 'tint', first - range.start);
    console.log(`范围内分节线 ${ruler.marks} 条（首条 ${ruler.at[0]}，期望 ${first - range.start}）· 偏差 ${ruler.worst} px`);
    check('范围内的分节线仍在 480 网格上', ruler.marks >= 8 && ruler.worst <= 1 && ruler.at[0] === first - range.start, ruler);
  }
  await closeTargets(ctx, [fixture.target]);
}

async function regionStage(ctx, full) {
  section('框选区域：真实拖拽 + 横向裁切');
  const { cdp, popup } = ctx;
  const geom = await (await openFixture(ctx, 0)).page;
  const cw = await cdp.eval(geom, `return document.documentElement.clientWidth;`);
  /* Two picks: one on a page sitting at the top, one on a page already scrolled 3200 px
   * down. A framed region must reproduce the content it was drawn over at the scroll
   * position it was drawn at — a pass that only ever frames the top of a page cannot see
   * the pre-scroll, the sticky-header row band, or a clamped scroll target.
   * The scrolled box starts below the 64 px sticky header so every sampled row is plain
   * document content and can be pasted back onto the full-page reference. */
  const cases = [
    { name: '页面在顶部', at: 0, box: { x0: Math.round(cw * 0.28), y0: 150, x1: Math.round(cw * 0.74), y1: 560 } },
    { name: '页面已下滚 3200', at: 3200, box: { x0: Math.round(cw * 0.15), y0: 120, x1: Math.round(cw * 0.62), y1: 520 } }
  ];

  for (const one of cases) {
    const fixture = await openFixture(ctx, one.at);
    const scrolled = await cdp.eval(fixture.page, `return document.documentElement.scrollTop;`);
    const box = one.box;
    check(`${one.name}：夹具确实停在 ${one.at} px`, Math.abs(scrolled - one.at) <= 2, scrolled);

    /* LS_REGION resolves only once the user finishes dragging, so fire it and drive the
     * mouse while that promise is in flight. */
    const pending = cdp.eval(popup, `
      return await chrome.runtime.sendMessage({
        type: 'LS_REGION',
        tabId: ${fixture.tabId},
        options: ${JSON.stringify({ format: 'png', scale: 'device', overlap: 120, waitMs: 200, preload: true, dedupe: true })}
      });
    `).catch((err) => ({ error: String(err.message).slice(0, 120) }));
    await nodeSleep(1500);
    const layer = await cdp.eval(fixture.page, `return !!document.querySelector('[data-ls-pick="layer"]');`);
    check(`${one.name}：框选遮罩注入到页面`, layer === true, layer);
    // The overlay must not be able to move the page out from under the selection.
    const held = await cdp.eval(fixture.page, `return document.documentElement.scrollTop;`);
    check(`${one.name}：遮罩打开后页面没有自己滚走`, Math.abs(held - one.at) <= 2, held);

    await dragBox(cdp, fixture.page, box);
    await cdp.key(fixture.page, 'Enter', 'NumpadEnter', 13);
    const res = await Promise.race([pending, nodeSleep(45000).then(() => ({ timedOut: true }))]);
    check(`${one.name}：拖框被接受并转成截图任务`, res && res.ok === true, res);

    const state = await waitForState(cdp, popup);
    check(`${one.name}：区域任务成功结束`, state.status === 'done' && !state.error, { status: state.status, error: state.error, frames: state.frames });
    const dl = await newestDownload(ctx);
    const size = dl && pngSize(dl.file);
    // The band is a fraction of the content box, so the crop is exactly what was drawn.
    console.log(`${one.name}：选框 ${box.x1 - box.x0}×${box.y1 - box.y0} → 成品 ${size ? `${size.width}×${size.height}` : '无'} · ${state.frames} 屏`);
    check(`${one.name}：宽度按比例裁掉了两侧`, !!size && Math.abs(size.width - (box.x1 - box.x0)) <= 2, { width: size && size.width, want: box.x1 - box.x0 });
    check(`${one.name}：高度就是选框那一块`, !!size && Math.abs(size.height - (box.y1 - box.y0)) <= 4, { height: size && size.height, want: box.y1 - box.y0 });
    if (dl && full && full.png) {
      const crop = imgOf(dl.file);
      const m = bestCropMatch(crop, full, box.x0, one.at + box.y0, 6);
      console.log(`${one.name}：贴回整页图 offset (${m.x}, ${m.y}) · 期望 (${box.x0}, ${one.at + box.y0}) · 采样 ${(m.ratio * 100).toFixed(1)}%`);
      check(`${one.name}：区域内容确实来自框住的那一块`, m.ratio > 0.9 && Math.abs(m.y - (one.at + box.y0)) <= 6, { ratio: m.ratio, x: m.x, y: m.y, want: one.at + box.y0 });
    }
    const clean = await cdp.eval(fixture.page, `return { picks: document.querySelectorAll('[data-ls-pick]').length, top: document.documentElement.scrollTop };`);
    check(`${one.name}：框选层已撤掉`, clean.picks === 0, clean);
    await closeTargets(ctx, [fixture.target]);
  }
  await overlayCases(ctx, full);
  await elementCase(ctx, full);
}

/* A box that starts above the sticky header: the capture deliberately keeps the page where
 * it was, so whatever the browser has painted over those rows ends up in the file. This is
 * the 「截到不该在这里的内容」 case — measured instead of argued about. */
async function overlayCases(ctx, full) {
  const { cdp, popup } = ctx;
  const cw = await cdp.eval((await openFixture(ctx, 0)).page, `return document.documentElement.clientWidth;`);
  const fixture = await openFixture(ctx, 3200);
  const box = { x0: Math.round(cw * 0.2), y0: 8, x1: Math.round(cw * 0.7), y1: 408 };
  const pending = cdp.eval(popup, `
    return await chrome.runtime.sendMessage({
      type: 'LS_REGION',
      tabId: ${fixture.tabId},
      options: ${JSON.stringify({ format: 'png', scale: 'device', overlap: 120, waitMs: 200, preload: true, dedupe: true })}
    });
  `).catch((err) => ({ error: String(err.message).slice(0, 120) }));
  await nodeSleep(1500);
  await dragBox(cdp, fixture.page, box);
  await cdp.key(fixture.page, 'Enter', 'NumpadEnter', 13);
  const res = await Promise.race([pending, nodeSleep(45000).then(() => ({ timedOut: true }))]);
  check('跨吸顶栏框选：任务被接受', res && res.ok === true, res);
  const state = await waitForState(cdp, popup);
  check('跨吸顶栏框选：任务成功结束', state.status === 'done' && !state.error, state.error || state.status);
  const dl = await newestDownload(ctx);
  const crop = imgOf(dl.file);
  const want = { y: 3200 + box.y0 };
  const m = bestCropMatch(crop, full, box.x0, want.y, 6);
  // Which rows disagree with the reference long shot, and are they exactly the header band?
  // The region capture keeps the fixed layer on purpose (the popup calls it 「框住什么截什么」),
  // while the long shot hides it, so the only rows allowed to differ are the ones the sticky
  // bar covers. Below it, every row must sit where the page had it.
  const bar = 64;
  const bad = [];
  let below = 0;
  let belowBad = 0;
  let headerRows = 0;
  for (let r = 0; r < crop.height; r += 1) {
    if (want.y + r >= full.height) break;
    let off = 0;
    for (let c = 0; c < crop.width; c += 4) {
      const a = (r * crop.width + c) * 3;
      const b = ((want.y + r) * full.width + box.x0 + c) * 3;
      if (Math.abs(crop.rgb[a] - full.rgb[b]) > 24 || Math.abs(crop.rgb[a + 1] - full.rgb[b + 1]) > 24 || Math.abs(crop.rgb[a + 2] - full.rgb[b + 2]) > 24) off += 1;
    }
    if (r < bar) {
      // #ffe58a is the fixture's sticky bar: those rows have to be the bar itself, not some
      // other part of the page dragged in.
      const a = (r * crop.width + 12) * 3;
      if (crop.rgb[a] > 235 && crop.rgb[a + 1] > 205 && crop.rgb[a + 2] < 180) headerRows += 1;
      if (off > 3) bad.push(r);
    } else {
      below += 1;
      if (off > 3) {
        belowBad += 1;
        bad.push(r);
      }
    }
  }
  console.log(`跨吸顶栏：成品 ${crop.width}×${crop.height} · 贴回 offset (${m.x}, ${m.y}) · 采样 ${(m.ratio * 100).toFixed(1)}%`);
  console.log(`对不上的行 ${bad.length} 条（栏内 ${bad.filter((r) => r < bar).length} · 栏下 ${belowBad}/${below}）· 吸顶栏色带 ${headerRows}/${bar - box.y0} 行`);
  check('跨吸顶栏框选：错位只发生在吸顶栏那几十行', bad.every((r) => r < bar), { rows: bad.length, first: bad[0], last: bad[bad.length - 1] });
  check('跨吸顶栏框选：栏下的内容与整页图逐行对齐', below > 0 && belowBad / below < 0.02 && Math.abs(m.y - want.y) <= 6, { belowBad, below, y: m.y, want: want.y });
  check('跨吸顶栏框选：栏里就是用户框住的那条吸顶栏', headerRows >= bar - box.y0 - 4, { headerRows, inCrop: bar - box.y0 });
  await closeTargets(ctx, [fixture.target]);
}

/* Single click (no drag) means "take this whole element" — the path a real user takes far
 * more often than dragging, and the one the harness had never exercised. */
async function elementCase(ctx, full) {
  const { cdp, popup } = ctx;
  const fixture = await openFixture(ctx, 3200);
  const target = await cdp.eval(fixture.page, `
    const s = document.getElementById('s-08');
    const r = s.getBoundingClientRect();
    // Aim at the section's own padding: the heading and paragraphs sit in the top third,
    // and elementsFromPoint would hand back the inner block instead of the section.
    return { x: Math.round(r.left + 80), y: Math.round(r.top + 400), rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, top: document.documentElement.scrollTop };
  `);
  const pending = cdp.eval(popup, `
    return await chrome.runtime.sendMessage({
      type: 'LS_REGION',
      tabId: ${fixture.tabId},
      options: ${JSON.stringify({ format: 'png', scale: 'device', overlap: 120, waitMs: 200, preload: true, dedupe: true })}
    });
  `).catch((err) => ({ error: String(err.message).slice(0, 120) }));
  await nodeSleep(1500);
  await cdp.mouse(fixture.page, 'mousePressed', target.x, target.y, 1);
  await cdp.mouse(fixture.page, 'mouseReleased', target.x, target.y, 1);
  const shown = await cdp.eval(fixture.page, `
    const b = document.querySelector('[data-ls-pick="band"]');
    const r = b.getBoundingClientRect();
    return { label: document.querySelector('[data-ls-pick="bar"] span').textContent, w: Math.round(r.width), h: Math.round(r.height), t: Math.round(r.top) };
  `);
  await cdp.key(fixture.page, 'Enter', 'NumpadEnter', 13);
  const res = await Promise.race([pending, nodeSleep(45000).then(() => ({ timedOut: true }))]);
  check('单击选中元素：任务被接受', res && res.ok === true, res);
  const state = await waitForState(cdp, popup);
  check('单击选中元素：任务成功结束', state.status === 'done' && !state.error, state.error || state.status);
  const dl = await newestDownload(ctx);
  const crop = imgOf(dl.file);
  console.log(`元素 #s-08 视口位置 (${target.rect.l}, ${target.rect.t}) ${target.rect.w}×${target.rect.h} · 选框标签 ${shown.label} · 成品 ${crop.width}×${crop.height} · 页面停在 ${target.top}`);
  check('单击选中元素：选框就是这个元素', Math.abs(shown.w - target.rect.w) <= 3 && Math.abs(shown.h - target.rect.h) <= 3, { shown, rect: target.rect });
  const wantY = target.top + Math.max(0, target.rect.t);
  const m = bestCropMatch(crop, full, target.rect.l, wantY, 6);
  console.log(`贴回整页图 offset (${m.x}, ${m.y}) · 期望 (${target.rect.l}, ${wantY}) · 采样 ${(m.ratio * 100).toFixed(1)}%`);
  check('单击选中元素：截的就是这个元素', m.ratio > 0.9 && Math.abs(m.y - wantY) <= 6, { ratio: m.ratio, y: m.y, want: wantY });
  await closeTargets(ctx, [fixture.target]);
}

/* ------------------------------------------- container / formats / clipboard */

/* A page whose scroll position is not settled when the shutter opens paints rows that
 * belong somewhere else: the driver reads scrollTop, reports it, and the compositor is
 * still animating toward it. ?anim=1 turns on smooth scrolling plus snap points — the
 * standard setup on docs, chat panes and carousels — and this stage measures both the
 * long capture and a framed region against the reference shot. */
async function animStage(ctx) {
  section('页面自己滚：smooth + snap 不能让截到的内容与上报的偏移脱节');
  const { cdp, popup } = ctx;
  const fixture = await openTab(ctx, `http://127.0.0.1:${WEB_PORT}/e2e-page.html?anim=1`, 'e2e-page');
  const geom = await cdp.eval(fixture.page, `
    const cs = getComputedStyle(document.documentElement);
    const f = window.__FIXTURE__;
    return { pitch: f.sectionHeight, bar: f.headerHeight, sh: document.documentElement.scrollHeight, cw: document.documentElement.clientWidth,
             behavior: cs.scrollBehavior, snap: cs.scrollSnapType };
  `);
  console.log(`夹具 html{scroll-behavior:${geom.behavior}; scroll-snap-type:${geom.snap}} · 文档 ${geom.sh} · 每节 ${geom.pitch}`);
  check('夹具真的开了平滑滚动与吸附', geom.behavior === 'smooth' && /y/.test(geom.snap), geom);

  const started = await sendStart(ctx, fixture.tabId, { format: "png", scale: "device", overlap: 120, waitMs: 500, preload: true, hideFixed: true, dedupe: true });
  check('动画页任务被接受', started && started.ok === true, started);
  const state = await waitForState(cdp, popup);
  check('动画页任务成功结束', state.status === 'done' && !state.error, { status: state.status, error: state.error });
  const dl = await newestDownload(ctx);
  const img = imgOf(dl.file);
  const vh = await cdp.eval(fixture.page, `return innerHeight;`);
  const drift = ruleCheck(img, Math.round(geom.cw * 0.72), geom.pitch, 'tint', geom.bar + geom.pitch);
  const rep = longestRepeat(img.sig, Math.round(vh * 0.6), Math.round(vh * 1.4));
  const stuck = longestIdenticalRun(img.sig);
  console.log(`成品 ${img.width}×${img.height}（期望高 ${geom.sh}）· ${state.frames} 屏 · 分节线 ${drift.marks} 条，最大网格偏差 ${drift.worst} px`);
  console.log(`最长假重复 ${rep.run} px（周期 ${rep.period}，起点 ${rep.start}）· 最长相同行带 ${stuck} px · message="${state.message || ''}"`);
  check('成品高度贴合文档高度（±一屏）', Math.abs(img.height - geom.sh) <= 900, { height: img.height, sh: geom.sh });
  check('分节线仍然落在 480 px 网格上（截屏时刻与偏移一致）', drift.marks >= 22 && drift.worst <= 4, drift);
  check('没有出现整屏重复带（滚动没有回弹）', rep.run < vh * 0.5, rep);
  check('没有出现整屏空白带', stuck < vh * 0.6, { stuck, vh });
  check('拼接自报没有空白行', !/空白/.test(state.message || ''), state.message);

  /* Now the framed region on the same page: the box must reproduce exactly the rows it
   * was drawn over, which only holds if the page is parked where the driver says it is. */
  const at = 3200;
  await cdp.eval(fixture.page, `document.documentElement.scrollTo({ top: ${at}, behavior: 'auto' }); return document.documentElement.scrollTop;`);
  await nodeSleep(1200);
  /* Where the page actually comes to rest is what the box is drawn against: a snap page is
   * allowed to settle on a section edge, and the crop must follow the resting position. */
  const rest0 = await cdp.eval(fixture.page, `return document.documentElement.scrollTop;`);
  const cw = geom.cw;
  const box = { x0: Math.round(cw * 0.2), y0: 120, x1: Math.round(cw * 0.7), y1: 520 };
  const pending = cdp.eval(popup, `
    return await chrome.runtime.sendMessage({
      type: 'LS_REGION',
      tabId: ${fixture.tabId},
      options: ${JSON.stringify({ format: "png", scale: "device", overlap: 120, waitMs: 500, preload: true, dedupe: true })}
    });
  `).catch((err) => ({ error: String(err.message).slice(0, 120) }));
  await nodeSleep(1500);
  const pinned = await cdp.eval(fixture.page, `
    const a = document.documentElement.scrollTop;
    const cs = getComputedStyle(document.documentElement);
    return { top: a, behavior: cs.scrollBehavior, snap: cs.scrollSnapType };
  `);
  await nodeSleep(600);
  const still = await cdp.eval(fixture.page, `return document.documentElement.scrollTop;`);
  console.log(`页面停在 ${rest0} → 遮罩打开后 ${pinned.top}（behavior:${pinned.behavior} snap:${pinned.snap}）· 0.6s 后 ${still}`);
  check('遮罩打开后页面不能再自己动', pinned.behavior === 'auto' && !/y/.test(pinned.snap) && Math.abs(still - pinned.top) <= 1, pinned);
  await dragBox(cdp, fixture.page, box);
  await cdp.key(fixture.page, 'Enter', 'NumpadEnter', 13);
  const res = await Promise.race([pending, nodeSleep(45000).then(() => ({ timedOut: true }))]);
  check('动画页框选：任务被接受', res && res.ok === true, res);
  const rs = await waitForState(cdp, popup);
  check('动画页框选：任务成功结束', rs.status === 'done' && !rs.error, rs.error || rs.status);
  const regionDl = await newestDownload(ctx);
  const crop = imgOf(regionDl.file);
  const want = { x: box.x0, y: pinned.top + box.y0 };
  const m = bestCropMatch(crop, img, want.x, want.y, 8);
  console.log(`动画页框选：选框 ${box.x1 - box.x0}×${box.y1 - box.y0} → 成品 ${crop.width}×${crop.height} · 贴回 offset (${m.x}, ${m.y}) · 期望 (${want.x}, ${want.y}) · 采样 ${(m.ratio * 100).toFixed(1)}%`);
  check('动画页框选：内容就是框住的那一段', m.ratio > 0.9 && Math.abs(m.y - want.y) <= 8, { ratio: m.ratio, y: m.y, want: want.y });
  await closeTargets(ctx, [fixture.target]);
}

/* The container variant of a framed region: the box lives inside #feed (180 px from the
 * window edge), the page is already scrolled, and a sticky bar covers the first 48 rows of
 * the scroll box. This is the shape of a real admin/chat page, and the case where a region
 * capture can silently return the rows around the selection instead of the selection. */
async function containerRegionCase(ctx) {
  section('容器里框选：滚动条、侧栏与吸顶栏都不许混进选框');
  const { cdp, popup } = ctx;
  const fixture = await openTab(ctx, `http://127.0.0.1:${WEB_PORT}/container-page.html`, 'container-page');
  const geom = await cdp.eval(fixture.page, `
    const feed = document.getElementById('feed');
    const r = feed.getBoundingClientRect();
    return { cw: feed.clientWidth, ch: feed.clientHeight, sh: feed.scrollHeight, left: Math.round(r.left), top: Math.round(r.top), card: window.__FIXTURE__.card, bar: window.__FIXTURE__.topbar };
  `);
  // Reference: the whole scroll box, sticky bar hidden, so every row is plain content.
  const started = await sendStart(ctx, fixture.tabId, { format: 'png', scale: 'device', overlap: 120, waitMs: 120, preload: false, hideFixed: true, dedupe: true });
  check('容器整页参考图任务被接受', started && started.ok === true, started);
  const refState = await waitForState(cdp, popup);
  check('容器整页参考图成功', refState.status === 'done' && !refState.error, refState.error || refState.status);
  const refDl = await newestDownload(ctx);
  const full = imgOf(refDl.file);
  console.log(`参考图 ${full.width}×${full.height} · 容器 ${geom.cw}×${geom.ch} 内容 ${geom.sh} 距窗口 (${geom.left}, ${geom.top})`);

  const at = 1500;
  await cdp.eval(fixture.page, `const f = document.getElementById('feed'); f.scrollTop = ${at}; return f.scrollTop;`);
  await nodeSleep(600);
  const box = { x0: geom.left + 200, y0: geom.top + 20, x1: geom.left + 700, y1: geom.top + 420 };
  const pending = cdp.eval(popup, `
    return await chrome.runtime.sendMessage({
      type: 'LS_REGION',
      tabId: ${fixture.tabId},
      options: ${JSON.stringify({ format: 'png', scale: 'device', overlap: 120, waitMs: 200, preload: true, dedupe: true })}
    });
  `).catch((err) => ({ error: String(err.message).slice(0, 120) }));
  await nodeSleep(1500);
  const held = await cdp.eval(fixture.page, `return document.getElementById('feed').scrollTop;`);
  check('容器：遮罩打开后没有把选框滚走', Math.abs(held - at) <= 2, held);
  await dragBox(cdp, fixture.page, box);
  await cdp.key(fixture.page, 'Enter', 'NumpadEnter', 13);
  const res = await Promise.race([pending, nodeSleep(45000).then(() => ({ timedOut: true }))]);
  check('容器框选：任务被接受', res && res.ok === true, res);
  const state = await waitForState(cdp, popup);
  check('容器框选：任务成功结束', state.status === 'done' && !state.error, state.error || state.status);
  const regionDl = await newestDownload(ctx);
  check('容器框选：写出的是新文件而不是参考图', regionDl && regionDl.file !== refDl.file, { region: regionDl && regionDl.file, ref: refDl.file });
  const crop = imgOf(regionDl.file);
  // The box is viewport-relative; the crop maps onto the reference at the same content rows.
  const want = { x: 200, y: at + 20 };
  const m = bestCropMatch(crop, full, want.x, want.y, 8);
  const bad = [];
  for (let r = 0; r < crop.height; r += 1) {
    if (want.y + r >= full.height) break;
    let off = 0;
    for (let c = 0; c < crop.width; c += 4) {
      const a = (r * crop.width + c) * 3;
      const b = ((want.y + r) * full.width + want.x + c) * 3;
      if (Math.abs(crop.rgb[a] - full.rgb[b]) > 24 || Math.abs(crop.rgb[a + 1] - full.rgb[b + 1]) > 24 || Math.abs(crop.rgb[a + 2] - full.rgb[b + 2]) > 24) off += 1;
    }
    if (off > 3) bad.push(r);
  }
  console.log(`容器框选：选框 ${box.x1 - box.x0}×${box.y1 - box.y0} → 成品 ${crop.width}×${crop.height} · 贴回 offset (${m.x}, ${m.y}) · 期望 (${want.x}, ${want.y}) · 采样 ${(m.ratio * 100).toFixed(1)}%`);
  console.log(`对不上的行 ${bad.length} 条：${bad.length ? `${bad[0]}…${bad[bad.length - 1]}` : '无'} · 吸顶栏占容器 0–${geom.bar} px`);
  check('容器框选：成品尺寸就是选框', Math.abs(crop.width - (box.x1 - box.x0)) <= 2 && Math.abs(crop.height - (box.y1 - box.y0)) <= 4, { crop: { w: crop.width, h: crop.height }, want: { w: box.x1 - box.x0, h: box.y1 - box.y0 } });
  check('容器框选：内容落在选框对应的那一段', Math.abs(m.y - want.y) <= 6 && m.ratio > 0.9, { ratio: m.ratio, y: m.y, want: want.y });
  check('容器框选：错位只在吸顶栏覆盖的行里', bad.length === 0 || bad.every((r) => r < geom.bar - 20), { rows: bad.length, first: bad[0], last: bad[bad.length - 1] });
  await closeTargets(ctx, [fixture.target]);
}

async function containerStage(ctx) {
  section('容器滚动页：只截内部滚动区，侧栏与它自己的滚动条都不进图');
  const { cdp, popup } = ctx;
  const fixture = await openTab(ctx, `http://127.0.0.1:${WEB_PORT}/container-page.html`, 'container-page');
  const geom = await cdp.eval(fixture.page, `
    const feed = document.getElementById('feed');
    const r = feed.getBoundingClientRect();
    return Object.assign({
      cw: feed.clientWidth, ch: feed.clientHeight, sh: feed.scrollHeight,
      left: Math.round(r.left), top: Math.round(r.top), winW: innerWidth, winH: innerHeight, dpr: devicePixelRatio
    }, window.__FIXTURE__);
  `);
  console.log(`容器 ${geom.cw}×${geom.ch} 视口 · 内容高 ${geom.sh} · 距窗口 (${geom.left}, ${geom.top}) · 窗口 ${geom.winW}×${geom.winH} · dpr ${geom.dpr}`);
  check('夹具确实是容器内滚动', geom.sh > geom.ch * 4 && geom.left > 100 && geom.top === 0, geom);

  const started = await sendStart(ctx, fixture.tabId, {
    format: 'png', scale: 'device', overlap: 120, waitMs: 120, preload: false, hideFixed: true, dedupe: process.env.LS_DEDUPE !== '0'
  });
  check('容器任务被接受', started && started.ok === true, started);
  const state = await waitForState(cdp, popup);
  check('容器任务成功结束', state.status === 'done' && !state.error, { status: state.status, error: state.error, frames: state.frames });
  check('拼接自报没有空白行', !/空白/.test(state.message || ''), state.message);
  console.log(`驱动侧 ${state.frames} 屏 · 覆盖 ${state.percent}% · message="${state.message || ''}"`);
  /* `window.__LS__` lives in the extension's isolated world, so reading it from the page's
   * main world always yields undefined — that error was the harness, not the product. Inject
   * the read exactly the way the driver itself does. */
  const diag = await cdp.eval(popup, `
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: ${fixture.tabId} },
      world: 'ISOLATED',
      func: () => {
        const LS = window.__LS__;
        const feed = document.getElementById('feed');
        const marked = document.querySelector('[data-ls-root]');
        let picked;
        if (!LS) picked = { err: 'isolated world 里没有 __LS__' };
        else {
          const n = LS.findRoot();
          picked = { tag: n.tagName, id: n.id, sh: n.scrollHeight, ch: n.clientHeight };
        }
        return {
          feed: feed ? { sh: feed.scrollHeight, ch: feed.clientHeight, top: feed.scrollTop } : null,
          doc: { sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight },
          marked: marked ? marked.tagName + '#' + marked.id : null,
          picked,
          state: LS && LS.state ? { y: LS.state.y, origin: LS.state.origin, limit: LS.state.limit } : null
        };
      }
    });
    return r && r.result;
  `);
  console.log(`诊断 ${JSON.stringify(diag)}`);

  const dl = await newestDownload(ctx, /Container/);
  const size = dl && pngSize(dl.file);
  console.log(`成品 ${size ? `${size.width}×${size.height}` : '无'}（期望 ${geom.cw}×${geom.sh}）`);
  check('宽度是容器内容宽', !!size && size.width === geom.cw, { width: size && size.width, cw: geom.cw });
  check('高度是容器内容高（±一屏）', !!size && Math.abs(size.height - geom.sh) <= geom.ch, { height: size && size.height, sh: geom.sh });
  if (dl) {
    const img = imgOf(dl.file);
    // The rules are 3 px dark lines at the bottom of each card; the sticky bar above
    // the first one is not part of the grid.
    const ruler = ruleCheck(img, Math.round(geom.cw * 0.7), geom.card, 'dark', geom.topbar + geom.card);
    console.log(`卡片分界线 ${ruler.marks} 条（首条 ${ruler.at[0]}，期望 ${geom.topbar + geom.card}）· 网格最大偏差 ${ruler.worst} px`);
    check('卡片线严格落在 380 px 网格上（容器图不再被压扁）', ruler.marks >= 15 && ruler.worst <= 1, ruler);
    check('侧栏没有混进图里', sideIsClean(img, geom), { leftColumn: leftSample(img) });
  }
  await closeTargets(ctx, [fixture.target]);
}

/** The nav rail is #eee; the feed's own cards never paint that grey at x 0. */
function sideIsClean(img, geom) {
  const at = (y) => {
    const d = (y * img.width + 4) * 3;
    return [img.rgb[d], img.rgb[d + 1], img.rgb[d + 2]].join(',');
  };
  const seen = new Set();
  for (let y = 0; y < img.height; y += 37) seen.add(at(y));
  return !seen.has('238,238,238');
}

function leftSample(img) {
  const out = [];
  for (let y = 0; y < img.height && out.length < 4; y += 37) {
    const d = (y * img.width + 4) * 3;
    out.push([img.rgb[d], img.rgb[d + 1], img.rgb[d + 2]].join(','));
  }
  return out;
}

async function formatStage(ctx) {
  section('JPEG 与清晰度档位：2× 输出各向等比');
  const { cdp, popup } = ctx;
  /* Baseline first: the same page at 1× PNG, measured the same way, so the size
   * comparison below is a ratio and not a threshold someone guessed. */
  const baseline = await shotFullPage(ctx);
  const fixture = await openTab(ctx, FIXTURE, 'e2e-page');
  const geom = await cdp.eval(fixture.page, `
    window.scrollTo(0, 0);
    return { cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, dpr: devicePixelRatio };
  `);
  const started = await sendStart(ctx, fixture.tabId, {
    format: 'jpeg', quality: 0.8, scale: '2', overlap: 120, waitMs: 120, preload: false, hideFixed: true, dedupe: true
  });
  check('2× JPEG 任务被接受', started && started.ok === true, started);
  const state = await waitForState(cdp, popup);
  check('任务成功结束', state.status === 'done' && !state.error, { status: state.status, error: state.error });
  const dl = await newestDownload(ctx, /\.jpg$/);
  console.log(`落盘: ${dl && String(dl.file).split(/[\\/]/).pop()} · ${dl && (dl.size / 1024 / 1024).toFixed(2)} MB`);
  check('下载的是 .jpg', !!dl && /\.jpg$/.test(dl.file), dl && dl.file);
  if (dl) {
    const size = jpegSize(dl.file);
    console.log(`成品 ${size.width}×${size.height} · 期望 ${geom.cw * 2}×${geom.sh * 2}（dpr ${geom.dpr}）`);
    check('宽度 = 内容宽 × 2', size.width === geom.cw * 2, { width: size.width, want: geom.cw * 2 });
    check('高度 = 文档高 × 2（纵向没有被横向比例压缩）', Math.abs(size.height - geom.sh * 2) <= 2, { height: size.height, want: geom.sh * 2 });
    const mpx = (w, h) => (w * h) / 1e6;
    const pngBytes = statSync(baseline.file).size;
    const jpgPer = dl.size / mpx(size.width, size.height);
    const pngPer = pngBytes / mpx(baseline.width, baseline.height);
    console.log(`体积：JPEG 2× ${(dl.size / 1024 / 1024).toFixed(2)} MB · PNG 1× ${(pngBytes / 1024 / 1024).toFixed(2)} MB · 每百万像素 ${(jpgPer / 1024).toFixed(0)} KB vs ${(pngPer / 1024).toFixed(0)} KB`);
    /* On a flat white page PNG's lossless deflate beats JPEG per pixel, so the claim
     * worth testing is the one a user cares about: four times the pixels for well under
     * twice the bytes means the 2× tier is still worth sharing. */
    check('2× JPEG 的体积不到 1× PNG 的两倍', dl.size < pngBytes * 2, { jpg: dl.size, png: pngBytes });
  }
  await closeTargets(ctx, [fixture.target]);
}

/** navigator.clipboard only accepts a write from a page that is foreground with
 *  user activation, so the click has to come through CDP and the proof has to come
 *  from outside the browser: the Windows clipboard itself. */
async function clipboardStage(ctx) {
  section('复制到剪贴板：真实点击 + 系统剪贴板读回');
  const reference = await shotFullPage(ctx);
  const me = await ctx.cdp.eval(ctx.popup, `
    const t = await chrome.tabs.getCurrent();
    return t ? { id: t.id, windowId: t.windowId, active: t.active } : null;
  `);
  check('弹窗自己找到了标签页', !!me, me);
  /* The copy button needs two things a hidden tab cannot give it: the trusted click has
   * to land on a rendered page, and clipboard.write is gated on the document being the
   * frontmost one. Bring the popup's own window forward, then prove the click arrived. */
  const front = await ensureVisible(ctx, ctx.popup, me ? me.id : ctx.popupTab);
  console.log(`弹窗可见性: ${front.state}`);
  check('弹窗在前台', front.visible, front);
  await ctx.cdp.eval(ctx.popup, `
    window.__clicks = [];
    const path = (e) => { const a = []; for (let n = e; n && n !== document.body; n = n.parentElement) a.push(n.id ? '#' + n.id : n.tagName.toLowerCase()); return a.join('<'); };
    document.addEventListener('click', (e) => window.__clicks.push({ at: [e.clientX, e.clientY], isTrusted: e.isTrusted, to: path(e.target) }), true);
    document.getElementById('copy').scrollIntoView({ block: 'center' });
    return 1;`);
  const button = await ctx.cdp.eval(ctx.popup, `
    const b = document.getElementById('copy');
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    const path = (e) => { const a = []; for (let n = e; n && n !== document.body; n = n.parentElement) a.push(n.id ? '#' + n.id : n.tagName.toLowerCase()); return a.join('<'); };
    return {
      disabled: b.disabled,
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
      inView: r.top >= 0 && r.bottom <= innerHeight && r.width > 0,
      card: path(b), under: path(hit), text: b.textContent.trim()
    };
  `);
  console.log(`按钮几何 ${JSON.stringify(button)}`);
  check('复制按钮可用', button.disabled === false, button);
  check('按钮在弹窗可视区内', button.inView, button);

  const clipFile = `${process.env.TEMP || 'C:/Users/80495/AppData/Local/Temp'}/ls-clipboard.png`.replace(/\\/g, '/');
  /* A stale PNG from a previous run reads exactly like a successful copy, so the file has
   * to be gone before the click and only ever written by this stage's PowerShell. */
  try { rmSync(clipFile); } catch { /* nothing there yet */ }
  /* What the product hands the clipboard API is measurable in the page itself. That is the
   * primary proof: --headless=new replaces the OS clipboard with an in-process stub, so
   * clipboard.write resolves happily while Windows never sees a bitmap — reading the system
   * clipboard back there measures Chrome's flag, not the extension. */
  const armed = await ctx.cdp.eval(ctx.popup, `
    window.__clip = null;
    const orig = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = async (items) => {
      const seen = [];
      for (const item of items) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          let dim = null;
          try {
            const bmp = await createImageBitmap(blob);
            dim = [bmp.width, bmp.height];
            bmp.close();
          } catch (e) { dim = 'undecodable'; }
          seen.push({ type, size: blob.size, dim });
        }
      }
      window.__clip = seen;
      return orig(items);
    };
    return true;
  `);
  check('拦下了剪贴板写入', armed === true, armed);
  await nodeSleep(400);
  await ctx.cdp.mouse(ctx.popup, 'mousePressed', button.x, button.y, 1);
  await ctx.cdp.mouse(ctx.popup, 'mouseReleased', button.x, button.y, 0);
  const landed = await ctx.cdp.eval(ctx.popup, `return window.__clicks;`);
  console.log(`落点 ${JSON.stringify(landed)}`);
  check('点击确实落在了复制按钮上', landed.some((c) => /#copy/.test(c.to) && c.isTrusted), landed);
  let hint = '';
  for (let i = 0; i < 12; i += 1) {
    hint = await ctx.cdp.eval(ctx.popup, `return document.getElementById('shotHint').textContent;`);
    if (/已复制|失败|剪贴板/.test(hint)) break;
    await nodeSleep(500);
  }
  console.log(`弹窗提示: ${hint}`);
  check('弹窗报告已复制', /已复制/.test(hint), hint);
  const handed = await ctx.cdp.eval(ctx.popup, `return window.__clip;`);
  console.log(`交给剪贴板 API 的内容 ${JSON.stringify(handed)}`);
  const png = (handed || []).find((x) => x.type === 'image/png');
  check('写入的是 PNG 而不是 URL', !!png, handed);
  check(
    'PNG 的尺寸就是这张长图',
    !!png && Array.isArray(png.dim) && png.dim[0] === reference.width && png.dim[1] === reference.height,
    { clip: png && png.dim, shot: `${reference.width}x${reference.height}` }
  );
  check('PNG 不是空壳', !!png && png.size > 50 * 1024, png && png.size);

  await nodeSleep(800);
  if (!ctx.headless) {
    /* Read the clipboard the way a user's paste target does: enumerate the formats first,
     * because 「提示已复制但剪贴板是空的」 has two very different causes — Chrome wrote
     * nothing, or it wrote a format .NET's GetImage() does not look for. */
    const ps = "Add-Type -AssemblyName System.Windows.Forms; $d=[System.Windows.Forms.Clipboard]::GetDataObject(); "
      + "if(-not $d){'NO-DATA-OBJECT'}else{Write-Output ('FORMATS: ' + (($d.GetFormats()) -join ',')); "
      + "$i=[System.Windows.Forms.Clipboard]::GetImage(); "
      + `if($i){$i.Save('${clipFile}'); Write-Output ('IMAGE ' + $i.Width + 'x' + $i.Height)}else{'NO-IMAGE'}}`;
    const { execFileSync } = await import('node:child_process');
    let clip = '';
    try {
      clip = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    } catch (err) {
      clip = `error ${String(err.message).slice(0, 80)}`;
    }
    console.log(`系统剪贴板: ${clip.replace(/\r/g, ' | ')}`);
    check('剪贴板里确实有一张图', /IMAGE \d+x\d+/.test(clip), clip);
    try {
      const size = pngSize(clipFile);
      console.log(`剪贴板图片: ${size.width}×${size.height} · 截图 ${reference.width}×${reference.height}`);
      check('剪贴板图片就是这次截图的尺寸', size.width === reference.width && size.height === reference.height, { clip: size, shot: { width: reference.width, height: reference.height } });
    } catch (err) {
      check('剪贴板图片存成文件可读', false, String(err.message).slice(0, 120));
    }
  } else {
    console.log('无头模式跳过系统剪贴板读回：headless=new 的剪贴板是进程内的桩，Windows 收不到写入');
  }
}

/* ------------------------------------------------------------- cancel / stale */

async function cancelStage(ctx) {
  section('中途停止：状态复位、页面复原');
  const { cdp, popup } = ctx;
  const fixture = await openFixture(ctx, 0);
  const started = await sendStart(ctx, fixture.tabId, {
    format: 'png', scale: 'device', overlap: 120, waitMs: 800, preload: false, hideFixed: true, dedupe: true
  });
  check('任务开始', started && started.ok === true, started);

  let mid = null;
  for (let i = 0; i < 24; i += 1) {
    mid = await cdp.eval(popup, `return (await chrome.runtime.sendMessage({ type: 'LS_STATE' })).state;`);
    if (mid && mid.frames >= 3) break;
    await nodeSleep(500);
  }
  check('已经在逐屏截图', !!mid && mid.status === 'running' && mid.frames >= 3, { status: mid && mid.status, frames: mid && mid.frames });
  const during = await cdp.eval(fixture.page, `return { hidden: document.querySelectorAll('[data-ls-hide]').length, style: !!document.getElementById('__ls_style') };`);
  check('截图期间确实动过页面', during.hidden > 0 && during.style, during);

  const stopped = await cdp.eval(popup, `return await chrome.runtime.sendMessage({ type: 'LS_STOP' });`);
  const state = await waitForState(cdp, popup);
  console.log(`停止回执 ${JSON.stringify(stopped)} → 状态 ${state.status} · ${state.phase}`);
  check('停止后回到 idle 且没有报错', state.status === 'idle' && !state.error, { status: state.status, phase: state.phase, error: state.error });

  const after = await cdp.eval(fixture.page, `
    return {
      hidden: document.querySelectorAll('[data-ls-hide]').length,
      style: !!document.getElementById('__ls_style'),
      root: !!document.querySelector('[data-ls-root]'),
      behavior: document.documentElement.style.scrollBehavior
    };
  `);
  check('页面被还原（无残留样式与隐藏标记）', after.hidden === 0 && !after.style && !after.root && !after.behavior, after);
  await closeTargets(ctx, [fixture.target]);
}

/** Last stage: it throws away the in-memory result on purpose. */
async function staleStage(ctx) {
  section('后台被回收后：结果页给兜底提示');
  /* Edge ships its own extension service workers, so only the one from this id counts:
   * killing the wrong worker leaves the in-memory shot alive. */
  const sw = (await ctx.cdp.targets()).find((t) => t.type === 'service_worker' && t.url.includes(ctx.id));
  if (sw) {
    try { await ctx.cdp.send('Target.closeTarget', { targetId: sw.targetId }); } catch (err) { console.log(`关闭 worker: ${err.message}`); }
  }
  await nodeSleep(1500);

  const target = await ctx.cdp.newTarget(`chrome-extension://${ctx.id}/edit.html`);
  const session = await ctx.cdp.attach(target);
  let view = null;
  for (let i = 0; i < 20; i += 1) {
    view = await ctx.cdp.eval(session, `
      if (typeof editors === 'undefined') return null;
      return {
        editors: editors.length,
        shot: shot ? '有' : '无',
        notice: $('notice').textContent,
        shown: !$('notice').hidden,
        bad: $('notice').classList.contains('bad'),
        exportDisabled: $('export').disabled,
        toolbarHidden: $('toolbar').hidden,
        meta: $('meta').textContent
      };
    `);
    if (view && view.shot) break;
    await nodeSleep(500);
  }
  console.log(`结果页: shot=${view && view.shot} · editors=${view && view.editors} · meta="${view && view.meta}"`);
  check('认出内存里没有结果', !!view && view.shot === '无' && view.editors === 0, view);
  check('给出「后台脚本已经重启」而不是白屏', !!view && view.shown && /后台脚本已经重启/.test(view.notice) && view.bad, view && view.notice);
  check('按钮保持禁用，不让人对着空页面操作', !!view && view.exportDisabled === true && view.toolbarHidden === true, view);
  await closeTargets(ctx, [target]);
}

/** The dedupe decides what is a repeated screen, so its margin has to be measured on the
 *  frames the product actually receives — not on a reconstruction from the finished image.
 *  Attaching to the offscreen document mid-run reads the live buffer and reports, per
 *  adjacent pair, how many of its 512 row means moved. A page that scrolled must stay far
 *  away from the merge threshold, and the distance is the number worth watching. */
async function dedupeStage(ctx) {
  section('去重判据：离屏文档里相邻帧的真实行差');
  const { cdp } = ctx;
  const fixture = await openTab(ctx, `http://127.0.0.1:${WEB_PORT}/container-page.html`, 'container-page');
  const started = await sendStart(ctx, fixture.tabId, {
    format: 'png', scale: 'device', overlap: 120, waitMs: 700, preload: false, hideFixed: true, dedupe: true
  });
  check('容器任务被接受', started && started.ok === true, started);

  let off = null;
  let snap = null;
  for (let i = 0; i < 80; i += 1) {
    if (!off) {
      const t = (await cdp.targets()).find((x) => /offscreen\.html/.test(String(x.url || '')));
      if (t) off = await cdp.attach(t.targetId).catch(() => null);
      if (!off) {
        await nodeSleep(200);
        continue;
      }
    }
    snap = await cdp
      .eval(off, `
        const fr = (typeof state === 'undefined' || !state) ? [] : state.frames;
        const prof = [];
        for (const f of fr) {
          const bmp = await decode(f.dataUrl);
          const winW = (f.frame && f.frame.winW) || bmp.width;
          const left = (f.frame && f.frame.left) || 0;
          const s = sliceOf(bmp, f.frame, Math.max(1, winW - left - 15), f.viewportCss, null);
          const rows = Math.min(PROFILE_ROWS, s.sh);
          const c = document.createElement('canvas');
          c.width = 8; c.height = rows;
          const x = c.getContext('2d');
          x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
          x.drawImage(bmp, s.sx, s.sy, s.sw, s.sh, 0, 0, 8, rows);
          bmp.close();
          const px = x.getImageData(0, 0, 8, rows).data;
          const p = new Array(rows);
          for (let r = 0; r < rows; r++) {
            let q = 0;
            for (let k = 0; k < 8; k++) { const i2 = (r * 8 + k) * 4; q += px[i2] * 0.299 + px[i2 + 1] * 0.587 + px[i2 + 2] * 0.114; }
            p[r] = q / 8;
          }
          prof.push({ y: f.offsetY, p, len: f.dataUrl.length });
        }
        const pairs = [];
        for (let i = 1; i < prof.length; i++) {
          const a = prof[i - 1].p, b = prof[i].p;
          const at = (t) => { let n = 0; for (let r = 0; r < a.length; r++) if (Math.abs(a[r] - b[r]) > t) n++; return n; };
          let worst = 0;
          for (let r = 0; r < a.length; r++) worst = Math.max(worst, Math.abs(a[r] - b[r]));
          pairs.push({ from: prof[i - 1].y, to: prof[i].y, rows: a.length, sameBytes: prof[i - 1].len === prof[i].len && worst === 0, d0: at(0.02), d4: at(4), d8: at(8), d18: at(18), worst: Math.round(worst) });
        }
        return { frames: prof.length, pairs };
      `)
      .catch(() => null);
    if (snap && snap.frames >= 6) break;
    await nodeSleep(200);
  }

  check('在离屏文档里读到了正在缓冲的帧', !!snap && snap.frames >= 6, snap && snap.frames);
  if (snap) {
    console.log(`相邻帧的行差（${snap.frames} 屏，阈值：差 ≤2 行才算重复）`);
    for (const p of snap.pairs) {
      console.log(
        `  ${String(p.from).padStart(5)} → ${String(p.to).padStart(5)} · 行数 ${p.rows} · >0.02 ${String(p.d0).padStart(3)} · >4 ${String(p.d4).padStart(3)} · >8 ${String(p.d8).padStart(3)} · >18 ${String(p.d18).padStart(3)} · 最大行差 ${p.worst} · ${p.sameBytes ? '字节相同' : '字节不同'}`
      );
    }
    const minDiff = Math.min(...snap.pairs.map((p) => p.d8));
    const identical = snap.pairs.filter((p) => p.sameBytes).length;
    console.log(`最小 d8 = ${minDiff} 行 · 完全相同的相邻帧 ${identical} 对`);
    check('真滚动的页面离合并线很远（d8 > 2 的两倍）', minDiff > 4, { minDiff });
    check('容器夹具里没有字节相同的相邻帧', identical === 0, identical);
  }
  const done = await waitForState(cdp, ctx.popup);
  console.log(`这一趟 ${done.frames} 屏 · message="${done.message || ''}"`);
  check('真实帧面前没有一屏被去重吃掉', !/合并/.test(done.message || ''), done.message);
  await closeTargets(ctx, [fixture.target]);
}

const ctx = await up();
let result = {};
try {
  // The later stages work on files and shots produced in this same browser session.
  result = await captureStage(ctx);
  if (/range|all/.test(STAGES)) await rangeStage(ctx, result);
  if (/anim|all/.test(STAGES)) await animStage(ctx);
  if (/region|all/.test(STAGES)) await regionStage(ctx, result);
  if (/container|all/.test(STAGES)) await containerStage(ctx);
  if (/container-region|all/.test(STAGES)) await containerRegionCase(ctx);
  if (/dedupe|all/.test(STAGES)) await dedupeStage(ctx);
  if (/jpeg|all/.test(STAGES)) await formatStage(ctx);
  if (/ocr|all/.test(STAGES)) await ocrStage(ctx);
  if (/annotate|all/.test(STAGES)) await annotateStage(ctx);
  if (/clipboard|all/.test(STAGES)) await clipboardStage(ctx);
  if (/cancel|all/.test(STAGES)) await cancelStage(ctx);
  if (/stale|all/.test(STAGES)) await staleStage(ctx);
} catch (err) {
  console.log(`\n阶段抛出异常：${(err && err.stack) || err}`);
  bad += 1;
} finally {
  console.log(bad ? `\n${bad} check(s) failed` : '\nbrowser checks passed');
  await shutdown(ctx);
  process.exit(bad ? 1 : 0);
}
