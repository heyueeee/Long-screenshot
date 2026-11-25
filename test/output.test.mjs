/** Clipboard rules that are easy to break by accident: Chrome only accepts PNG on
 *  the clipboard, and the write has to keep the click's activation, so a PNG result
 *  is handed over as a pending promise while a JPEG one has to be re-encoded first.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { jpegSize } from './png.mjs';

const src = readFileSync(new URL('../long-screenshot/output.js', import.meta.url), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

function makeEnv(parts) {
  const writes = [];
  const reencoded = [];
  const fetched = [];
  const byUrl = new Map(parts.map((part) => [part.url, part]));

  const fetchStub = (url) =>
    Promise.resolve({
      blob: async () => {
        const part = byUrl.get(url);
        if (!part) throw new Error(`unexpected fetch ${url}`);
        fetched.push(url);
        return { type: part.type, size: part.bytes };
      }
    });

  const canvasStub = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob: (resolve, type) => {
      reencoded.push(type);
      resolve({ type, size: 999 });
    }
  };

  const ClipboardItem = class {
    constructor(types) {
      this.types = types;
    }
  };

  const scope = {
    fetch: fetchStub,
    createImageBitmap: async () => ({ width: 2400, height: 7040, close: () => {} }),
    document: { createElement: () => canvasStub },
    ClipboardItem,
    navigator: { clipboard: { write: (items) => { writes.push(items); return Promise.resolve(); } } }
  };
  const names = Object.keys(scope);
  const api = new Function(...names, `${src}; return { copyShot };`)(...names.map((n) => scope[n]));
  return { ...api, writes, reencoded, fetched };
}

const shotOf = (...types) => ({
  at: 1,
  file: 'page.png',
  parts: types.map((type, i) => ({ url: `blob:ext/part${i}`, type, bytes: 1000 + i, name: `part${i}` }))
});

console.log('png result is copied without re-encoding');
{
  const shot = shotOf('image/png');
  const env = makeEnv(shot.parts);
  const text = await env.copyShot(shot);
  const item = env.writes[0][0];
  const value = item.types['image/png'];
  check('one clipboard item', env.writes.length === 1 && !!item);
  check('handed over as a pending promise', value instanceof Promise, typeof value);
  check('nothing was re-encoded', env.reencoded.length === 0, env.reencoded);
  check('says it copied', /剪贴板/.test(text), text);
  check('resolves to the png blob', (await value).type === 'image/png');
}

console.log('jpeg result is converted to png first');
{
  const shot = shotOf('image/jpeg');
  const env = makeEnv(shot.parts);
  await env.copyShot(shot);
  const value = env.writes[0][0].types['image/png'];
  check('re-encoded as png', env.reencoded.join(',') === 'image/png', env.reencoded);
  check('clipboard got the converted blob', value && value.type === 'image/png', value);
}

console.log('multi-part export');
{
  const shot = shotOf('image/png', 'image/png', 'image/png');
  const env = makeEnv(shot.parts);
  const text = await env.copyShot(shot);
  check('copies only the first segment', env.fetched.join(',') === 'blob:ext/part0', env.fetched);
  check('tells the user only part 1 of 3 went in', /第 1 \/ 3 段/.test(text), text);
}

console.log('empty shot');
{
  const env = makeEnv([]);
  const err = await env.copyShot(null).catch((e) => e.message);
  check('rejected with a readable reason', /没有可复制/.test(err || ''), err);
}

console.log('JPEG header parser (what the end-to-end measurements trust)');
{
  /* Edge paints the quantiser tables before the frame header, so a parser that reads
   * the SOF range as 0xc0-0xdf mistakes DQT (0xdb) for a start-of-frame and reports
   * the quantiser bytes as the image size. */
  const seg = (marker, body) => Buffer.concat([Buffer.from([0xff, marker]), uint16(body.length + 2), body]);
  const uint16 = (v) => Buffer.from([v >> 8, v & 0xff]);
  const dqt = Buffer.concat([Buffer.from([0x15]), Buffer.alloc(48, 0x40)]);
  const sof = Buffer.from([8, 0x5a, 0x80, 0x09, 0xae, 3]);
  const file = `${process.env.TEMP || '/tmp'}/ls-jpeg-header.jpg`;
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'ascii'), Buffer.alloc(9)])), seg(0xdb, dqt), seg(0xc0, sof)]));
  const size = jpegSize(file);
  check('reads 23168 px of height past a DQT table', size.height === 23168 && size.width === 2478 && size.channels === 3, size);
  check('names the marker it stopped at', size.marker === 0xc0, size.marker);
}

console.log(failures ? `${failures} clipboard check(s) failed` : 'all clipboard checks passed');
process.exit(failures ? 1 : 0);
