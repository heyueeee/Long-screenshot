/* Long Shot — background service worker.
 * Owns the capture job: inject a scroll driver, grab the visible tab once per
 * scroll step, then hand the frames (tagged with their absolute scroll offset)
 * to the offscreen document, which stitches them by offset and downloads.
 */

const MAX_FRAMES = 400;
const SAVE_DIR = 'LongShot/';
const BLOCKED_URL = /^(chrome|edge|about|devtools|chrome-extension|moz-extension)/;
/* Kept in step with the manifest version: the popup compares it against the value
 * this worker reports, so a service worker that survived an extension reload shows
 * up as a mismatch instead of a mystery bug. */
const BUILD = '1.5.6';

const DOWNLOAD_ERROR = {
  FILE_FAILED: '浏览器拒绝写入该文件',
  FILE_TOO_LARGE: '文件超出浏览器的下载大小限制，建议改用 JPEG 或降低清晰度',
  FILE_TOO_LONG: '文件名过长',
  FILE_NO_SPACE: '磁盘空间不足',
  FILE_BLOCKED: '文件被浏览器安全策略拦截，建议改用 JPEG 格式',
  FILE_VIRUS: '文件被浏览器判定为不安全并拦截',
  BAD_CONTENT: '浏览器认为该数据无法保存，建议改用 JPEG 格式',
  ACCESS_DENIED: '没有该目录的写入权限',
  USER_CANCELED: '取消了保存对话框，未写出文件',
  ABORTED: '下载被中断',
  NETWORK_FAILED: '下载失败',
  INTERNAL_ERROR: '浏览器下载模块出错，请重试'
};

let job = null;
/* The stitched image of the last successful run, kept as blob URLs. A viewer page
 * fetches those URLs itself, so tens of megabytes never have to cross a runtime
 * message. Blobs only live as long as this worker does, which is why the popup and
 * the viewer both treat a missing shot as "expired" instead of an error. */
let shot = null;
/* True while a page-side region selector is waiting for the user. The popup closes
 * as soon as the page gets focus, so this is what keeps a second click from
 * stacking a second overlay on the same page. */
let picking = false;

class Cancelled extends Error {}

/* -------------------------------------------------------------------- state */

function snapshot() {
  if (!job) {
    return { status: 'idle', phase: '', percent: 0, frames: 0, message: '', error: null, thumb: null, file: '', shot: null, build: BUILD };
  }
  return {
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    frames: job.frames,
    message: job.message,
    error: job.error,
    thumb: job.thumb,
    file: job.file,
    shot: shotInfo(),
    build: BUILD
  };
}

function patch(next) {
  Object.assign(job, next);
  chrome.runtime.sendMessage({ type: 'LS_EVENT', state: snapshot() }).catch(() => {});
}

/* ------------------------------------------------------------------ actions */

async function start(tabId, options) {
  if (job && job.status === 'running') throw new Error('已有截图任务正在进行中');

  const tab = await chrome.tabs.get(tabId);
  assertInjectable(tab);

  const opts = {
    format: 'png',
    scale: 'device',
    overlap: 120,
    waitMs: 500,
    preload: true,
    hideFixed: true,
    saveAs: false,
    dedupe: true,
    range: null,
    crop: null,
    ...(options || {})
  };
  if (opts.range && Number(opts.range.end) - Number(opts.range.start) < 20) {
    throw new Error('选定的截图范围太小（不足 20 px），请重新标记起点和终点');
  }

  job = {
    status: 'running',
    cancel: false,
    tabId,
    options: opts,
    phase: '准备中',
    percent: 0,
    frames: 0,
    message: '',
    error: null,
    thumb: null,
    file: '',
    downloadIds: []
  };
  patch({});
  run(tab, opts).catch((err) => {
    if (err instanceof Cancelled) patch({ status: 'idle', phase: '已取消', percent: 0 });
    else patch({ status: 'error', phase: '失败', error: String((err && err.message) || err) });
  });
  return { ok: true };
}

function stop() {
  if (job && job.status === 'running') {
    job.cancel = true;
    patch({ phase: '正在停止…' });
  }
  return { ok: true };
}

function assertInjectable(tab) {
  const url = (tab && tab.url) || '';
  if (BLOCKED_URL.test(url) || url.startsWith('https://chrome.google.com/webstore')) {
    throw new Error('浏览器内置页面与应用商店禁止注入脚本，请在普通网页上使用');
  }
}

/* A hand-framed region turns into the two things the capture pass already
 * understands: a vertical scroll range (which rows to keep) and a horizontal band
 * (which columns to keep). The band is a fraction of the scroll root's content width,
 * because that is the width the stitcher outputs — reporting it against the window
 * would bake the scrollbar column into the crop and scale the page horizontally. */
