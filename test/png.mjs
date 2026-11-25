/* PNG reading helpers for the browser checks: dimensions without decoding, and a
 * cheap per-row signature that makes a duplicated screen band obvious. */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

export function pngSize(file) {
  const buf = readFileSync(file);
  if (buf.subarray(1, 4).toString() !== 'PNG') throw new Error(`${file} 不是 PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), depth: buf[24], colorType: buf[25], interlace: buf[28] };
}

/** 8-bit non-interlaced PNG -> { width, height, rgb } where rgb is W*H*3 bytes. */
export function decodeRgb(file) {
  const buf = readFileSync(file);
  const W = buf.readUInt32BE(16);
  const H = buf.readUInt32BE(20);
  const ctype = buf[25];
  if (buf[24] !== 8 || buf[28] !== 0 || ![0, 2, 3, 6].includes(ctype)) {
    throw new Error(`解码器只支持 8-bit 非隔行灰度/RGB/调色板/RGBA，这里是 depth=${buf[24]} colorType=${ctype}`);
  }
  let off = 8;
  const idat = [];
  let palette = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'PLTE') palette = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
  }
  const ch = { 0: 1, 3: 1, 2: 3, 6: 4 }[ctype];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * ch;
  const rgb = Buffer.alloc(H * W * 3);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < H; y += 1) {
    const filter = raw[pos];
    const cur = Buffer.from(raw.subarray(pos + 1, pos + 1 + stride));
    pos += 1 + stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      if (filter === 1) cur[x] = (cur[x] + a) & 255;
      else if (filter === 2) cur[x] = (cur[x] + b) & 255;
      else if (filter === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < W; x += 1) {
      const s = x * ch;
      const d = (y * W + x) * 3;
      if (ctype === 6 || ctype === 2) {
        rgb[d] = cur[s];
        rgb[d + 1] = cur[s + 1];
        rgb[d + 2] = cur[s + 2];
      } else if (ctype === 3) {
        const i = cur[s] * 3;
        rgb[d] = palette[i];
        rgb[d + 1] = palette[i + 1];
        rgb[d + 2] = palette[i + 2];
      } else {
        rgb[d] = rgb[d + 1] = rgb[d + 2] = cur[s];
      }
    }
    prev = cur;
  }
  return { width: W, height: H, rgb };
}

/**
 * One number per row, sampled every `step` pixels. A stitched page repeats a whole
 * screen only when the offsets went wrong, and that shows up as a long stretch where
 * row y equals row y-period, so signatures make it measurable instead of eyeballed.
 */
export function rowSignatures({ width, height, rgb }, step = 24) {
  const out = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    let h = 0;
    for (let x = 0; x < width; x += step) {
      const d = (y * width + x) * 3;
      h = (h * 31 + rgb[d] * 7 + rgb[d + 1] * 3 + rgb[d + 2]) % 2147483647;
    }
    out[y] = h;
  }
  return out;
}

/** Longest run of rows that repeat at a distance near one viewport. */
export function longestRepeat(sig, periodLo, periodHi) {
  let best = { run: 0, period: 0, start: 0 };
  for (let period = periodLo; period <= periodHi; period += 1) {
    let run = 0;
    let runStart = 0;
    for (let y = period; y < sig.length; y += 1) {
      if (sig[y] === sig[y - period] && sig[y] !== sig[(y + 1) % sig.length]) {
        if (run === 0) runStart = y;
        run += 1;
        if (run > best.run) best = { run, period, start: runStart };
      } else run = 0;
    }
  }
  return best;
}

/** Longest run of rows with an identical signature (a fully blank / stuck band). */
export function longestIdenticalRun(sig) {
  let best = 1;
  let run = 1;
  for (let y = 1; y < sig.length; y += 1) {
    run = sig[y] === sig[y - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * How well the top of image A lines up with image B starting near `offset`. Used to
 * prove a 范围 / 区域 result really contains those document rows instead of just
 * happening to be the right height: the best ratio inside a +-tolerance window wins.
 */
export function rowMatch(a, b, offset, tolerance = 60) {
  let best = { ratio: -1, offset: 0, rows: 0 };
  for (let off = Math.max(0, offset - tolerance); off <= offset + tolerance; off += 1) {
    const rows = Math.min(a.length, b.length - off);
    if (rows < 40) continue;
    let same = 0;
    for (let i = 0; i < rows; i += 1) if (a[i] === b[off + i]) same += 1;
    const ratio = same / rows;
    if (ratio > best.ratio) best = { ratio, offset: off, rows };
  }
  return best;
}

/**
 * Paste a horizontally cropped piece back onto the full image near (x, y) and count
 * matching sample points. Row signatures cannot be used for that comparison because
 * cropping moves every sampling column, so pixels are compared directly.
 */
export function cropMatch(crop, full, x, y) {
  let hit = 0;
  let total = 0;
  for (let cy = 0; cy < crop.height; cy += 3) {
    for (let cx = 0; cx < crop.width; cx += 12) {
      const fy = y + cy;
      const fx = x + cx;
      if (fy >= full.height || fx >= full.width) continue;
      const a = (cy * crop.width + cx) * 3;
      const b = (fy * full.width + fx) * 3;
      const near =
        Math.abs(crop.rgb[a] - full.rgb[b]) <= 6 &&
        Math.abs(crop.rgb[a + 1] - full.rgb[b + 1]) <= 6 &&
        Math.abs(crop.rgb[a + 2] - full.rgb[b + 2]) <= 6;
      total += 1;
      if (near) hit += 1;
    }
  }
  return { ratio: total ? hit / total : 0, total, x, y };
}

export function bestCropMatch(crop, full, xGuess, yGuess, tolerance = 8) {
  let best = { ratio: -1 };
  for (let dy = -tolerance; dy <= tolerance; dy += 2) {
    for (let dx = -tolerance; dx <= tolerance; dx += 2) {
      const res = cropMatch(crop, full, Math.max(0, xGuess + dx), Math.max(0, yGuess + dy));
      if (res.ratio > best.ratio) best = res;
    }
  }
  return best;
}

/** JPEG has no fixed header: walk the marker segments to the first SOF for the size.
 *  A segment is marker(2) + length(2, counting itself) + payload, and the SOF payload
 *  is precision(1) + height(2) + width(2) + components(1). */
export function jpegSize(file) {
  const buf = readFileSync(file);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`${file} 不是 JPEG`);
  for (let off = 2; off + 9 < buf.length; off += 2 + buf.readUInt16BE(off + 2)) {
    if (buf[off] !== 0xff) throw new Error('JPEG 分段边界走偏了');
    const marker = buf[off + 1];
    /* SOF0..SOF15 live in 0xc0–0xcf, but 0xc4 is DHT and 0xc8/0xcc are unassigned, and
     * the segment *after* them (0xdb DQT) looks like an SOF if the range runs to 0xdf. */
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), channels: buf[off + 9], marker };
    }
  }
  throw new Error('JPEG 里没找到 SOF 段');
}
