/** Fake browser environment for long-screenshot/offscreen.js: a canvas that only
 *  records draw calls plus base64 decode, and the chrome.runtime message channel.
 *  Enough to assert stitching geometry.
 */
import { readFileSync } from 'node:fs';

const offscreenSrc = readFileSync(new URL('../long-screenshot/offscreen.js', import.meta.url), 'utf8');

export const canvases = [];

const PROFILE_COLS = 8;
/* Rows that carry a dark rule every RULE_EVERY-th one, offset by the frame's "~phase":
 * content that differs only in *where* it sits, which a coarse blur cannot see. */
const RULE_EVERY = 24;

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    draws: [],
    fills: [],
    lastDraw: null,
    getContext() {
      // offscreen.js zeroes width/height after exporting, so snapshot the size now
      canvas.size = [canvas.width, canvas.height];
      // the per-row profile canvases are noise for the geometry assertions
      if (canvas.width !== PROFILE_COLS) canvases.push(canvas);
      return {
        fillStyle: '',
        imageSmoothingEnabled: false,
        imageSmoothingQuality: '',
        fillRect: (x, y, w, h) => canvas.fills.push([x, y, w, h]),
        drawImage: (...a) => {
          const record =
            a.length === 9
              ? { bmp: a[0], sx: a[1], sy: a[2], sw: a[3], sh: a[4], dx: a[5], dy: a[6], dw: a[7], dh: a[8] }
              : { bmp: a[0], dx: a[1], dy: a[2], dw: a[3], dh: a[4] };
          canvas.draws.push(record);
          canvas.lastDraw = record;
        },
        // Frames are stamped with their content: "#token" identifies the pixels and an
        // optional "~phase" paints a dark rule every RULE_EVERY-th row. Two frames with
        // the same token but different phases are the sparse-page case — equal when
        // blurred, different row by row — so the profile has to tell them apart.
        getImageData: (x, y, w, h) => {
          const id = canvas.lastDraw && canvas.lastDraw.bmp ? String(canvas.lastDraw.bmp.id) : '';
          let acc = 7;
          const mark = id.replace(/~-?\d+/, '');
          for (let i = 0; i < mark.length; i++) acc = (acc * 31 + mark.charCodeAt(i)) % 65521;
          const base = (acc % 8) * 30;
          const phase = Number(((/~(-?\d+)/.exec(id) || [0, 0])[1]));
          const data = new Uint8Array(w * h * 4);
          for (let r = 0; r < h; r++) {
            const rule = (r - phase) % RULE_EVERY === 0;
            const value = rule ? 40 : base;
            for (let c = 0; c < w; c++) {
              const i = (r * w + c) * 4;
              data[i] = value;
              data[i + 1] = value;
              data[i + 2] = value;
              data[i + 3] = 255;
            }
          }
          return { data };
        }
      };
    },
    toDataURL(type, quality) {
      canvas.type = type;
      canvas.quality = quality;
      // padded so it clears the "export produced nothing" sanity check in offscreen.js
      return `data:${type};base64,MARK_${canvas.size.join('x')}_${'A'.repeat(200)}`;
    }
  };
  return canvas;
}

let handler = null;
const chromeStub = {
  runtime: { onMessage: { addListener: (fn) => (handler = fn) }, sendMessage: async () => ({}) }
};

const documentStub = {
  createElement: (tag) => (tag === 'canvas' ? fakeCanvas() : { style: {}, appendChild() {}, remove() {} })
};

/** Frame payloads encode their pixel size in the "base64" body: "1200x800". */
const atobStub = (b64) => 'meta:' + b64;
class BlobStub {
  constructor(parts) {
    this.text = String.fromCharCode.apply(null, Array.from(parts[0]));
  }
}
const bitmapStub = async (blob) => {
  const dims = /(\d+)x(\d+)/.exec(blob.text);
  return { width: Number(dims[1]), height: Number(dims[2]), id: blob.text, closed: false, close() { this.closed = true; } };
};