async function pickRegion(tabId, options) {
  if (job && job.status === 'running') throw new Error('已有截图任务正在进行中');
  if (picking) throw new Error('框选层已经打开：请在页面里拖动选择，或按 Esc 取消');

  const tab = await chrome.tabs.get(tabId);
  assertInjectable(tab);

  picking = true;
  /* Framing a region can take minutes, and a service worker with nothing in flight
   * is stopped after 30 s — which would orphan the overlay and lose the selection. */
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  let picked;
  try {
    picked = await inject(tabId, FUNC_REGION);
  } finally {
    clearInterval(keepAlive);
    picking = false;
  }
  if (!picked) return { ok: true, cancelled: true };
  if (picked.height < 20 || picked.width < 8) {
    throw new Error('框选的区域太小（至少需要 8 × 20 px），请重新拖动选择');
  }

  const opts = { ...(options || {}), range: { start: picked.top, end: picked.bottom, viewTop: picked.viewTop } };
  /* A framed region is one screen tall by construction, so there are no repeated
   * headers to hide — and blanking the fixed layer would erase exactly the sticky
   * bar or modal the user just drew a box around. The capture stays where the page
   * was when they let go, so nothing of the selection slides under that bar either. */
  opts.hideFixed = false;
  if (picked.widthRatio < 0.9995 || picked.xRatio > 0.0005) {
    opts.crop = { xRatio: picked.xRatio, widthRatio: picked.widthRatio };
  }
  return start(tabId, opts);
}

function reveal() {
  const ids = (job && job.downloadIds) || [];
  if (!ids.length || !chrome.downloads.show) return { ok: false, error: '没有可打开的下载记录' };
  chrome.downloads.show(ids[ids.length - 1]);
  return { ok: true };
}

/* -------------------------------------------------------------------- shot */

function shotInfo() {
  if (!shot) return null;
  return { at: shot.at, file: shot.file, parts: shot.parts };
}

/** Keeps the exported image addressable from a page: same-origin blob URLs can be
 *  fetched and handed to the clipboard, while the data URL would have to be
 *  re-parsed by every consumer. */
async function rememberShot(files, savedPaths) {
  const parts = [];
  for (const file of files) {
    const blob = await fetch(file.dataUrl).then((res) => res.blob());
    parts.push({
      url: objectUrl(blob) || file.dataUrl,
      name: file.name,
      type: blob.type || (file.name.endsWith('.jpg') ? 'image/jpeg' : 'image/png'),
      bytes: blob.size,
      width: Number(file.width) || 0,
      height: Number(file.height) || 0
    });
  }
  dropShot();
  shot = { at: Date.now(), file: savedPaths.join('、'), parts };
}

function objectUrl(blob) {
  try {
    return URL.createObjectURL(blob);
  } catch (_) {
    return null;
  }
}

function dropShot() {
  if (!shot) return;
  for (const part of shot.parts) {
    if (/^blob:/.test(part.url)) {
      try {
        URL.revokeObjectURL(part.url);
      } catch (_) {}
    }
  }
  shot = null;
}

/* ------------------------------------------------------------------ capture */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Chrome only allows ~2 captureVisibleTab calls per second, so pace them here and
 * never trust the user-facing waitMs to keep the scroll loop inside that quota. */
const CAPTURE_GAP = 520;
/* A tab that is mid-navigation, minimized, or losing focus answers 「Cannot access
 * contents of url ""」 for a moment. That is a hiccup, and twenty seconds of scrolled
 * frames is not worth throwing away over it, so retry before giving up. */
const TRANSIENT = /MAX_CAPTURE_VISIBLE_TAB|quota|Cannot access contents|Cannot access a tab/i;
let lastCapture = 0;

async function captureFrame(windowId) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCapture + CAPTURE_GAP - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      lastCapture = Date.now();
      return dataUrl;
    } catch (err) {
      if (!TRANSIENT.test(String((err && err.message) || err)) || attempt >= 4) throw explain(err);
      await sleep(CAPTURE_GAP + 200 * (attempt + 1));
    }
  }
}

/* Chrome's own wording here is a permission or quota complaint the user cannot act
 * on, so say what to do about it instead. */
function explain(err) {
  const text = String((err && err.message) || err);
  if (/MAX_CAPTURE_VISIBLE_TAB|quota/i.test(text)) {
    return new Error('浏览器限制每秒截图次数，把「每屏等待」调大一点再试');
  }
  if (/Cannot access contents|Cannot access a tab/i.test(text)) {
    return new Error('截图时页面不在前台：窗口或标签页被切走、最小化，或页面正在跳转。请保持这一页可见后重试');
  }
  return err;
}

/* ---------------------------------------------------------------- pipeline */

