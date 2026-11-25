/* Long Shot — offscreen document.
 * Receives viewport captures tagged with their absolute scroll offset, collapses
 * screens that repeat (pinned sections), composites what is left into a full-height
 * canvas, and returns the result as data URLs. Only chrome.runtime is available
 * here, so downloading happens in the service worker.
 */

const MAX_CANVAS_HEIGHT = 30000;
const MAX_CANVAS_AREA = 96_000_000;
/* A pinned/scroll-jacked section, or a window the browser stopped repainting, answers with
 * the same viewport while the page keeps scrolling.
 *
 * Only a viewport that did not *change* is a duplicate, so the test is identity, not
 * resemblance. Measured against the two fixtures: consecutive frames of a page that really
 * scrolled differ in 7-13 of 512 row means beyond a hairline threshold, while a stuck
 * viewport differs in none — a ratio threshold ("looks the same") therefore folded feeds
 * whose rows are mostly blank, and no amount of contrast scaling fixes it because the
 * amplitudes were never the problem. The slack of a couple of rows is for the caret and
 * the spinner a pinned block may contain. */
const PROFILE_ROWS = 512;
const PROFILE_COLS = 8;
const PROFILE_ROW_TOLERANCE = 8;
const PROFILE_MAX_DIFF_ROWS = 2;

let state = null;

