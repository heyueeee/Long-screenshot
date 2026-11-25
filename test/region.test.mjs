/** Runs the *real* injected region picker (FUNC_REGION, lifted straight out of
 *  background.js) against the mock DOM and checks the three things the stitcher
 *  depends on: content-coordinate offsets, the horizontal band as a fraction of the
 *  scroll root's content box, and a page left exactly as it was found.
 */
import { readFileSync } from 'node:fs';
import { makePickPage, fire } from './mock-dom.mjs';

const src = readFileSync(new URL('../long-screenshot/background.js', import.meta.url), 'utf8');
const at = src.indexOf('const FUNC_REGION = function ()');
const regionSrc = at < 0 ? '' : src.slice(at, src.indexOf('\n};', at) + 3);
if (!regionSrc.includes('elementsFromPoint')) throw new Error('FUNC_REGION extraction failed');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

function open(page) {
  let timer = null;
  const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout', `${regionSrc}\nreturn FUNC_REGION;`)(
    page.win,
    page.doc,
    (cb, ms) => {
      timer = { cb, ms, cleared: false };
      return timer;
    },
    (token) => {
      if (token) token.cleared = true;
    }
  );
  const layer = () => page.body.children[page.body.children.length - 1];
  const part = (kind) => layer().children.find((c) => c.getAttribute('data-ls-pick') === kind);
  return { result: fn(), layer, part, timer: () => timer };
}

function leftovers(page) {
  const pickNodes = page.body.children.filter((c) => c.hasAttribute('data-ls-pick'));
  return {
    layers: pickNodes.length,
    styles: page.head.children.length,
    listeners:
      page.doc.handlers('keydown').length +
      page.win.handlers('pointerup').length +
      (page.body.children.some((c) => c.hasAttribute('data-ls-pick')) ? 1 : 0)
  };
}

/* ------------------------------------------------------------ free rectangle */

console.log('drag a 320 x 270 box while the page sits at scrollTop 300');
{
  const page = makePickPage({ scrollTop: 300 });
  const ui = open(page);
  check('layer attached to the body', ui.layer().getAttribute('data-ls-pick') === 'layer');
  check('style injected in the head', page.head.children.length === 1);

  fire(ui.layer(), 'pointerdown', { clientX: 300, clientY: 200 }, { win: page.win });
  fire(ui.layer(), 'pointermove', { clientX: 620, clientY: 470 }, { win: page.win });
  fire(ui.layer(), 'pointerup', { clientX: 620, clientY: 470 }, { win: page.win });

  const band = ui.part('band');
  check('band becomes visible', band.style.display === 'block', band.style.display);
  check('band sticks to the viewport while the numbers are content space', band.style.left === '300px' && band.style.top === '200px', band.style);
  check('size label matches the drag', ui.part('bar').children[0].textContent === '320 × 270', ui.part('bar').children[0].textContent);
  check('hint hidden once a selection is locked', ui.part('hint').style.display === 'none', ui.part('hint').style.display);

  fire(page.doc, 'keydown', { key: 'Enter' });
  const r = await ui.result;
  check('vertical range in document coordinates', r.top === 500 && r.bottom === 770, r);
  check('the margin above the box inside the viewport is reported', r.viewTop === 200, r);
  check('band measured against the window width', Math.abs(r.xRatio - 0.25) < 1e-9 && Math.abs(r.widthRatio - 320 / 1200) < 1e-9, r);
  check('size reported back', r.width === 320 && r.height === 270, r);
  check('auto-cancel timer cleared', ui.timer().cleared === true);
  check('page restored', leftovers(page).layers === 0 && leftovers(page).styles === 0, leftovers(page));
  check('no listeners left behind', leftovers(page).listeners === 0, leftovers(page));
}

/* ------------------------------------------------- click = whole element */

console.log('press without dragging picks the element under the cursor');
{
  const page = makePickPage({ scrollTop: 300 });
  const ui = open(page);
  fire(ui.layer(), 'pointerdown', { clientX: 250, clientY: 200 }, { win: page.win });
  fire(ui.layer(), 'pointerup', { clientX: 250, clientY: 200 }, { win: page.win });
  fire(page.doc, 'keydown', { key: 'Enter' });
  const r = await ui.result;
  /* card: client x 200..600, y 120..380 -> content y 420..680 */
  check('card edges, not a 0 x 0 box', r.width === 400 && r.height === 260, r);
  check('card range converted through scrollTop', r.top === 420 && r.bottom === 680, r);
  check('card column kept', Math.abs(r.xRatio - 200 / 1200) < 1e-9 && Math.abs(r.widthRatio - 400 / 1200) < 1e-9, r);
}

/* ---------------------------------------------------- wheel walks the chain */

