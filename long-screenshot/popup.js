const $ = (id) => document.getElementById(id);
const FIELDS = {
  format: $('format'),
  scale: $('scale'),
  overlap: $('overlap'),
  waitMs: $('waitMs'),
  preload: $('preload'),
  hideFixed: $('hideFixed'),
  dedupe: $('dedupe'),
  saveAs: $('saveAs')
};

let tabId = null;
let marks = { start: null, end: null };
let pageMetrics = { viewport: 800, docHeight: 0 };
let lastState = null;

/* Must match BUILD in background.js; a mismatch means the reload did not replace
 * the running service worker. */
const EXPECTED_BUILD = '1.5.6';

/* ------------------------------------------------------------------ helpers */

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function currentOptions() {
  return {
    format: FIELDS.format.value,
    scale: FIELDS.scale.value,
    overlap: Number(FIELDS.overlap.value),
    waitMs: Number(FIELDS.waitMs.value),
    preload: FIELDS.preload.checked,
    hideFixed: FIELDS.hideFixed.checked,
    dedupe: FIELDS.dedupe.checked,
    saveAs: FIELDS.saveAs.checked,
    range: rangeFromMarks()
  };
}

/* ---------------------------------------------------------------- range marks */

/** Only a start and an end that are far enough apart form a range; the order the
 *  two points were clicked in does not matter. */
function rangeFromMarks() {
  if (marks.start == null || marks.end == null) return null;
  const [a, b] = [marks.start, marks.end].sort((x, y) => x - y);
  return b - a >= 20 ? { start: a, end: b } : null;
}

function renderRange() {
  noteRange('');
  const range = rangeFromMarks();
  const screens = Math.max(1, Math.ceil((range ? range.end - range.start : pageMetrics.docHeight) / pageMetrics.viewport));
  if (range) {
    $('rangeInfo').textContent = `${range.start} → ${range.end} px（约 ${range.end - range.start} px，${screens} 屏）`;
  } else if (marks.start != null || marks.end != null) {
    $('rangeInfo').textContent = `已标记 ${marks.start != null ? marks.start : marks.end} px，还需要另一个端点，当前按整页处理`;
  } else {
    $('rangeInfo').textContent = `整页（约 ${pageMetrics.docHeight} px，${screens} 屏）`;
  }
}

async function mark(which) {
  const res = await send('LS_MARK', { tabId });
  if (!res || !res.ok) {
    showError(res && res.error ? res.error : '读取当前滚动位置失败，请刷新页面后重试');
    return;
  }
  pageMetrics = { viewport: res.viewport, docHeight: res.docHeight };
  marks[which] = res.scrollY;
  await chrome.storage.local.set({ range: { tabId, start: marks.start, end: marks.end } });
  renderRange();
}

function showError(text) {
  $('error').hidden = false;
  $('error').textContent = text;
}

function showHint(text) {
  $('shotHint').hidden = !text;
  $('shotHint').textContent = text || '';
}

/* Feedback that belongs next to the range controls rather than in the error box:
 * cancelling a frame selection is not a failure. */
function noteRange(text) {
  $('rangeNote').hidden = !text;
  $('rangeNote').textContent = text || '';
}

function applyOptions(options) {
  if (!options) return;
  for (const [key, el] of Object.entries(FIELDS)) {
    if (!(key in options)) continue;
    if (el.type === 'checkbox') el.checked = !!options[key];
    else el.value = String(options[key]);
  }
  syncLabels();
}

function syncLabels() {
  $('overlapValue').textContent = FIELDS.overlap.value;
  $('waitValue').textContent = FIELDS.waitMs.value;
}

function describeFile(fileValue) {
  const paths = String(fileValue || '')
    .split('、')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paths.length) return '拼接完成，但没有拿到文件路径记录，请重新加载扩展后重试。';
  const absolute = paths.every((p) => /^\w:[\\/]/.test(p) || p.startsWith('/'));
  return absolute
    ? `已保存：${paths.join('  |  ')}`
    : `已保存到浏览器下载目录下的 ${paths.join('  |  ')}（如果勾选了「下载前询问保存位置」，实际位置以下载页 chrome://downloads 为准）`;
}

function renderState(state) {
  if (!state) return;
  lastState = state;
  const running = state.status === 'running';
  const stale = state.build !== EXPECTED_BUILD;
  const hasShot = state.status === 'done' && !!state.shot;
  $('start').disabled = running;
  $('stop').disabled = !running;
  $('pickRegion').disabled = running;
  $('edit').disabled = !hasShot;
  $('copy').disabled = !hasShot;
  if (!hasShot) showHint('');
  $('progress').hidden = !(running || state.status === 'done');
  $('bar').style.width = `${state.percent || 0}%`;
  $('phase').textContent = state.phase || '';
  $('error').hidden = !state.error;
  $('error').textContent = state.error || '';
  $('result').hidden = state.status !== 'done';
  $('stale').hidden = !stale;
  $('buildLabel').textContent = stale
    ? `后台版本 ${state.build || '未知'}，弹窗版本 ${EXPECTED_BUILD}：不一致`
    : `后台版本 ${EXPECTED_BUILD}`;

  if (state.status === 'done') {
    if (state.thumb) $('thumb').src = state.thumb;
    $('file').textContent = describeFile(state.file);
    $('message').textContent = state.message || `${state.frames} 屏拼接完成`;
  } else if (running) {
    $('message').textContent = `已捕获 ${state.frames || 0} 屏`;
  }
}

