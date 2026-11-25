/* Long Shot — viewer page for the last stitched image.
 * The pixels are fetched from the blob URLs the service worker hands back, so the
 * image never has to cross a runtime message. Each part gets its own annotation
 * editor; the toolbar edits whichever part was last clicked.
 */

const $ = (id) => document.getElementById(id);

let shot = null;
let editors = [];
let active = null;

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function notice(text, isBad) {
  $('notice').hidden = !text;
  $('notice').textContent = text || '';
  $('notice').classList.toggle('bad', !!isBad);
}

/* ------------------------------------------------------------- toolbar glue */

const toolbarApi = {
  undo: () => active && active.undo(),
  redo: () => active && active.redo(),
  clear: () => active && active.clear(),
  setTool: (kind) => each((ed) => ed.setTool(kind)),
  setColor: (color) => each((ed) => ed.setColor(color)),
  setWidth: (width) => each((ed) => ed.setWidth(width)),
  setStrength: (value) => each((ed) => ed.setStrength(value)),
  toggleFill: () => each((ed) => ed.toggleFill()),
  setZoom: (value) => each((ed) => ed.setZoom(value)),
  setZoomStep: (dir) => each((ed) => ed.setZoomStep(dir))
};

/** Tool and colour are page-wide preferences, not per-image state. */
function each(fn) {
  for (const editor of editors) fn(editor);
  refresh();
}

function refresh() {
  const state = active ? active.state() : { tool: 'rect', color: '#ff3b30', width: 4, strength: 14, filled: false, canUndo: false, canRedo: false, zoomLabel: '' };
  if (toolbarApi.paint) toolbarApi.paint(state);
  $('copyAnno').disabled = !active;
  $('ocr').disabled = !active;
  $('export').disabled = !editors.length;
}

/* ----------------------------------------------------------------- exporting */

async function flattenAll() {
  const out = [];
  for (const editor of editors) out.push({ editor, ...await editor.flatten() });
  return out;
}

function mark(name) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${String(name).replace(/\.(png|jpe?g)$/i, '')}-标注-${stamp}.png`;
}

/** A blob URL handed to chrome.downloads has to stay alive until the browser has
 *  read it, so it is revoked on a timer rather than right after the call. */
function hold(url) {
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** chrome.downloads.download only queues the write, so reporting 已导出 before it
 *  reaches complete is how 「提示成功但文件不在」 happens. */
function downloadDone(id, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(watch);
      resolve('pending');
    }, timeoutMs);
    function watch(delta) {
      if (!delta || delta.id !== id || !delta.state) return;
      const state = delta.state.current;
      if (state === 'complete' || state === 'interrupted') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(watch);
        resolve(state);
      }
    }
    chrome.downloads.onChanged.addListener(watch);
  });
}

async function exportFiles() {
  notice('正在导出…');
  const done = [];
  const stuck = [];
  let shrink = 100;
  for (const { editor, blob, scaled } of await flattenAll()) {
    const url = URL.createObjectURL(blob);
    hold(url);
    const filename = `LongShot/${mark(editor.part.name)}`;
    const state = await downloadDone(await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }));
    (state === 'complete' ? done : stuck).push(filename);
    shrink = Math.min(shrink, scaled || 100);
  }
  const parts = done.length
    ? [`已导出 ${done.length} 个文件到浏览器下载目录：${done.join('、')}`]
    : [];
  if (shrink < 100) parts.push(`超出 canvas 上限，已缩到 ${shrink}%`);
  if (stuck.length) parts.push(`另有 ${stuck.length} 个文件没有写完（${stuck.join('、')}），去 chrome://downloads 看原因`);
  notice(parts.join('；'), stuck.length > 0);
  refresh();
  return done;
}

async function copyAnnotated() {
  if (!active) return;
  notice('正在准备剪贴板…');
  const { blob, scaled } = await active.flatten();
  const url = URL.createObjectURL(blob);
  hold(url);
  const text = await copyShot({ parts: [{ url, type: 'image/png', name: active.part.name }] });
  notice(
    [text, scaled < 100 ? `已缩到 ${scaled}%` : '', editors.length > 1 ? '多段结果只复制了当前这一段，其余各段请用「导出文件」' : '']
      .filter(Boolean)
      .join('；')
  );
}

/* ----------------------------------------------------------------- 文字识别 */

/* 引擎的进度事件只有这几个 status，翻成中文比原样贴出来好读。 */
const OCR_STATUS = {
  'loading tesseract core': '加载识别引擎',
  'initializing tesseract': '初始化引擎',
  'loading language traineddata': '加载语言模型',
  'initializing api': '准备识别',
  'recognizing text': '识别中'
};

function ocrBox(text) {
  $('ocrText').value = text || '';
  const has = !!(text || '').trim();
  $('ocrCopy').disabled = !has;
  $('ocrSave').disabled = !has;
  return has;
}