async function run(tab, opts) {
  let sentFrames = 0;
  let lastFrameUrl = null;
  let repeats = 0;
  try {
    patch({ phase: '分析页面结构' });
    let meta = await inject(tab.id, FUNC_INSTALL, [opts]);
    if (!meta || meta.error) throw new Error(metaError(meta));
    if (meta.visible === false) throw new Error('页面当前不可见（窗口被最小化或遮挡），请把浏览器窗口调到前台后重试');
    if (!meta.scrollable) patch({ message: '页面不足一屏，直接截取当前视口' });

    // Everything downstream works in range-relative pixels so the long image has
    // no blank band above the user's chosen start.
    const originY = meta.range ? meta.range.start : 0;
    const clip = (height) => Math.min(height, meta.range ? meta.range.end : Infinity) - originY;
    if (meta.range && clip(meta.docHeight) < 20) {
      throw new Error('选定范围已经在页面内容之外，请重新滚动并标记起点/终点');
    }
    meta = { ...meta, docHeight: clip(meta.docHeight) };

    if (opts.preload && meta.scrollable) {
      patch({ phase: '预滚动以触发懒加载' });
      const pre = await inject(tab.id, FUNC_CALL, ['prepass', opts]);
      if (pre && pre.error) throw new Error(metaError(pre));
      meta = { ...meta, docHeight: clip((pre && pre.docHeight) || meta.docHeight) };
    }

    await ensureOffscreen();

    patch({ phase: '滚动截图中', percent: 4 });
    for (let i = 0; i < MAX_FRAMES; i++) {
      if (job.cancel) throw new Cancelled();
      // captureVisibleTab grabs whatever is on screen, so bail out if the user
      // switched tab/window while we were scrolling.
      const live = await chrome.tabs.get(tab.id);
      if (!live.active || live.windowId !== tab.windowId) throw new Error('请保持当前标签页处于前台直到截图完成');

      const step = await inject(tab.id, FUNC_CALL, ['step', opts]);
      if (!step || step.error) throw new Error(metaError(step));

      // Always capture lossless PNG; the chosen format is applied when exporting.
      let dataUrl = await captureFrame(tab.windowId);
      /* A capture identical to the previous one is almost always the compositor having
       * painted the new scroll position after the shot was taken, and the rows this screen
       * covers would never reach the image. Waiting once and shooting again tells that
       * apart from a section that really is pinned, which repeats even after the wait —
       * and once a run has shown that twice, it stops paying the extra wait for them. */
      if (dataUrl === lastFrameUrl && repeats < 2) {
        await sleep(Math.max(300, opts.waitMs || 0));
        dataUrl = await captureFrame(tab.windowId);
      }
      repeats = dataUrl === lastFrameUrl ? repeats + 1 : 0;
      lastFrameUrl = dataUrl;
      await chrome.runtime.sendMessage({
        type: 'LS_FRAME',
        dataUrl,
        offsetY: step.scrollY - originY,
        viewportCss: step.viewport,
        frame: step.frame || meta.frame
      });
      sentFrames++;

      const covered = Math.min(clip(step.docHeight), step.scrollY - originY + step.viewport);
      meta = { ...meta, viewport: step.viewport, docHeight: Math.max(meta.docHeight, covered), cssWidth: step.cssWidth, frame: step.frame || meta.frame };
      patch({
        frames: sentFrames,
        percent: Math.min(92, Math.round((covered / Math.max(1, meta.docHeight)) * 92)),
        phase: `滚动截图中 ${Math.round(covered)} / ${Math.round(meta.docHeight)} px · ${sentFrames} 屏${meta.range ? '（选定范围）' : ''}`
      });

      if (step.done) break;
      if (i === MAX_FRAMES - 1) patch({ message: '已达到最大分屏数，长图可能被截断' });
    }

    patch({ phase: '拼接长图', percent: 96 });
    const result = await chrome.runtime.sendMessage({
      type: 'LS_RENDER',
      cssWidth: meta.cssWidth,
      frame: meta.frame,
      docHeightCss: meta.docHeight,
      // The last screen can only extend the image as far as the range allows: a framed
      // box shorter than a viewport must not drag in the rows below it.
      lastViewportCss: Math.min(meta.viewport, meta.docHeight),
      deviceScale: meta.dpr,
      scaleMode: opts.scale,
      format: opts.format,
      quality: opts.quality || 0.92,
      fileName: buildFileName(tab, opts.format),
      dedupe: opts.dedupe !== false,
      crop: opts.crop || null
    });
    if (!result || !result.ok) throw new Error(result && result.error ? result.error : '拼接失败');

    const files = (result.files || []).filter((f) => f && f.dataUrl);
    if (!files.length) throw new Error('拼接完成但没有拿到图片数据，请重新加载扩展后重试');

    patch({ phase: '写出图片文件' });
    const saved = [];
    for (const file of files) {
      saved.push(await saveFile(file, opts.saveAs));
    }

    // The download already succeeded, so caching is allowed to fail: it only costs
    // the copy / annotate shortcuts, never the file on disk.
    let cached = true;
    await rememberShot(files, saved).catch(() => {
      cached = false;
    });

    patch({
      status: 'done',
      phase: '完成',
      percent: 100,
      thumb: result.thumb,
      file: saved.join('、'),
      message: [result.message || '', cached ? '' : '结果缓存失败，「查看 / 复制」暂不可用，文件本身已保存'].filter(Boolean).join('；')
    });
  } finally {
    await inject(tab.id, FUNC_CALL, ['restore', {}]).catch(() => {});
    await chrome.runtime.sendMessage({ type: 'LS_CLOSE' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

/* Read the page's current scroll position so the user can mark a capture range by
 * hand. Uses the same scroll root as the capture pass, and never modifies the page. */
async function mark(tabId) {
  const metrics = await inject(tabId, FUNC_INSTALL, [{ probe: true, hideFixed: false }]);
  if (!metrics || metrics.error) throw new Error(metaError(metrics));
  return {
    ok: true,
    scrollY: Math.round(metrics.scrollY),
    viewport: Math.round(metrics.viewport),
    docHeight: Math.round(metrics.docHeight)
  };
}

function metaError(res) {
  return res && res.error ? res.error : '页面脚本执行失败（可能发生了跳转，请重试）';
}

function buildFileName(tab, format) {
  const host = (() => {
    try {
      return new URL(tab.url).hostname;
    } catch (_) {
      return 'page';
    }
  })();
  const base = `${host}-${tab.title || ''}`
    .replace(/[\\/:*?"<>|~+^()#\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${base || 'page'}-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`;
}

async function saveFile(file, saveAs) {
  const name = SAVE_DIR + file.name;
  if (!chrome.downloads || !chrome.downloads.download) {
    throw new Error('下载接口不可用：请在扩展管理页点击 ↻ 重新加载本扩展');
  }
  const id = await chrome.downloads.download({
    url: file.dataUrl,
    // chrome.downloads only accepts paths relative to the browser download dir
    filename: name,
    saveAs,
    conflictAction: 'uniquify'
  });
  job.downloadIds.push(id);

  const info = await waitForDownload(id, saveAs ? 180_000 : 25_000);
  if (info.state === 'interrupted') {
    throw new Error(`保存失败：${DOWNLOAD_ERROR[info.error] || info.error || '下载被中断'}`);
  }
  return info.filename || name;
}

const settled = (state) => state === 'complete' || state === 'interrupted';

/* Resolves with the download record once it settles, or with whatever is known
 * when the deadline passes — a pending Save-As dialog can outlive any timeout.
 * A small file can also finish before the listener attaches, so the record is
 * read once up front as well. */
function waitForDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const lookup = () => chrome.downloads.search({ id }).then(([item]) => item || null).catch(() => null);

    const finish = (event) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      lookup().then((item) => {
        const merged = Object.assign({}, item || {}, event || {});
        if (!event || event.error === undefined) merged.error = (item && (item.error || item.interruptReason)) || undefined;
        if (!event || !event.state) merged.state = (item && item.state) || 'unknown';
        resolve(merged);
      });
    };

    const timer = setTimeout(() => finish({ state: 'pending-timeout' }), timeoutMs);

    function onChanged(delta) {
      if (delta.id !== id) return;
      const state = delta.state && delta.state.current;
      if (!settled(state)) return;
      finish({ state, error: (delta.error && delta.error.current) || (delta.interruptReason && delta.interruptReason.current) });
    }
    chrome.downloads.onChanged.addListener(onChanged);
    lookup().then((item) => {
      if (item && settled(item.state)) finish({ state: item.state, error: item.error || item.interruptReason });
    });
  });
}

/* A rejection here means the function never ran — the tab was simply unreachable at
 * that moment — so replaying it cannot double-advance the scroll driver. */
async function inject(tabId, func, args) {
  for (let attempt = 0; ; attempt++) {
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args: args || [] });
      if (!injection) throw new Error('脚本注入失败');
      if (injection.error) throw new Error(String(injection.error.message || injection.error));
      return injection.result;
    } catch (err) {
      const text = String((err && err.message) || err);
      if (!/Cannot access contents|Cannot access a tab/i.test(text) || attempt >= 3) throw explain(err);
      await sleep(400 * (attempt + 1));
    }
  }
}