/* --------------------------------------------------------------------- init */

async function loadPageInfo(tab) {
  tabId = tab.id;
  let host = tab.url || '';
  try {
    host = new URL(tab.url).hostname;
  } catch (_) {}
  $('pageInfo').textContent = host || '未知页面';
  if (!/^https?:/.test(tab.url || '')) return;

  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
        viewport: window.innerHeight
      })
    });
    const info = probe && probe.result;
    if (info && info.height) {
      pageMetrics = { viewport: info.viewport, docHeight: info.height };
      const screens = Math.max(1, Math.ceil(info.height / Math.max(1, info.viewport)));
      $('pageInfo').textContent = `${host} · 约 ${info.height} px 高（${screens} 屏）`;
    }
  } catch (_) {
    $('pageInfo').textContent = `${host} · 该页面不可注入脚本`;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await loadPageInfo(tab);

  const { settings } = await chrome.storage.local.get('settings');
  applyOptions(settings);

  const { range: stored } = await chrome.storage.local.get('range');
  marks = stored && tab && stored.tabId === tab.id ? { start: stored.start ?? null, end: stored.end ?? null } : { start: null, end: null };
  renderRange();

  const { state } = (await send('LS_STATE')) || {};
  if (!state) {
    $('stale').hidden = false;
    $('buildLabel').textContent = `后台版本 无响应，弹窗版本 ${EXPECTED_BUILD}`;
  }
  renderState(state);

  for (const el of Object.values(FIELDS)) {
    el.addEventListener('change', async () => {
      syncLabels();
      await chrome.storage.local.set({ settings: currentOptions() });
    });
  }

  $('markStart').addEventListener('click', () => mark('start'));
  $('markEnd').addEventListener('click', () => mark('end'));
  $('clearRange').addEventListener('click', async () => {
    marks = { start: null, end: null };
    await chrome.storage.local.set({ range: null });
    renderRange();
  });

  /* The overlay lives in the page, so this call does not come back: the popup loses
   * focus as soon as the user drags and Chrome closes it. The service worker keeps
   * the pending selection and starts the job on its own. */
  $('pickRegion').addEventListener('click', async () => {
    if (tabId == null) return;
    $('error').hidden = true;
    noteRange('框选层已在页面里打开：拖动鼠标选区域，Enter 开始截图，Esc 取消。');
    const res = await send('LS_REGION', { tabId, options: currentOptions() });
    if (!res) return;
    if (!res.ok) showError(res.error || '框选失败，请刷新页面后重试');
    else if (res.cancelled) noteRange('已取消框选，没有开始截图。');
  });

  $('start').addEventListener('click', async () => {
    if (tabId == null) return;
    $('error').hidden = true;
    const res = await send('LS_START', { tabId, options: currentOptions() });
    if (res && !res.ok) {
      $('error').hidden = false;
      $('error').textContent = res.error;
      return;
    }
    $('start').disabled = true;
    $('stop').disabled = false;
    $('progress').hidden = false;
    $('bar').style.width = '2%';
  });

  $('stop').addEventListener('click', () => send('LS_STOP'));

  $('reveal').addEventListener('click', async () => {
    const res = await send('LS_REVEAL');
    if (res && !res.ok) {
      $('error').hidden = false;
      $('error').textContent = res.error || '无法打开文件夹';
    }
  });

  $('copy').addEventListener('click', async () => {
    try {
      showHint(await copyShot(lastState && lastState.shot));
    } catch (err) {
      showHint(`复制失败：${(err && err.message) || err}。图片已保存为文件，也可以从文件复制。`);
    }
  });

  $('edit').addEventListener('click', async () => {
    const current = lastState && lastState.shot;
    if (!current) return showHint('结果已过期，请重新截图。');
    await chrome.tabs.create({ url: chrome.runtime.getURL('edit.html') });
    window.close();
  });

  $('reloadExt').addEventListener('click', () => {
    try {
      chrome.runtime.reload();
    } catch (_) {
      $('error').hidden = false;
      $('error').textContent = '这个 Chrome 版本不允许扩展自我重载，请手动关闭再打开扩展开关。';
    }
  });

  $('toggleAdvanced').addEventListener('click', () => {
    const collapsed = $('options').classList.toggle('collapsed');
    $('toggleAdvanced').textContent = collapsed ? '设置' : '收起设置';
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'LS_EVENT') renderState(msg.state);
  });
}

init();