function ocrPanel(open, status) {
  $('ocrPanel').hidden = !open;
  if (status !== undefined) $('ocrStatus').textContent = status;
}

async function runOcr() {
  if (!active) return;
  const box = active.ocrRegion();
  if (!box) {
    ocrPanel(true, '这一段还没有解码完成，稍等一下再试。');
    return;
  }
  const canvas = active.bitmapOf(box);
  ocrBox('');
  ocrPanel(true, '正在启动引擎…');
  $('ocrScope').textContent = `${box.label} ${box.w}×${box.h} px · 占整段 ${Math.max(1, Math.round(((box.w * box.h) / box.total) * 100))}%`;
  try {
    const { text, conf } = await OCR.recognize(canvas, (m) => {
      const label = OCR_STATUS[m.status] || m.status;
      $('ocrStatus').textContent = `${label} ${Math.round((m.progress || 0) * 100)}%`;
    });
    ocrBox(text);
    /* 引擎对深色底、小字都会照输出不误，只有置信度能提前告诉你这段能不能直接用。 */
    if (!text) ocrPanel(true, '这一块里没识别到文字 —— 试试选中更清晰的区域，或先把图放大。');
    else if (conf < 45) ocrPanel(true, `共 ${text.length} 字，但置信度只有 ${conf}%：放大到 100% 以上、只框住文字那一行再认一次。`);
    else ocrPanel(true, `共 ${text.length} 字 · 置信度 ${conf}%${text.length > 2000 ? '，结果较长，可滚动查看' : ''}`);
  } catch (err) {
    ocrPanel(true, `识别失败：${(err && err.message) || err}`);
  }
}

async function saveOcrText() {
  const name = `${String(active.part.name).replace(/\.[a-z]+$/i, '')}-文字-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  const url = URL.createObjectURL(new Blob([$('ocrText').value], { type: 'text/plain;charset=utf-8' }));
  hold(url);
  const state = await downloadDone(await chrome.downloads.download({ url, filename: `LongShot/${name}`, conflictAction: 'uniquify' }));
  notice(state === 'complete' ? `已导出 ${name} 到浏览器下载目录` : `${name} 没有写完（${state}），去 chrome://downloads 看原因`, state !== 'complete');
}

/* -------------------------------------------------------------------- setup */

function createPart(part, index) {
  const editor = createEditor(part, index, {
    host: $('parts'),
    notify: notice,
    onActive: (api) => {
      active = api;
      refresh();
    },
    onState: () => refresh(),
    isActive: (api) => active === api
  });
  active = active || editor;
  editors.push(editor);
  return editor;
}

function render() {
  if (!shot) {
    $('meta').textContent = '没有可显示的结果';
    notice('后台脚本已经重启，上一次截图的内存数据不在了。文件仍保存在磁盘上；要复制或标注请重新截一次。', true);
    return;
  }
  $('meta').textContent = [
    `${shot.parts.length} 个文件`,
    fmtBytes(shot.parts.reduce((sum, part) => sum + (part.bytes || 0), 0)),
    new Date(shot.at).toLocaleString(),
    '拖动即可标注'
  ].join(' · ');
  $('file').hidden = false;
  $('file').textContent = `已保存：${shot.file}`;
  $('copy').disabled = false;
  $('toolbar').hidden = false;
  createToolbar($('toolbar'), toolbarApi);
  for (const [index, part] of shot.parts.entries()) createPart(part, index);
  refresh();
}

$('copy').addEventListener('click', async () => {
  try {
    notice(await copyShot(shot));
  } catch (err) {
    notice(`复制失败：${(err && err.message) || err}`, true);
  }
});

$('copyAnno').addEventListener('click', () => copyAnnotated().catch((err) => notice(`复制标注图失败：${(err && err.message) || err}`, true)));
$('export').addEventListener('click', () => exportFiles().catch((err) => notice(`导出失败：${(err && err.message) || err}`, true)));

$('ocr').addEventListener('click', runOcr);
$('ocrSave').addEventListener('click', () => saveOcrText().catch((err) => notice(`下载失败：${(err && err.message) || err}`, true)));
$('ocrCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('ocrText').value);
    $('ocrStatus').textContent = '已复制到剪贴板';
  } catch (err) {
    notice(`复制文字失败：${(err && err.message) || err}`, true);
  }
});
/* 引擎的 wasm 常驻内存不小，面板一关就把它还给浏览器。 */
$('ocrClose').addEventListener('click', () => {
  ocrPanel(false);
  OCR.release().catch(() => {});
});

async function init() {
  const res = await chrome.runtime.sendMessage({ type: 'LS_GET_SHOT' }).catch(() => null);
  shot = (res && res.shot) || null;
  render();
}

init();
