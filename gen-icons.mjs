import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const S = 512;
const img = new Float64Array(S * S * 4);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const cov = (sd, w = 2.2) => clamp01(0.5 - sd / w);

function roundRectSDF(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

/** Signed distance for a convex polygon; vertices may be in either winding. */
function polySDF(x, y, pts) {
  let best = -1e9;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const ex = x2 - x1;
    const ey = y2 - y1;
    const len = Math.hypot(ex, ey) || 1;
    best = Math.max(best, -(-(ey / len) * (x - x1) + (ex / len) * (y - y1)));
  }
  return best;
}

const lerp = (a, b, t) => a + (b - a) * t;
const TOP = [0x5b, 0x8c, 0xff];
const BOTTOM = [0x2b, 0x3c, 0xa8];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // premultiplied accumulators
    let pr = 0, pg = 0, pb = 0, pa = 0;

    const paint = (sd, col, alpha = 1) => {
      const c = cov(sd) * alpha;
      if (c <= 0) return;
      pr = col[0] * c + pr * (1 - c);
      pg = col[1] * c + pg * (1 - c);
      pb = col[2] * c + pb * (1 - c);
      pa = c + pa * (1 - c);
    };

    paint(roundRectSDF(x, y, 256, 256, 250, 250, 92), [
      lerp(TOP[0], BOTTOM[0], y / S),
      lerp(TOP[1], BOTTOM[1], y / S),
      lerp(TOP[2], BOTTOM[2], y / S)
    ]);
    paint(roundRectSDF(x, y, 256, 186, 92, 140, 16), [255, 255, 255]);
    for (const ly of [104, 144, 184, 224]) paint(roundRectSDF(x, y, 256, ly, 56, 6, 3), [47, 107, 255], 0.9);
    paint(roundRectSDF(x, y, 256, 352, 14, 30, 7), [255, 255, 255]);
    paint(polySDF(x, y, [[256, 446], [194, 374], [318, 374]]), [255, 255, 255]);

    const i = (y * S + x) * 4;
    const straight = pa > 0 ? 1 / (pa * 255) : 0;
    img[i] = clamp01(pr * straight) * 255;
    img[i + 1] = clamp01(pg * straight) * 255;
    img[i + 2] = clamp01(pb * straight) * 255;
    img[i + 3] = pa * 255;
  }
}

/* ---------------------------------------------------------------- PNG encode */

const table = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c >>> 0;
}
const crc = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

function encode(target) {
  const step = S / target;
  const raw = Buffer.alloc(target * (target * 4 + 1));
  for (let ty = 0; ty < target; ty++) {
    for (let tx = 0; tx < target; tx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = 0; sy < step; sy++) {
        for (let sx = 0; sx < step; sx++) {
          const px = Math.min(S - 1, tx * step + sx);
          const py = Math.min(S - 1, ty * step + sy);
          const i = (py * S + px) * 4;
          r += img[i];
          g += img[i + 1];
          b += img[i + 2];
          a += img[i + 3];
          n++;
        }
      }
      const o = ty * (target * 4 + 1) + 1 + tx * 4;
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
      raw[o + 3] = Math.round(a / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(target, 0);
  ihdr.writeUInt32BE(target, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

mkdirSync(new URL('./long-screenshot/icons/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(new URL(`./long-screenshot/icons/icon${size}.png`, import.meta.url), encode(size));
  console.log('icon' + size + '.png');
}