new Function('chrome', 'document', 'atob', 'Blob', 'createImageBitmap', offscreenSrc)(
  chromeStub,
  documentStub,
  atobStub,
  BlobStub,
  bitmapStub
);

export const post = (msg) => new Promise((resolve) => handler(msg, {}, resolve));

/** runtime.sendMessage reaches every extension context, and the first listener that
 *  answers wins. Report whether this document answers and whether it claims the
 *  channel, so messages owned by the service worker can be proven to be ignored. */
export const claim = (msg) =>
  new Promise((resolve) => {
    let answered = false;
    const keepOpen = handler(msg, {}, () => {
      answered = true;
    });
    setTimeout(() => resolve({ answered, claimed: keepOpen === true }), 30);
  });

/** Frames encode their pixel size and content identity in the "base64" body:
 *  "1200x1600#3" — same trailing token means the same pixels.
 *  `winW` is the CSS width the capture really spans, which is wider than the page
 *  whenever a classic scrollbar takes part of it.
 *  `content` overrides the token (every frame the same = a repetitive feed) and
 *  `phase` paints its dark rules at a given row offset, which is how a page that
 *  scrolled but looks the same everywhere is told apart from one that stuck. */
export function makeFrames(scrollYs, { dpr = 2, cssWidth = 1200, viewportCss = 800, winW = 0, winH = 0, left = 0, top = 0, content = null, phase = null } = {}) {
  const boxW = Math.max(winW || 0, cssWidth);
  const boxH = Math.max(winH || 0, viewportCss + top);
  return scrollYs.map((y, i) => ({
    dataUrl: `data:image/png;base64,${Math.round(boxW * dpr)}x${Math.round(boxH * dpr)}#${content === null ? i : content}${phase === null ? '' : '~' + (typeof phase === 'function' ? phase(i, y) : phase)}`,
    offsetY: y,
    viewportCss,
    frame: winW || left || top ? { winW: boxW, left, top } : null
  }));
}

/** The scroll path the real driver produces: fixed step, then a clamped final offset. */
export function scrollPath(doc, viewport = 800, overlap = 120) {
  const step = viewport - overlap;
  const max = Math.max(0, doc - viewport);
  const ys = [];
  for (let y = 0; y < max; y += step) ys.push(y);
  ys.push(max);
  return ys;
}

export function holesIn(draws, height) {
  const rows = new Uint8Array(height);
  for (const d of draws) {
    const from = Math.max(0, Math.round(d.dy));
    const to = Math.min(height, Math.round(d.dy + d.dh));
    for (let y = from; y < to; y++) rows[y] = 1;
  }
  let holes = 0;
  for (let y = 0; y < height; y++) if (!rows[y]) holes++;
  return holes;
}

export async function scenario(title, cfg) {
  console.log(title);
  canvases.length = 0;
  await post({ type: 'LS_CLOSE' });
  for (const f of cfg.frames) {
    await post({ type: 'LS_FRAME', dataUrl: f.dataUrl, offsetY: f.offsetY, viewportCss: f.viewportCss, frame: f.frame });
  }
  const res = await post({
    type: 'LS_RENDER',
    cssWidth: cfg.cssWidth || 1200,
    docHeightCss: cfg.docHeightCss,
    lastViewportCss: cfg.viewportCss || 800,
    deviceScale: cfg.deviceScale || 2,
    scaleMode: cfg.scaleMode || 'device',
    format: cfg.format || 'png',
    fileName: `page.${cfg.format === 'jpeg' ? 'jpg' : 'png'}`,
    dedupe: cfg.dedupe !== false,
    crop: cfg.crop || null,
    saveAs: false,
    quality: 0.9
  });
  check('render ok', res.ok === true, res.error);
  return res;
}

export function check(name, cond, detail) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    check.failed++;
    console.log('  FAIL ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''));
  }
}
check.failed = 0;
