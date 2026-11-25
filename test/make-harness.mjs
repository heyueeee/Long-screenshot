/** Build test/harness.js: the real page driver extracted from background.js,
 *  driven by a scripted replica of the background loop so the scroll/offset math
 *  can be checked in a plain browser tab without the extension APIs.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../long-screenshot/background.js', import.meta.url), 'utf8');
const marker = '/* ------------------------------------------- page driver (isolated world) */';
const driver = src.slice(src.indexOf(marker) + marker.length);
if (!driver.includes('FUNC_INSTALL') || !driver.includes('FUNC_CALL')) {
  throw new Error('driver extraction failed');
}

const body = `
  const opts = { overlap: 120, waitMs: 180, hideFixed: true, preload: true, ...(window.__OPTS__ || {}) };
  const t0 = Date.now();
  const meta = await FUNC_INSTALL(opts);
  const pre = meta.scrollable && opts.preload ? await FUNC_CALL('prepass', opts) : { docHeight: meta.docHeight };
  const frames = [];
  for (let i = 0; i < 400; i++) {
    const step = await FUNC_CALL('step', opts);
    if (step.error) return { error: step.error };
    frames.push({ y: Math.round(step.scrollY), vh: Math.round(step.viewport), doc: Math.round(step.docHeight), w: Math.round(step.cssWidth) });
    window.__PROGRESS__ = frames.length;
    if (step.done) break;
  }
  const hiddenDuringCapture = document.querySelectorAll('[data-ls-hide]').length;
  await FUNC_CALL('restore', {});

  let covered = 0;
  const gaps = [];
  for (const f of frames) {
    if (f.y > covered + 1) gaps.push([covered, f.y]);
    covered = Math.max(covered, f.y + f.vh);
  }
  return {
    meta,
    preDocHeight: pre.docHeight,
    frames: frames.length,
    first: frames[0],
    last: frames[frames.length - 1],
    covered: Math.round(covered),
    gaps,
    all: frames,
    overlapPx: frames.length > 1 ? Math.round(frames[1].vh - (frames[1].y - frames[0].y)) : null,
    hiddenDuringCapture,
    leftoversAfterRestore: document.querySelectorAll('[data-ls-hide],[data-ls-root]').length + (document.getElementById('__ls_style') ? 1 : 0),
    scrollBackTo: Math.round((document.scrollingElement || document.documentElement).scrollTop),
    ms: Date.now() - t0
  };
`;

writeFileSync(
  new URL('./harness.js', import.meta.url),
  `async function longShotHarness() {\n${driver}\n${body}\n}\n`,
  'utf8'
);
console.log('harness.js written');
