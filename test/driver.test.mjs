/** Runs the *real* injected page driver (extracted from background.js into
 *  test/harness.js) against the mock DOM and checks the scroll/offset contract
 *  the stitcher relies on: every css row of the page must be covered exactly.
 */
import { readFileSync } from 'node:fs';
import { makePage, raf, getComputedStyle } from './mock-dom.mjs';

const src = readFileSync(new URL('./harness.js', import.meta.url), 'utf8');
const factory = new Function('window', 'document', 'requestAnimationFrame', 'getComputedStyle', `${src}\nreturn longShotHarness;`);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

async function run(page, opts) {
  page.win.__OPTS__ = opts;
  const fn = factory(page.win, page.doc, raf, getComputedStyle);
  return await fn();
}

/* ------------------------------------------------------ document-level page */

console.log('document scroll, 6000px page, 800px viewport, overlap 120');
{
  const page = makePage({ docHeight: 6000, viewport: 800, width: 1200 });
  const r = await run(page, { overlap: 120, waitMs: 10, preload: false, hideFixed: true });

  check('no uncovered gaps', r.gaps.length === 0, r.gaps);
  check('covers whole page', r.covered >= 6000 - 1, r.covered);
  check('step = viewport - overlap', r.all[1].y - r.all[0].y === 680, r.all.slice(0, 3));
  check('frame count', r.frames === Math.ceil((6000 - 800) / 680) + 1, r.frames);
  check('last frame at bottom', r.last.y === 5200, r.last);
  check('done detected on last frame', r.all.length === r.frames);
  check('sticky header hidden', r.hiddenDuringCapture >= 2, r.hiddenDuringCapture);
  check('full-viewport wrapper NOT hidden', page.wrapper.hasAttribute('data-ls-hide') === false);
  check('restore leaves no traces', r.leftoversAfterRestore === 0, r.leftoversAfterRestore);
  check('scroll restored', r.scrollBackTo === 0, r.scrollBackTo);
}

/* ------------------------------------------------------ inner scroll container */

console.log('inner scroll container (app layout)');
{
  const page = makePage({ mode: 'container', docHeight: 4800, viewport: 700, width: 900 });
  const r = await run(page, { overlap: 100, waitMs: 10, preload: false, hideFixed: true });
  check('container scrolled to bottom', r.last.y === 4800 - 700, r.last);
  check('no uncovered gaps', r.gaps.length === 0, r.gaps);
  check('covers whole container', r.covered >= 4800 - 1, r.covered);
  check('step from container height', r.all[1].y - r.all[0].y === 600, r.all.slice(0, 2));
}

/* ------------------------------------------------------ lazy growth + prepass */

console.log('infinite-scroll page (height grows while scrolling), preload on');
{
  const page = makePage({ docHeight: 3000, viewport: 800, width: 1200 });
  const root = page.root;
  let grown = 0;
  Object.defineProperty(root, 'scrollTop', {
    get() {
      return this._st || 0;
    },
    set(v) {
      this._st = v;
      if (v + 800 > this.scrollHeight - 400 && grown < 3) {
        grown++;
        this.scrollHeight += 1200;
      }
    }
  });
  root._st = 0;
  const r = await run(page, { overlap: 120, waitMs: 10, preload: true, hideFixed: true });
  check('prepass triggered growth', r.preDocHeight >= 6600, r.preDocHeight);
  check('no uncovered gaps', r.gaps.length === 0, r.gaps);
  check('capture reached final height', r.covered >= r.preDocHeight - 1, { covered: r.covered, doc: r.preDocHeight });
}

/* ------------------------------------------------------ hand-picked range */

console.log('manual range 1500 -> 4200 on a 6000px page');
{
  const page = makePage({ docHeight: 6000, viewport: 800, width: 1200 });
  const r = await run(page, {
    overlap: 120,
    waitMs: 10,
    preload: false,
    hideFixed: true,
    range: { start: 1500, end: 4200 }
  });
  check('starts at the marked offset', r.first.y === 1500, r.first);
  check('nothing captured above the range', Math.min(...r.all.map((f) => f.y)) === 1500, r.all.map((f) => f.y));
  check('step unchanged inside the range', r.all[1].y - r.all[0].y === 680, r.all.slice(0, 3));
  check('last screen ends exactly at the marked end', r.last.y + r.last.vh === 4200, r.last);
  check('never scrolls past the end', Math.max(...r.all.map((f) => f.y)) === 3400, r.all.map((f) => f.y));
  check('range reported back to the worker', r.meta.range.start === 1500 && r.meta.range.end === 4200, r.meta.range);
  check('scroll restored', r.scrollBackTo === 0, r.scrollBackTo);
}

console.log('marked range shorter than one screen (1500 -> 1900)');
{
  const page = makePage({ docHeight: 6000, viewport: 800, width: 1200 });
  const r = await run(page, { overlap: 120, waitMs: 10, preload: false, hideFixed: true, range: { start: 1500, end: 1900 } });
  check('never scrolls above the marked start', Math.min(...r.all.map((f) => f.y)) === 1500, r.all.map((f) => f.y));
  check('one screen is enough', r.frames === 1, r.all);
}

console.log('framed region 1500 -> 1900 that sat 200 px below the top of the viewport');
{
  const page = makePage({ docHeight: 6000, viewport: 800, width: 1200 });
  const r = await run(page, { overlap: 120, waitMs: 10, preload: false, hideFixed: false, range: { start: 1500, end: 1900, viewTop: 200 } });
  check('captured from where the page stood while dragging', r.first.y === 1300, r.first);
  check('that frame is placed 200 px above the range', r.all[0].y - r.meta.range.start === -200, { y: r.all[0].y, start: r.meta.range.start });
  check('one screen covers the whole box', r.frames === 1, r.all.map((f) => f.y));
  check('never climbs above the pick position', Math.min(...r.all.map((f) => f.y)) === 1300, r.all.map((f) => f.y));
  check('the box still fits inside the captured screen', r.all[0].y + r.all[0].vh >= 1900, r.all[0]);
}

console.log('range that is too small falls back to the whole page');
{
  const page = makePage({ docHeight: 6000, viewport: 800, width: 1200 });
  const r = await run(page, { overlap: 120, waitMs: 10, preload: false, hideFixed: true, range: { start: 1500, end: 1510 } });
  check('no range applied', r.meta.range === null, r.meta.range);
  check('captured from the top', r.first.y === 0, r.first);
}

/* ------------------------------------------------------ short page */

console.log('page shorter than one viewport');
{
  const page = makePage({ docHeight: 600, viewport: 800, width: 1200 });
  const r = await run(page, { overlap: 120, waitMs: 10, preload: true, hideFixed: true });
  check('single frame', r.frames === 1, r.all);
  check('not scrollable', r.meta.scrollable === false);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall driver checks passed');
process.exit(failures ? 1 : 0);