const FROM_WORKER = new Set(['LS_FRAME', 'LS_RENDER', 'LS_CLOSE']);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  /* runtime.sendMessage is a broadcast: answering a popup status query here would
   * race the service worker and can win, which shows up as 「unknown message」. */
  if (!FROM_WORKER.has(msg && msg.type)) return false;
  handle(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

async function handle(msg) {
  switch (msg && msg.type) {
    case 'LS_FRAME':
      state = state || blank();
      state.frames.push({
        dataUrl: msg.dataUrl,
        offsetY: msg.offsetY,
        viewportCss: Number(msg.viewportCss) || 0,
        frame: msg.frame || null
      });
      return { ok: true };
    case 'LS_RENDER':
      return await render(msg);
    case 'LS_CLOSE':
      state = null;
      return { ok: true };
    default:
      return { ok: false, error: 'unknown message' };
  }
}

function blank() {
  return { frames: [] };
}

/* ------------------------------------------------------------------ render */

async function render(msg) {
  const buffered = (state && state.frames) || [];
  const frames = (msg.frames && msg.frames.length ? msg.frames : buffered).slice();
  state = null;
  if (!frames.length) throw new Error('没有捕获到任何画面');

  frames.sort((a, b) => a.offsetY - b.offsetY);
  const cssWidth = Math.max(1, Number(msg.cssWidth) || 1024);
  // A framed region keeps only a horizontal band of every screen; the vertical part
  // of the region is already handled upstream as a scroll range.
  const crop = cropOf(msg.crop);
  const contentWidth = Math.max(1, Math.round(cssWidth * (crop ? crop.widthRatio : 1)));

  let collapsed = { frames, dropped: 0, screens: 0, repeats: 0, log: [] };
  if (msg.dedupe !== false) {
    collapsed = await collapseRepeatedFrames(frames, { cssWidth, viewportCss: Number(msg.lastViewportCss) || 0, crop });
  }
  const kept = collapsed.frames;
  const lastFrameBottom = kept[kept.length - 1].offsetY + (Number(msg.lastViewportCss) || 0);
  // The dropped screens' scroll distance no longer exists in the output image.
  const docHeightCss = Math.max(1, (Number(msg.docHeightCss) || 0) - collapsed.dropped, lastFrameBottom);

  const layout = planLayout(msg, contentWidth, docHeightCss);
  const messages = [];
  if (collapsed.screens) {
    // Naming the screens makes a wrong call findable: the user can look at exactly those
    // bands of the page instead of guessing at a count.
    const which = (collapsed.log || []).filter((m) => m.folded).map((m) => m.at).join('、');
    messages.push(
      `检测到 ${collapsed.screens} 屏页面没有再前进（已到页尾或吸附回弹）${which ? `，第 ${which} 屏` : ''}，重复的一屏已合并`
    );
  }
  if (collapsed.repeats) {
    const which = (collapsed.log || []).filter((m) => !m.folded).map((m) => m.at).join('、');
    messages.push(
      `检测到 ${collapsed.repeats} 屏画面与上一屏相同但页面仍在滚动${which ? `（第 ${which} 屏）` : ''}：浏览器没有重绘，或整屏被固定区块盖住。已按页面实际上报的位置保留，建议把窗口置于前台或把「每屏等待」调大`
    );
  }
  if (layout.scale < layout.requestedScale - 0.001) {
    messages.push(`长图超出画布上限，已按 ${(layout.scale * 100).toFixed(0)}% 输出`);
  }

  const files = [];
  let thumb = null;
  let holes = 0;
  let longestGap = 0;
  for (let part = 0; part < layout.parts; part++) {
    const top = part * MAX_CANVAS_HEIGHT;
    const height = Math.min(MAX_CANVAS_HEIGHT, layout.totalHeight - top);
    const painted = await drawPart(kept, layout, { cssWidth, viewportCss: Number(msg.lastViewportCss) || 0, crop }, top, height);
    holes += painted.holes;
    longestGap = Math.max(longestGap, painted.longestGap);

    if (part === 0) thumb = thumbnail(painted.canvas);
    // The offscreen document may only use chrome.runtime, so the image leaves as
    // a data URL and the service worker performs the actual download.
    files.push({
      name: layout.parts > 1 ? splitName(msg.fileName, part + 1, layout.parts) : msg.fileName,
      width: painted.canvas.width,
      height: painted.canvas.height,
      dataUrl: toDataURL(painted.canvas, msg.format, msg.quality)
    });
    if (layout.parts > 1) messages.push(`第 ${part + 1}/${layout.parts} 段已渲染`);
    painted.canvas.width = painted.canvas.height = 0;
  }

  // A large uncovered band means the page grew or refused to scroll mid-capture.
  if (longestGap > 8) {
    messages.push(`检测到 ${holes} 行空白（最长连续 ${longestGap} 行），可能有区域未加载完成，建议增大每屏等待时间`);
  }

  return { ok: true, files, thumb, message: messages.filter(Boolean).join('；'), merge: collapsed.log || [] };
}

function planLayout(msg, cssWidth, docHeightCss) {
  const device = Math.min(2, Math.max(1, Number(msg.deviceScale) || 1));
  const requested = msg.scaleMode === 'device' ? device : Math.max(0.2, Number(msg.scaleMode) || 1);
  const byHeight = MAX_CANVAS_HEIGHT / docHeightCss;
  const byArea = Math.sqrt(MAX_CANVAS_AREA / (cssWidth * docHeightCss));
  const scale = Math.max(0.2, Math.min(requested, byHeight, byArea));
  const width = Math.max(1, Math.min(30000, Math.round(cssWidth * scale)));
  const totalHeight = Math.max(1, Math.round(docHeightCss * scale));
  return { scale, width, totalHeight, requestedScale: requested, parts: Math.ceil(totalHeight / MAX_CANVAS_HEIGHT) };
}

function cropOf(crop) {
  if (!crop) return null;
  const xRatio = Math.max(0, Math.min(0.999, Number(crop.xRatio) || 0));
  const widthRatio = Math.max(0.001, Math.min(1 - xRatio, Number(crop.widthRatio) || 1));
  // A band that already spans the full width needs no cropping at all.
  return xRatio > 0.0005 || widthRatio < 0.9995 ? { xRatio, widthRatio } : null;
}

/* The slice of a frame that belongs to the page, in bitmap pixels.
 *
 * A capture spans the whole window — innerWidth wide, classic scrollbar column
 * included — while the output is as wide as the scroll root's content box, so the
 * two only agree once the bitmap is measured against the window it was taken from.
 * Deriving the vertical size from the horizontal squeeze instead would shrink every
 * screen by the scrollbar's share (~1.2% here) while its offset stays unscaled, which
 * is what made the seams wander by a few pixels down the page. */
function sliceOf(bitmap, box, cssWidth, viewportCss, crop) {
  const winW = Math.max(1, Number(box && box.winW) || cssWidth);
  const dev = bitmap.width / winW;
  const boxLeft = Math.max(0, Math.round((Number(box && box.left) || 0) * dev));
  const boxTop = Math.max(0, Math.round((Number(box && box.top) || 0) * dev));
  const keep = Math.max(1, Math.min(bitmap.width - boxLeft, Math.round(cssWidth * dev)));
  const sx = boxLeft + (crop ? Math.round(crop.xRatio * keep) : 0);
  const sw = Math.max(1, Math.min(bitmap.width - sx, crop ? Math.round(crop.widthRatio * keep) : keep));
  const rowsCss = Math.max(1, viewportCss || bitmap.height / dev);
  const sh = Math.max(1, Math.min(bitmap.height - boxTop, Math.round(rowsCss * dev)));
  return { sx, sy: boxTop, sw, sh, full: sx === 0 && boxTop === 0 && sw === bitmap.width && sh === bitmap.height };
}

async function drawPart(frames, layout, source, partTop, partHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = partHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const rows = new Uint8Array(partHeight);
  for (const frame of frames) {
    const y = Math.round(frame.offsetY * layout.scale) - partTop;
    const bitmap = await decode(frame.dataUrl);
    const s = sliceOf(bitmap, frame.frame, source.cssWidth, frame.viewportCss || source.viewportCss, source.crop);
    // Uniform scale: one canvas pixel per source pixel, so nothing is stretched sideways.
    const dh = Math.round(s.sh * (canvas.width / s.sw));
    if (y + dh > 0 && y < partHeight) {
      if (s.full) ctx.drawImage(bitmap, 0, y, canvas.width, dh);
      else ctx.drawImage(bitmap, s.sx, s.sy, s.sw, s.sh, 0, y, canvas.width, dh);
      for (let r = Math.max(0, y); r < Math.min(partHeight, y + dh); r++) rows[r] = 1;
    }
    bitmap.close();
  }

  let holes = 0;
  let longestGap = 0;
  let run = 0;
  for (let r = 0; r < partHeight; r++) {
    if (rows[r]) continue;
    holes++;
    longestGap = Math.max(longestGap, ++run);
  }
  return { canvas, holes, longestGap };
}

/* A repeat is only safe to fold away when the page did not actually move.
 *
 * Folding subtracts the dropped span from every later offset, so a wrong call moves the
 * whole rest of the page up by a screen — rows then appear where they were never rendered,
 * which is far worse than the duplicate it removed. A frame that repeats while the reported
 * offset advanced is therefore kept where it was reported: the band between the two offsets
 * is content the browser never painted (a window that stopped repainting, or a viewport-sized
 * fixed block), and no amount of re-arranging the later frames can recover it. */
const FOLD_MAX_ADVANCE = 4;

/* Drop frames that repeat the previous screen at the same offset (the page reached the
 * bottom, or snap pulled it back), so a run does not draw one band several times. */
async function collapseRepeatedFrames(frames, source) {
  const kept = [];
  let previous = null;
  let previousRaw = null;
  let previousRawY = frames[0].offsetY;
  let dropped = 0;
  let screens = 0;
  let repeats = 0;
  let ordinal = 0;
  const log = [];

  for (const frame of frames) {
    ordinal++;
    // Two captures of an unchanged viewport encode to the same bytes, and that is the
    // whole answer — the profile exists only for the frames an animation makes differ.
    const sameBytes = previousRaw && frame.dataUrl === previousRaw;
    const profile = sameBytes ? null : await rowProfile(frame.dataUrl, frame, source);
    const match = kept.length && !sameBytes ? profilesMatch(previous, profile) : null;
    const repeated = !!kept.length && (sameBytes || (!!match && match.diff >= 0 && match.diff <= PROFILE_MAX_DIFF_ROWS));
    const advance = frame.offsetY - previousRawY;
    if (repeated && advance <= FOLD_MAX_ADVANCE) {
      dropped += advance;
      screens++;
      log.push({ at: ordinal, y: frame.offsetY, advance, diff: sameBytes ? 0 : match.diff, worst: sameBytes ? 0 : match.worst, folded: true });
    } else {
      if (repeated) {
        repeats++;
        log.push({ at: ordinal, y: frame.offsetY, advance, diff: sameBytes ? 0 : match.diff, worst: sameBytes ? 0 : match.worst, folded: false });
      }
      kept.push({ ...frame, offsetY: frame.offsetY - dropped });
      // Byte-identical frames reuse the baseline: their rows are the same by definition,
      // and dropping the baseline here would make the next real screen compare against nothing.
      if (profile) previous = profile;
    }
    previousRaw = frame.dataUrl;
    previousRawY = frame.offsetY;
  }
  return { frames: kept, dropped, screens, repeats, log };
}

/* One luminance sample per slice of the scroll box's height.
 *
 * It samples the *root's* box only: the window a capture spans also carries a static rail
 * and a top bar whose identical rows pull a scrolled screen toward looking unchanged, and it
 * averages across the width so the surviving signal is where the rows of content sit. */
async function rowProfile(dataUrl, frame, source) {
  const bitmap = await decode(dataUrl);
  const s = sliceOf(bitmap, frame.frame, source.cssWidth, frame.viewportCss || source.viewportCss, source.crop);
  const rows = Math.max(1, Math.min(PROFILE_ROWS, s.sh));
  const canvas = document.createElement('canvas');
  canvas.width = PROFILE_COLS;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, s.sx, s.sy, s.sw, s.sh, 0, 0, PROFILE_COLS, rows);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, PROFILE_COLS, rows).data;
  const out = new Uint8Array(rows);
  for (let r = 0; r < rows; r++) {
    let sum = 0;
    for (let c = 0; c < PROFILE_COLS; c++) {
      const i = (r * PROFILE_COLS + c) * 4;
      sum += pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
    }
    out[r] = (sum / PROFILE_COLS) | 0;
  }
  return out;
}