/* ---------------------------------------------------------------- offscreen */

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      // BLOBS is accepted by every Chrome version that ships the offscreen API;
      // IMAGE_PROCESSING only exists in newer builds and is rejected by older ones.
      reasons: ['BLOBS'],
      justification: '用 canvas 按偏移拼接分屏截图并导出图片数据'
    });
  } catch (err) {
    if (!/single active offscreen document/i.test(String(err && err.message))) throw err;
  }
}

/* ------------------------------------------------------------------ events */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'LS_START') sendResponse(await start(msg.tabId, msg.options));
      else if (msg.type === 'LS_STOP') sendResponse(stop());
      else if (msg.type === 'LS_STATE') sendResponse({ ok: true, state: snapshot() });
      else if (msg.type === 'LS_REVEAL') sendResponse(reveal());
      else if (msg.type === 'LS_MARK') sendResponse(await mark(msg.tabId));
      else if (msg.type === 'LS_REGION') sendResponse(await pickRegion(msg.tabId, msg.options));
      else if (msg.type === 'LS_GET_SHOT') sendResponse({ ok: true, shot: shotInfo() });
      else sendResponse({ ok: false, error: 'unknown message' });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-full-page' && command !== 'capture-region') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const { settings } = await chrome.storage.local.get('settings');
  if (command === 'capture-region') {
    const res = await pickRegion(tab.id, settings || {}).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
    // The popup is closed while the user drags on the page, so a rejected selection
    // (built-in page, box too small) has to be left behind for the next popup open.
    if (res && res.ok === false) {
      if (!job) job = { status: 'idle', phase: '', percent: 0, frames: 0, thumb: null, file: '', downloadIds: [] };
      patch({ error: res.error });
    }
    return;
  }
  start(tab.id, settings || {});
});