console.log('wheel walks out to the parents and back in to the children');
{
  const page = makePickPage({ scrollTop: 300 });
  const ui = open(page);
  const style = () => ui.part('band').style;
  const show = () => [style().left, style().top, style().width, style().height];

  /* the overlay must never become the selection itself */
  fire(ui.layer(), 'pointermove', { clientX: 300, clientY: 320 }, { win: page.win });
  check('button under the cursor is highlighted', style().left === '240px' && style().top === '300px', show());

  fire(ui.layer(), 'wheel', { clientX: 300, clientY: 320, deltaY: -1 }, { win: page.win });
  check('one notch out = the card', style().left === '200px' && style().height === '260px', show());

  fire(ui.layer(), 'wheel', { clientX: 300, clientY: 320, deltaY: -1 }, { win: page.win });
  check('two notches out = the section', style().left === '80px' && style().width === '900px', show());

  fire(ui.layer(), 'wheel', { clientX: 300, clientY: 320, deltaY: 1 }, { win: page.win });
  check('scrolling back in returns to the card', style().left === '200px' && style().width === '400px', show());

  for (let i = 0; i < 6; i++) fire(ui.layer(), 'wheel', { clientX: 300, clientY: 320, deltaY: -1 }, { win: page.win });
  check('stops at the outermost element', style().left === '40px' && style().width === '1120px', show());

  fire(ui.layer(), 'wheel', { clientX: 300, clientY: 320, deltaY: -1 }, { win: page.win });
  fire(page.doc, 'keydown', { key: 'Escape' });
  check('Escape cancels', (await ui.result) === null);
  check('nothing left behind', leftovers(page).layers === 0 && leftovers(page).styles === 0, leftovers(page));
}

/* ---------------------------------------------------- buttons and timeout */

console.log('toolbar buttons');
{
  const page = makePickPage({ scrollTop: 0 });
  const ui = open(page);
  fire(ui.layer(), 'pointerdown', { clientX: 100, clientY: 100 }, { win: page.win });
  fire(ui.layer(), 'pointerup', { clientX: 500, clientY: 400 }, { win: page.win });
  const bar = ui.part('bar');
  fire(bar.children[2], 'click', {});
  check('取消 drops the selection', (await ui.result) === null);
  check('取消 removes the overlay', leftovers(page).layers === 0, leftovers(page));
}

console.log('nobody touches the page for 5 minutes');
{
  const page = makePickPage({ scrollTop: 0 });
  const ui = open(page);
  check('auto-cancel armed', ui.timer().ms === 300000, ui.timer().ms);
  ui.timer().cb();
  check('auto-cancel resolves as cancelled', (await ui.result) === null);
  check('auto-cancel removes the overlay', leftovers(page).layers === 0 && leftovers(page).styles === 0, leftovers(page));
}

/* --------------------------------------------------------- clamping rules */

console.log('selection that runs past the visible band');
{
  const page = makePickPage({ scrollTop: 300, scrollLeft: 150 });
  const ui = open(page);
  fire(ui.layer(), 'pointerdown', { clientX: 0, clientY: 0 }, { win: page.win });
  fire(ui.layer(), 'pointerup', { clientX: 1400, clientY: 900 }, { win: page.win });
  fire(page.doc, 'keydown', { key: 'Enter' });
  const r = await ui.result;
  check('horizontal band clamped to the viewport', r.xRatio === 0 && r.widthRatio === 1, r);
  check('vertical range clamped to the visible fold', r.top === 300 && r.bottom === 1100, r);
  check('a full-width band needs no crop', r.xRatio <= 0.0005 && r.widthRatio >= 0.9995, r);
}

console.log('a 2 x 2 drag on empty space is not a selection');
{
  const page = makePickPage({ scrollTop: 300 });
  const ui = open(page);
  fire(ui.layer(), 'pointerdown', { clientX: 1180, clientY: 780 }, { win: page.win });
  fire(ui.layer(), 'pointerup', { clientX: 1182, clientY: 782 }, { win: page.win });
  fire(page.doc, 'keydown', { key: 'Enter' });
  check('resolves as cancelled', (await ui.result) === null);
}

/* ------------------------------------------------ inner scroll container */

console.log('scroll root is an inner container offset inside the window');
{
  const page = makePickPage({ scrollTop: 500 });
  const container = page.main;
  container.scrollTop = 500;
  container.scrollLeft = 0;
  container.clientWidth = 1120;
  container.clientHeight = 800;
  container.scrollHeight = 5000;
  page.win.__LS__ = { root: () => container };
  /* the container itself starts at client x 40, y 0 */
  const ui = open(page);
  fire(ui.layer(), 'pointerdown', { clientX: 200, clientY: 100 }, { win: page.win });
  fire(ui.layer(), 'pointerup', { clientX: 600, clientY: 500 }, { win: page.win });
  fire(page.doc, 'keydown', { key: 'Enter' });
  const r = await ui.result;
  check('origin subtracted from the vertical offset', r.top === 600 && r.bottom === 1000, r);
  check('band reported against the container width, not the window', Math.abs(r.xRatio - 160 / 1120) < 1e-9, r);
  check('band width in the same units', Math.abs(r.widthRatio - 400 / 1120) < 1e-9, r);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall region checks passed');
process.exit(failures ? 1 : 0);