/* Rows that moved decide the call: an unchanged viewport leaves every row where it was,
 * while a page that scrolled puts its content rows somewhere else — even when most of it is
 * blank, because the rows that are not blank are not where they were. */
function profilesMatch(a, b) {
  if (!a || !b || a.length !== b.length) return { diff: -1, worst: 0 };
  let diff = 0;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
    if (d > PROFILE_ROW_TOLERANCE) diff++;
  }
  return { diff, worst };
}

async function decode(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const base64 = dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}
function thumbnail(canvas) {
  const width = Math.min(400, canvas.width);
  // Only the top of the page is shown: a full-height strip of a 15-screen page
  // would scale down to an unreadable sliver inside the popup.
  const sourceHeight = Math.max(1, Math.min(canvas.height, Math.round(canvas.width * 1.4)));
  const height = Math.max(1, Math.round((sourceHeight / canvas.width) * width));
  const small = document.createElement('canvas');
  small.width = width;
  small.height = height;
  const ctx = small.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(canvas, 0, 0, canvas.width, sourceHeight, 0, 0, width, height);
  return small.toDataURL('image/jpeg', 0.72);
}

function toDataURL(canvas, format, quality) {
  const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const dataUrl = canvas.toDataURL(type, type === 'image/jpeg' ? quality || 0.92 : undefined);
  if (!dataUrl || dataUrl.length < 100) throw new Error('图片导出失败');
  return dataUrl;
}

function splitName(fileName, index, total) {
  const dot = fileName.lastIndexOf('.');
  return `${fileName.slice(0, dot)}_part${index}of${total}${fileName.slice(dot)}`;
}