/* ------------------------------------------- page driver (isolated world) */

const FUNC_INSTALL = async function (opts) {
  if (!window.__LS__) {
    const LS = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /** The element that actually scrolls: the document, or an inner overflow container. */
    LS.findRoot = function () {
      let best = document.scrollingElement || document.documentElement;
      let bestRange = (best.scrollHeight || 0) - (best.clientHeight || 0);
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length < 2) continue;
        const cs = getComputedStyle(el);
        if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
        const range = el.scrollHeight - el.clientHeight;
        if (range > bestRange + 40) {
          bestRange = range;
          best = el;
        }
      }
      return best;
    };

    LS.root = function () {
      let el = document.querySelector('[data-ls-root]');
      if (!el || !el.isConnected) {
        el = LS.findRoot();
        el.setAttribute('data-ls-root', '1');
      }
      return el;
    };

    /** visibility (not display) so the layout flow stays byte-identical between frames. */
    LS.hideOverlays = function () {
      if (!document.getElementById('__ls_style')) {
        const style = document.createElement('style');
        style.id = '__ls_style';
        style.textContent = '[data-ls-hide]{visibility:hidden !important}';
        (document.head || document.documentElement).appendChild(style);
      }
      const vw = window.innerWidth || 800;
      const vh = window.innerHeight || 600;
      for (const el of document.querySelectorAll('body *')) {
        if (el.hasAttribute('data-ls-hide') || el.hasAttribute('data-ls-root')) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        // A fixed/sticky box covering the whole viewport is a page wrapper, not an overlay.
        if (r.width > vw * 0.9 && r.height > vh * 0.9) continue;
        el.setAttribute('data-ls-hide', '1');
      }
    };

    /* The rows the shutter sees must be the rows the reported offset describes. A page is
     * free to move them under us: `scroll-behavior:smooth` turns every write into an
     * animation, snap points pull the settled value to the nearest element, and scroll
     * anchoring shifts scrollTop once lazy content above the viewport finishes loading.
     * Each of those makes the capture show a different band than the one being stitched,
     * which reads as 「截到了不该在这里的内容」. None of them touch layout, so switching
     * them off changes the pixels not at all — only where the page sits. */
    LS.pinRules = 'html,body,[data-ls-pin],[data-ls-root]{scroll-behavior:auto !important;scroll-snap-type:none !important;overflow-anchor:none !important}';
    LS.pin = function (root) {
      if (!document.getElementById('__ls_pin')) {
        const style = document.createElement('style');
        style.id = '__ls_pin';
        style.textContent = LS.pinRules;
        (document.head || document.documentElement).appendChild(style);
      }
      if (root && !root.hasAttribute('data-ls-pin')) root.setAttribute('data-ls-pin', '1');
    };

    /* Scroll is only trustworthy once it has stopped: two reads in a row at the same
     * value, so an animation still running cannot be mistaken for a settled page. */
    LS.waitStill = async function (maxMs) {
      const root = LS.root();
      const limit = Math.max(120, Number(maxMs) || 600);
      let last = root.scrollTop;
      let stable = 0;
      for (let waited = 0; waited < limit && stable < 2; waited += 40) {
        await sleep(40);
        const now = root.scrollTop;
        stable = now === last ? stable + 1 : 0;
        last = now;
      }
      return last;
    };

    LS.waitSettle = async function (timeout) {
      const vh = LS.root().clientHeight || window.innerHeight || 600;
      const pending = [];
      for (const img of Array.prototype.slice.call(document.images || [])) {
        if (img.complete && img.naturalWidth) continue;
        const r = img.getBoundingClientRect();
        if (r.bottom <= -vh || r.top >= vh * 2) continue;
        try {
          img.loading = 'eager';
          if (img.decoding === 'async') img.decoding = 'sync';
        } catch (_) {}
        pending.push(
          new Promise((res) => {
            img.addEventListener('load', res, { once: true });
            img.addEventListener('error', res, { once: true });
          })
        );
      }
      await Promise.race([Promise.all(pending), sleep(Math.max(80, timeout))]);
      await Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), sleep(220)]);
      // rAF stops firing when the window is hidden or minimized, so never await it unbounded.
      await Promise.race([
        new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))),
        sleep(500)
      ]);
      await LS.waitStill(600);
    };

    /** Only a start that is strictly above a given end counts as a range.
     *  viewTop is set by a framed region: how far inside the viewport the top of the
     *  box was when it was drawn, so the capture can start from the same scroll
     *  position instead of dragging the box up under a sticky header. */
    LS.validRange = function (range) {
      if (!range) return null;
      const start = Math.max(0, Math.round(Number(range.start)));
      const end = Math.round(Number(range.end));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 20) return null;
      return { start, end, viewTop: Math.max(0, Math.round(Number(range.viewTop) || 0)) };
    };

    /* Where the scroll root's content box sits inside a viewport capture.
     * captureVisibleTab grabs the whole window — classic scrollbar included — so
     * stitching needs the window's own CSS width to turn bitmap pixels back into CSS
     * pixels, plus how much browser chrome (a nav rail, a toolbar) sits left of and
     * above the scrolling content. For the document root both offsets are zero. */
    LS.frame = function () {
      const root = LS.root();
      const doc = root === document.documentElement || root === document.scrollingElement || root === document.body;
      const r = doc ? null : root.getBoundingClientRect();
      return {
        winW: Math.max(1, window.innerWidth || root.clientWidth || 1),
        left: r ? Math.max(0, r.left + (root.clientLeft || 0)) : 0,
        top: r ? Math.max(0, r.top + (root.clientTop || 0)) : 0
      };
    };

    LS.init = function (options) {
      const root = LS.findRoot();
      const html = document.documentElement;
      const range = LS.validRange(options.range);
      const viewport = root.clientHeight || window.innerHeight;
      /* First screen of a run: the top of the range, except that a framed region keeps
       * the margin it had inside the viewport (origin - viewTop is where the page stood
       * while the user dragged), so a sticky header cannot slide over the selection. */
      const target = range ? Math.max(0, range.start - Math.min(viewport, range.viewTop || 0)) : null;
      LS.state = {
        origTop: root.scrollTop,
        origBehavior: html.style.scrollBehavior,
        y: root.scrollTop,
        origin: range ? range.start : null,
        limit: range ? range.end : Infinity,
        target,
        prev: -1,
        first: true,
        hideFixed: options.hideFixed !== false
      };
      // probe mode only measures, so marking a range never touches the page.
      if (!options.probe) {
        root.setAttribute('data-ls-root', '1');
        html.style.scrollBehavior = 'auto';
        LS.pin(root);
      }
      LS.stepSize = Math.max(60, Math.round(viewport - (Number(options.overlap) || 120)));
      return {
        ok: true,
        cssWidth: root.clientWidth || window.innerWidth,
        viewport,
        frame: LS.frame(),
        scrollY: root.scrollTop,
        docHeight: Math.max(root.scrollHeight, html.scrollHeight),
        range,
        dpr: window.devicePixelRatio || 1,
        scrollable: root.scrollHeight - root.clientHeight > 4,
        visible: document.visibilityState === 'visible' && window.innerHeight > 0
      };
    };

    LS.prepass = async function (options) {
      const root = LS.root();
      const from = LS.state.origin == null ? root.scrollTop : LS.state.target;
      const jump = Math.round((root.clientHeight || window.innerHeight || 600) * 1.4);
      root.scrollTop = from;
      await LS.waitSettle(200);
      let last = -1;
      for (let i = 0; i < 60; i++) {
        root.scrollTop = root.scrollTop + jump;
        await LS.waitSettle(Math.max(140, Math.round((Number(options.waitMs) || 500) / 2)));
        if (root.scrollTop === last) break;
        if (LS.state.limit !== Infinity && root.scrollTop + root.clientHeight >= LS.state.limit) break;
        last = root.scrollTop;
      }
      await sleep(320);
      root.scrollTop = LS.state.origin == null ? 0 : LS.state.origin;
      LS.state.y = root.scrollTop;
      LS.state.first = true;
      LS.state.prev = -1;
      await LS.waitSettle(420);
      return { ok: true, docHeight: Math.max(root.scrollHeight, document.documentElement.scrollHeight) };
    };

    LS.step = async function (options) {
      const root = LS.root();
      if (LS.state.hideFixed) LS.hideOverlays();
      const viewport = root.clientHeight || window.innerHeight;
      /* A marked end limits where the bottom edge of the last screen may reach, but it
       * must never lift the top edge above where this run may start: a box shorter than
       * one screen would otherwise be captured from above the range. */
      const floor = LS.state.target || 0;
      const max = Math.max(floor, Math.min(root.scrollHeight - viewport, LS.state.limit - viewport));
      if (LS.state.first) {
        LS.state.first = false;
        if (LS.state.origin != null) {
          root.scrollTop = Math.min(max, LS.state.target);
          await LS.waitSettle(Number(options.waitMs) || 500);
        }
        LS.state.y = root.scrollTop;
      } else {
        LS.state.y = Math.min(max, LS.state.y + LS.stepSize);
      }
      root.scrollTop = LS.state.y;
      await LS.waitSettle(Number(options.waitMs) || 500);
      const actual = root.scrollTop;
      const noMovement = LS.state.prev >= 0 && Math.abs(actual - LS.state.prev) < 1;
      LS.state.prev = actual;
      LS.state.y = actual;
      return {
        ok: true,
        scrollY: actual,
        viewport,
        frame: LS.frame(),
        docHeight: Math.max(root.scrollHeight, document.documentElement.scrollHeight),
        cssWidth: root.clientWidth || window.innerWidth,
        done: actual >= max - 1 || noMovement
      };
    };

    LS.restore = function () {
      const st = LS.state;
      if (st) {
        LS.root().scrollTop = st.origTop;
        document.documentElement.style.scrollBehavior = st.origBehavior || '';
      }
      const style = document.getElementById('__ls_style');
      if (style) style.remove();
      const pin = document.getElementById('__ls_pin');
      if (pin) pin.remove();
      for (const el of document.querySelectorAll('[data-ls-pin]')) el.removeAttribute('data-ls-pin');
      for (const el of document.querySelectorAll('[data-ls-hide]')) el.removeAttribute('data-ls-hide');
      const root = document.querySelector('[data-ls-root]');
      if (root) root.removeAttribute('data-ls-root');
      return { ok: true };
    };

    window.__LS__ = LS;
  }
  try {
    return window.__LS__.init(opts);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
};

const FUNC_CALL = async function (name, opts) {
  const LS = window.__LS__;
  if (!LS || typeof LS[name] !== 'function') return { error: '页面状态丢失，请重新发起截图' };
  try {
    return await LS[name](opts || {});
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
};

/* ------------------------------------------------- region selector (overlay) */

/* The QQ Screenshot 框选 equivalent: drag for a free rectangle, a plain click for
 * the element under the cursor, and the wheel walks the selection out to that
 * element's parents or back in to its children.
 *
 * Resolves with the chosen box expressed in the scroll root's content coordinates
 * (the same numbers the driver compares against root.scrollTop), plus the horizontal
 * band as a fraction of that root's content width.
 */
const FUNC_REGION = function () {
  const MIN = 4;
  const AUTO_CANCEL = 300000;
  const LS = window.__LS__;
  const root = LS ? LS.root() : document.scrollingElement || document.documentElement;
  const isDocRoot = root === document.documentElement || root === document.scrollingElement || root === document.body;

  return new Promise((resolve) => {
    const style = document.createElement('style');
    // The page's own rules can reach our nodes through broad selectors, so every
    // overlay rule is reset first and then re-declared with an attribute selector.
    style.textContent = [
      '[data-ls-pick]{all:initial;box-sizing:border-box;font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:12px;line-height:1.4;color:#e8eaed}',
      '[data-ls-pick="layer"]{position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;cursor:crosshair;overflow:hidden}',
      '[data-ls-pick="band"]{position:fixed;display:none;border:1px solid #2f6bff;box-shadow:0 0 0 9999px rgba(12,14,18,.38);pointer-events:none}',
      '[data-ls-pick="bar"]{position:fixed;display:none;gap:6px;align-items:center;padding:4px;border-radius:8px;background:rgba(24,26,30,.94);box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap}',
      '[data-ls-pick="bar"]>span{padding:0 4px;color:#9aa1ab}',
      '[data-ls-pick="btn"]{display:inline-block;padding:4px 8px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.14)}',
      '[data-ls-pick="btn-primary"]{background:#2f6bff;color:#fff}',
      '[data-ls-pick="hint"]{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);padding:7px 12px;border-radius:8px;background:rgba(24,26,30,.9);pointer-events:none;white-space:nowrap}',
      // While the box is on screen the page must not move: a smooth scroll still running
      // from the user's own wheel, or a snap point pulling the settled position away,
      // would leave the framed rows somewhere else than the pixels that get captured.
      'html,body,[data-ls-pin]{scroll-behavior:auto !important;scroll-snap-type:none !important;overflow-anchor:none !important}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
    root.setAttribute('data-ls-pin', '1');

    const node = (kind) => {
      const el = document.createElement('div');
      el.setAttribute('data-ls-pick', kind);
      return el;
    };
    const layer = node('layer');
    const band = node('band');
    const bar = node('bar');
    const hint = node('hint');
    const sizeLabel = document.createElement('span');
    hint.textContent = '拖动框选 · 单击选中元素 · 滚轮切换父/子元素 · Enter 完成 · Esc 取消';

    let timer = null;
    const pickButton = (text, kind) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.setAttribute('data-ls-pick', kind);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        finish(kind === 'btn-primary');
      });
      return btn;
    };
    bar.append(sizeLabel, pickButton('完成', 'btn-primary'), pickButton('取消', 'btn'));
    layer.append(band, bar, hint);
    (document.body || document.documentElement).appendChild(layer);

    /* Where the scroll root's content box sits inside the captured viewport. For the
     * documentElement that is simply the viewport origin — its own client rect has
     * already been shifted up by the scroll, so it cannot be used here. */
    function origin() {
      if (isDocRoot) return { x: 0, y: 0 };
      const r = root.getBoundingClientRect();
      return { x: r.left + (root.clientLeft || 0), y: r.top + (root.clientTop || 0) };
    }

    let box = null;
    let chain = [];
    let level = 0;
    let anchor = null;
    let dragging = false;
    let locked = false;

    function visibleBand() {
      return {
        left: root.scrollLeft,
        top: root.scrollTop,
        right: root.scrollLeft + root.clientWidth,
        bottom: root.scrollTop + root.clientHeight
      };
    }

    function clamp(rect) {
      const v = visibleBand();
      const left = Math.max(v.left, Math.min(v.right, rect.x));
      const top = Math.max(v.top, Math.min(v.bottom, rect.y));
      const right = Math.max(v.left, Math.min(v.right, rect.x + rect.width));
      const bottom = Math.max(v.top, Math.min(v.bottom, rect.y + rect.height));
      return { x: left, y: top, width: right - left, height: bottom - top };
    }

    function toContent(clientX, clientY) {
      const o = origin();
      return { x: clientX - o.x + root.scrollLeft, y: clientY - o.y + root.scrollTop };
    }

    function underPoint(clientX, clientY) {
      const list = document.elementsFromPoint
        ? document.elementsFromPoint(clientX, clientY)
        : [document.elementFromPoint(clientX, clientY)];
      const out = [];
      for (const el of list || []) {
        if (!el || el.nodeType !== 1) continue;
        if (el.closest && el.closest('[data-ls-pick]')) continue;
        if (el === document.documentElement || el === document.body) continue;
        out.push(el);
      }
      return out;
    }

    function ofElement(el) {
      const r = el.getBoundingClientRect();
      const o = origin();
      return clamp({
        x: r.left - o.x + root.scrollLeft,
        y: r.top - o.y + root.scrollTop,
        width: r.width,
        height: r.height
      });
    }

    function paint() {
      if (!box || box.width < 1 || box.height < 1) {
        band.style.display = 'none';
        bar.style.display = 'none';
        hint.style.display = '';
        return;
      }
      const o = origin();
      const left = Math.round(box.x - root.scrollLeft + o.x);
      const top = Math.round(box.y - root.scrollTop + o.y);
      hint.style.display = locked ? 'none' : '';
      band.style.display = 'block';
      band.style.left = left + 'px';
      band.style.top = top + 'px';
      band.style.width = Math.round(box.width) + 'px';
      band.style.height = Math.round(box.height) + 'px';
      sizeLabel.textContent = `${Math.round(box.width)} × ${Math.round(box.height)}`;
      bar.style.display = 'flex';
      bar.style.left = Math.max(4, Math.min((window.innerWidth || 800) - (bar.offsetWidth || 160) - 4, left - 5)) + 'px';
      bar.style.top = Math.max(4, top - (bar.offsetHeight || 30) - 8) + 'px';
    }

    function dragRect(from, to) {
      return clamp({
        x: Math.min(from.x, to.x),
        y: Math.min(from.y, to.y),
        width: Math.abs(to.x - from.x),
        height: Math.abs(to.y - from.y)
      });
    }

    function onMove(e) {
      if (dragging && anchor) {
        box = dragRect(anchor, toContent(e.clientX, e.clientY));
        paint();
        return;
      }
      if (locked) return;
      // Hover follows the element under the pointer, innermost first.
      chain = underPoint(e.clientX, e.clientY);
      level = 0;
      box = chain.length ? ofElement(chain[0]) : null;
      paint();
    }

    function onDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      locked = false;
      anchor = toContent(e.clientX, e.clientY);
      chain = underPoint(e.clientX, e.clientY);
      level = 0;
      try {
        layer.setPointerCapture(e.pointerId);
      } catch (_) {}
    }

    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      const rect = dragRect(anchor, toContent(e.clientX, e.clientY));
      // A press without a drag means "take this whole element", not a three-pixel box.
      box = rect.width >= MIN && rect.height >= MIN ? rect : chain.length ? ofElement(chain[level]) : null;
      locked = true;
      paint();
    }

    function onWheel(e) {
      e.preventDefault();
      if (!chain.length) chain = underPoint(e.clientX, e.clientY);
      if (!chain.length) return;
      level = Math.max(0, Math.min(chain.length - 1, level + (e.deltaY < 0 ? 1 : -1)));
      box = ofElement(chain[level]);
      locked = true;
      paint();
    }

    function onKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    }

    function finish(confirmed) {
      clearTimeout(timer);
      layer.removeEventListener('pointermove', onMove);
      layer.removeEventListener('pointerdown', onDown);
      layer.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointerup', onUp);
      layer.removeEventListener('wheel', onWheel, { passive: false });
      document.removeEventListener('keydown', onKey, true);
      layer.remove();
      style.remove();
      root.removeAttribute('data-ls-pin');
      if (!confirmed || !box || box.width < MIN || box.height < MIN) {
        resolve(null);
        return;
      }
      const width = Math.max(1, root.clientWidth || window.innerWidth || 1);
      // Content coordinates already exclude the root box origin, so the band is a
      // fraction of the content box — the same box the stitched image is as wide as.
      const xRatio = Math.max(0, Math.min(1, (box.x - root.scrollLeft) / width));
      // How far the top of the box sat below the edge of the visible area. The capture
      // has to keep that margin: pulling the box up to the top of the viewport would
      // slide a sticky header over the rows the user just framed.
      resolve({
        xRatio,
        widthRatio: Math.max(0, Math.min(1 - xRatio, box.width / width)),
        width: Math.round(box.width),
        height: Math.round(box.height),
        top: Math.round(box.y),
        bottom: Math.round(box.y + box.height),
        viewTop: Math.max(0, Math.round(box.y - root.scrollTop))
      });
    }

    timer = setTimeout(() => finish(false), AUTO_CANCEL);
    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerdown', onDown);
    layer.addEventListener('pointerup', onUp);
    window.addEventListener('pointerup', onUp);
    layer.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKey, true);
    paint();
  });
};
