/** Exercises the annotation core (annotate.js) in Node with a recording canvas:
 *  shape geometry, hit testing, the virtual viewport maths, undo, and what each
 *  tool actually asks the 2d context to do.
 */
import { readFileSync } from 'node:fs';
import { check } from './stitch-env.mjs';

const src = readFileSync(new URL('../long-screenshot/annotate.js', import.meta.url), 'utf8');

const made = [];

function fakeCtx(canvas) {
  return {
    canvas,
    ops: canvas.ops,
    set fillStyle(v) { canvas.props.fillStyle = v; },
    get fillStyle() { return canvas.props.fillStyle; },
    set strokeStyle(v) { canvas.props.strokeStyle = v; },
    get strokeStyle() { return canvas.props.strokeStyle; },
    set lineWidth(v) { canvas.props.lineWidth = v; },
    get lineWidth() { return canvas.props.lineWidth; },
    set font(v) { canvas.props.font = v; },
    get font() { return canvas.props.font; },
    set filter(v) { canvas.props.filter = v; },
    get filter() { return canvas.props.filter; },
    set globalAlpha(v) { canvas.props.globalAlpha = v; },
    set globalCompositeOperation(v) { canvas.props.composite = v; },
    set imageSmoothingEnabled(v) { canvas.props.smooth = v; },
    save() { canvas.ops.push(['save']); },
    restore() { canvas.ops.push(['restore']); },
    setTransform(...a) { canvas.ops.push(['setTransform', ...a]); },
    beginPath() { canvas.ops.push(['beginPath']); },
    moveTo(...a) { canvas.ops.push(['moveTo', ...a]); },
    lineTo(...a) { canvas.ops.push(['lineTo', ...a]); },
    arc(...a) { canvas.ops.push(['arc', ...a]); },
    ellipse(...a) { canvas.ops.push(['ellipse', ...a]); },
    rect(...a) { canvas.ops.push(['rect', ...a]); },
    clip() { canvas.ops.push(['clip']); },
    stroke() { canvas.ops.push(['stroke', { ...canvas.props }]); },
    fill() { canvas.ops.push(['fill', { ...canvas.props }]); },
    fillRect(...a) { canvas.ops.push(['fillRect', ...a]); },
    strokeRect(...a) { canvas.ops.push(['strokeRect', ...a]); },
    fillText(t, x, y) { canvas.ops.push(['fillText', t, x, y, canvas.props.font]); },
    measureText: (t) => ({ width: t.length * 8 }),
    drawImage(...a) {
      const rec = a.length === 9 ? { op: 'draw9', ...pick(a, ['bmp', 'sx', 'sy', 'sw', 'sh', 'dx', 'dy', 'dw', 'dh']) } : { op: 'draw5', bmp: a[0], dx: a[1], dy: a[2], dw: a[3], dh: a[4] };
      rec.srcSize = a[0] && a[0].width !== undefined ? [a[0].width, a[0].height] : null;
      canvas.draws.push(rec);
    }
  };
}

function pick(a, keys) {
  const out = {};
  keys.forEach((k, i) => (out[k] = a[i]));
  return out;
}

function fakeCanvas(tag) {
  const canvas = { tag, width: 0, height: 0, draws: [], ops: [], props: {} };
  canvas.getContext = () => fakeCtx(canvas);
  canvas.toBlob = (cb) => cb({ size: 1234, type: 'image/png' });
  made.push(canvas);
  return canvas;
}

const documentStub = { createElement: (tag) => (tag === 'canvas' ? fakeCanvas(tag) : { style: {}, dataset: {} }) };
const core = new Function('document', 'window', 'requestAnimationFrame', `${src}\nreturn { normalizeBox, makeShape, shapeBox, stepRadius, hitTest, viewWindow, visibleIn, renumber, isUsable, createHistory, flattenSize, drawShape, rasterCanvas, wrapText, TOOLS, clipBox };`)(
  documentStub,
  { devicePixelRatio: 2, innerHeight: 900, addEventListener() {}, removeEventListener() {} },
  () => {}
);

const base = { width: 2400, height: 12000 };

/* ---------------------------------------------------------------- geometry */

console.log('drag maths');
{
  const box = core.normalizeBox({ x: 400, y: 900 }, { x: 120, y: 300 });
  check('a bottom-right to top-left drag still yields a positive rect', box.x === 120 && box.y === 300 && box.w === 280 && box.h === 600, box);

  const rect = core.makeShape('rect', { x: 10, y: 20 }, { x: 60, y: 80 }, { color: '#f00', width: 4 });
  check('rect keeps its box', rect.x === 10 && rect.y === 20 && rect.w === 50 && rect.h === 60, rect);
  const arrow = core.makeShape('arrow', { x: 10, y: 20 }, { x: 60, y: 80 }, { color: '#f00', width: 4 });
  check('arrow keeps its two endpoints', arrow.points.length === 2 && arrow.points[1].x === 60, arrow);
  const mosaic = core.makeShape('mosaic', { x: 0, y: 0 }, { x: 100, y: 40 }, { color: '#f00', width: 4, block: 18 });
  check('mosaic carries the block size', mosaic.size === 18, mosaic);
  const blur = core.makeShape('blur', { x: 0, y: 0 }, { x: 100, y: 40 }, { color: '#f00', width: 4, radius: 9, block: 18 });
  check('blur carries the radius', blur.size === 9, blur);
}

console.log('shape extents');
{
  const pen = { kind: 'pen', width: 6, points: [{ x: 100, y: 50 }, { x: 300, y: 250 }] };
  const b = core.shapeBox(pen);
  check('stroke pad widens the box', b.x === 96 && b.y === 46 && b.w === 208 && b.h === 208, b);
  const step = { kind: 'step', x: 400, y: 300, r: 16, n: 1 };
  check('a badge is centred on its point', core.shapeBox(step).x === 384 && core.shapeBox(step).w === 32, core.shapeBox(step));
}

console.log('hit testing');
{
  const shapes = [{ kind: 'rect', x: 100, y: 100, w: 200, h: 120, width: 4 }, { kind: 'rect', x: 150, y: 130, w: 100, h: 60, width: 4 }];
  check('the topmost shape wins', core.hitTest(shapes, { x: 180, y: 150 }, 4) === 1, core.hitTest(shapes, { x: 180, y: 150 }, 4));
  check('outside both finds nothing', core.hitTest(shapes, { x: 500, y: 500 }, 4) === -1);
  check('tolerance reaches a little past the edge', core.hitTest(shapes, { x: 305, y: 150 }, 8) === 0, core.hitTest(shapes, { x: 305, y: 150 }, 8));
  const line = { kind: 'arrow', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }], width: 4 };
  check('a thin stroke is grabbable a few pixels off', core.hitTest([line], { x: 120, y: 3 }, 2) === 0, core.hitTest([line], { x: 120, y: 3 }, 2));
  check('but not far from the line', core.hitTest([line], { x: 120, y: 60 }, 2) === -1);
}

/* -------------------------------------------------------------- virtual view */

console.log('virtual viewport at dpr 2, zoom 0.5');
{
  /* the canvas is pinned to the top of the viewport while the stage scrolls under it,
   * so the slice start is how far the stage has scrolled, divided by the zoom */
  const win = core.viewWindow({ stageTop: -2000, canvasTop: 0, cssHeight: 800, zoom: 0.5, dpr: 2, imgHeight: 12000 });
  check('scroll offset becomes an image-space slice start', win.sy === 4000, win);
  check('slice height follows the canvas height', win.sh === 1600, win);
  check('device scale = zoom * dpr', win.scale === 1, win);

  const top = core.viewWindow({ stageTop: 100, canvasTop: 100, cssHeight: 800, zoom: 1, dpr: 2, imgHeight: 600 });
  check('an unscrolled canvas starts at the top of the part', top.sy === 0, top);
  check('and never slices past the bottom', top.sh === 600, top);
  const below = core.viewWindow({ stageTop: -99999, canvasTop: 0, cssHeight: 800, zoom: 1, dpr: 2, imgHeight: 600 });
  check('scrolling past the part shows nothing', below.sy === 599 && below.sh === 1, below);

  check('a shape above the slice is culled', core.visibleIn({ kind: 'rect', x: 0, y: 100, w: 10, h: 10 }, win) === false);
  check('a shape inside the slice is painted', core.visibleIn({ kind: 'rect', x: 0, y: 4500, w: 10, h: 10 }, win) === true);
  check('a shape overlapping the top edge is painted', core.visibleIn({ kind: 'rect', x: 0, y: 3950, w: 10, h: 100 }, win) === true);
  check('a shape overlapping the bottom edge is painted', core.visibleIn({ kind: 'rect', x: 0, y: 5590, w: 10, h: 100 }, win) === true);
}

/* ------------------------------------------------------------ shape hygiene */

console.log('what counts as a shape worth keeping');
{
  check('a 3 px drag is discarded', core.isUsable({ kind: 'rect', w: 3, h: 3 }) === false);
  check('a 4 px box is kept', core.isUsable({ kind: 'rect', w: 4, h: 4 }) === true);
  check('a long thin highlight is kept', core.isUsable({ kind: 'hl', points: [{ x: 0, y: 0 }, { x: 300, y: 2 }] }) === true);
  check('a stray pen click is discarded', core.isUsable({ kind: 'pen', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }) === false);
  check('a text placeholder is always kept', core.isUsable({ kind: 'text', w: 0, h: 0 }) === true);
}

console.log('the 字号 slider feeds text and 序号 only');
{
  const style = { color: '#ff3b30', width: 4, block: 14, radius: 10, text: 40, filled: false, tool: 'text' };
  const t = core.makeShape('text', { x: 10, y: 20 }, { x: 10, y: 20 }, style);
  check('a fresh text shape takes the slider value', t.size === 40, t);
  check('and starts out empty', t.text === '', t);
  const m = core.makeShape('mosaic', { x: 0, y: 0 }, { x: 100, y: 50 }, style);
  check('mosaic still uses the block size', m.size === 14, m);
  const b = core.makeShape('blur', { x: 0, y: 0 }, { x: 100, y: 50 }, style);
  check('blur still uses the radius', b.size === 10, b);
  check('a wider font makes a wider badge', core.stepRadius(40) > core.stepRadius(20), [core.stepRadius(40), core.stepRadius(20)]);
  check('but a tiny font still gives a clickable badge', core.stepRadius(4) === 10, core.stepRadius(4));
  check('the badge box follows that radius', core.shapeBox({ kind: 'step', x: 50, y: 60, r: 24 }).w === 48);
}

console.log('序号 numbering stays dense after a delete');
{
  const shapes = [{ kind: 'step', x: 1, y: 1 }, { kind: 'rect', x: 0, y: 0, w: 9, h: 9 }, { kind: 'step', x: 2, y: 2 }, { kind: 'step', x: 3, y: 3 }];
  core.renumber(shapes);
  check('badges run 1..n', shapes.filter((s) => s.kind === 'step').map((s) => s.n).join(',') === '1,2,3');
  shapes.splice(1, 2);
  core.renumber(shapes);
  check('deleting the middle closes the gap', shapes.filter((s) => s.kind === 'step').map((s) => s.n).join(',') === '1,2');
}

/* -------------------------------------------------------------------- undo */

console.log('OCR 取块先夹回图内');
{
  const one = core.clipBox({ x: 10.4, y: 20.8, w: 100.2, h: 50.2 }, 1200, 9000);
  check('起点向下取整，终点向上取整', one.x === 10 && one.y === 20 && one.w === 101 && one.h === 51, one);
  const edge = core.clipBox({ x: 1150, y: 8950, w: 500, h: 500 }, 1200, 9000);
  check('右侧不会超出图宽', edge.x + edge.w === 1200, edge);
  check('下侧不会超出图高', edge.y + edge.h === 9000, edge);
  const gone = core.clipBox({ x: 5000, y: 5000, w: 10, h: 10 }, 1200, 9000);
  check('横向出界只留一条边，纵向仍在图内', gone.x === 1199 && gone.w === 1 && gone.y === 5000 && gone.h === 10, gone);
  const below = core.clipBox({ x: 100, y: 9500, w: 10, h: 10 }, 1200, 9000);
  check('纵向下出界贴到最后一行', below.y === 8999 && below.h === 1, below);
  const zero = core.clipBox({ x: 30, y: 40 }, 1200, 9000);
  check('没有尺寸时留一条边', zero.w === 1 && zero.h === 1, zero);
}

console.log('undo / redo stack');
{
  const h = core.createHistory();
  check('nothing to undo yet', h.canUndo === false && h.canRedo === false);
  h.push([{ kind: 'rect', x: 0, y: 0, w: 9, h: 9 }]);
  const one = [{ kind: 'rect', x: 0, y: 0, w: 9, h: 9 }, { kind: 'rect', x: 1, y: 1, w: 9, h: 9 }];
  h.push(one);
  const two = one.concat([{ kind: 'rect', x: 2, y: 2, w: 9, h: 9 }]);
  const back1 = h.undo(two);
  check('undo returns the previous list', back1.length === 2, back1);
  check('undo is not the same object', back1 !== one);
  const redone = h.redo(back1);
  check('redo brings the third shape back', redone.length === 3, redone);
  h.push(two);
  check('a new edit clears the redo branch', h.canRedo === false);
  const deep = core.createHistory(3);
  for (let i = 0; i < 9; i++) deep.push([{ kind: 'rect', x: i, y: 0, w: 9, h: 9 }]);
  check('the stack is capped', deep.steps === 3, deep.steps);
  let n = 0;
  let cur = null;
  while (deep.canUndo) {
    cur = deep.undo(cur);
    n++;
  }
  check('undo stops at the first step', n === 3 && cur[0].x === 6, { n, x: cur[0].x });
}

/* ------------------------------------------------------------- export size */

console.log('canvas limits during export');
{
  const fit = core.flattenSize(2400, 12000);
  check('a legal part exports at full size', fit.scale === 1 && fit.height === 12000, fit);
  const tall = core.flattenSize(2400, 40000);
  check('an over-tall part is shrunk to 32000', tall.height === 32000 && tall.scale < 1, tall);
  const fat = core.flattenSize(20000, 20000);
  check('an over-large area is shrunk to 96 Mpx', fat.width * fat.height <= 96000000, fat);
  check('width shrinks with height', fat.width === fat.height, fat);
}

/* -------------------------------------------------------------- shape paint */

console.log('stroked kinds');
{
  made.length = 0;
  const c = fakeCanvas();
  const g = c.getContext();
  core.drawShape(g, { kind: 'rect', x: 10, y: 20, w: 100, h: 50, color: '#ff3b30', width: 6 }, base, 2);
  const stroke = c.draws.length;
  check('a plain rect is stroked, never filled', c.ops.some((o) => o[0] === 'strokeRect') && !c.ops.some((o) => o[0] === 'fillRect'), c.ops.map((o) => o[0]));
  check('line width comes from the shape', c.props.lineWidth === 6, c.props.lineWidth);
  check('state is saved and restored around every shape', c.ops[0][0] === 'save' && c.ops[c.ops.length - 1][0] === 'restore');

  made.length = 0;
  const f = fakeCanvas();
  core.drawShape(f.getContext(), { kind: 'rect', x: 10, y: 20, w: 100, h: 50, color: '#2f6bff', width: 6, filled: true }, base, 2);
  check('a filled rect paints a fill', f.ops.some((o) => o[0] === 'fillRect'), f.ops.map((o) => o[0]));

  made.length = 0;
  const a = fakeCanvas();
  core.drawShape(a.getContext(), { kind: 'arrow', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], color: '#111', width: 4 }, base, 1);
  check('an arrow is two strokes (shaft + head)', a.ops.filter((o) => o[0] === 'stroke').length === 2, a.ops.map((o) => o[0]));

  made.length = 0;
  const s = fakeCanvas();
  core.drawShape(s.getContext(), { kind: 'step', x: 50, y: 60, r: 18, n: 4, color: '#ff9500' }, base, 1);
  const label = s.ops.find((o) => o[0] === 'fillText');
  check('the badge draws its number', label && label[1] === '4', label);
  check('the badge is a filled circle', s.ops.some((o) => o[0] === 'arc') && s.ops.some((o) => o[0] === 'fill'));

  made.length = 0;
  const hl = fakeCanvas();
  core.drawShape(hl.getContext(), { kind: 'hl', points: [{ x: 0, y: 0 }, { x: 90, y: 0 }], color: '#ffcc00', width: 6 }, base, 1);
  check('a highlighter multiplies instead of covering', hl.props.composite === 'multiply' && hl.props.globalAlpha === 0.55, hl.props);
  check('and is three times as wide as the pen setting', hl.ops.find((o) => o[0] === 'stroke')[1].lineWidth === 18, hl.props.lineWidth);
}

console.log('text layout');
{
  made.length = 0;
  const c = fakeCanvas();
  const g = c.getContext();
  const lines = core.wrapText(g, 'aaaaaaaaaaaaaaaaaaaa', 64);
  check('long runs wrap at the measure', lines.length === 3 && lines[0].length === 8 && lines[2] === 'aaaa', lines);
  check('hard breaks survive wrapping', core.wrapText(g, 'ab\ncd', 600).length === 2);
  core.drawShape(g, { kind: 'text', x: 4, y: 8, text: 'hello', size: 30, color: '#111' }, base, 1);
  check('the font follows the shape size', /30px/.test(c.props.font), c.props.font);
}

/* ----------------------------------------------------------- raster kinds */

console.log('mosaic');
{
  made.length = 0;
  const c = fakeCanvas();
  const g = c.getContext();
  const shape = { kind: 'mosaic', x: 200, y: 4000, w: 400, h: 200, size: 20 };
  core.drawShape(g, shape, base, 2);
  const art = made[1];
  const small = made[2];
  check('a working canvas is the region at device scale', art.width === 800 && art.height === 400, [art.width, art.height]);
  check('the shrink step is region / block', small.width === 20 && small.height === 10, [small.width, small.height]);
  const grab = small.draws[0];
  check('source is the exact region of the screenshot', grab.sx === 200 && grab.sy === 4000 && grab.sw === 400 && grab.sh === 200, grab);
  check('blow-up is nearest neighbour', art.props.smooth === false, art.props);
  const blit = c.draws[c.draws.length - 1];
  check('the finished tile lands back on its box', blit.dx === 200 && blit.dy === 4000 && blit.dw === 400 && blit.dh === 200, blit);
  check('and is not re-smoothed', c.props.smooth === false, c.props);

  const again = core.rasterCanvas(shape, base, 2);
  check('repeated frames reuse the rendered tile', again.canvas === art);
  core.rasterCanvas({ ...shape, x: 700 }, base, 2);
  check('a shape moved sideways re-renders', made.length > 3, made.length);
  const zoomed = core.rasterCanvas(shape, base, 4);
  check('a different zoom re-renders', zoomed.canvas !== art && zoomed.canvas.width === 1600, [zoomed.canvas.width]);

  const history = core.createHistory();
  let snapshotErr = null;
  try {
    history.push([shape]);
  } catch (err) {
    snapshotErr = String(err && err.message);
  }
  check('a shape holding a rendered tile is still snapshot-able', snapshotErr === null, snapshotErr);
  check('undo restores the shape without a cached tile', history.undo([shape])[0]._cache === undefined);
}

console.log('gaussian blur');
{
  made.length = 0;
  const c = fakeCanvas();
  const g = c.getContext();
  const { canvas: art, pad } = core.rasterCanvas({ kind: 'blur', x: 100, y: 200, w: 300, h: 100, size: 10 }, base, 1);
  check('the blur samples outside the box so the edge is not cut', pad > 10, pad);
  check('and the tile is that much bigger', art.width === 300 + pad * 2 && art.height === 100 + pad * 2, [art.width, art.height]);
  check('radius is applied in device pixels', /blur\(10/.test(art.props.filter), art.props.filter);

  made.length = 0;
  const c2 = fakeCanvas();
  core.drawShape(c2.getContext(), { kind: 'blur', x: 2300, y: 11950, w: 200, h: 100, size: 10 }, base, 1);
  const clipped = c2.ops.filter((o) => o[0] === 'rect')[0];
  check('the blur is clipped to the chosen box', clipped[1] === 2300 && clipped[3] === 200, clipped);
  const art2 = made[1];
  const sampled = art2.draws[0];
  check('sampling never leaves the bitmap', sampled.sx + sampled.sw <= base.width && sampled.sy + sampled.sh <= base.height, sampled);
  const blit2 = c2.draws[0];
  check('the clamped tile is blitted 1:1 instead of stretched', blit2.dx === sampled.sx && blit2.dw === sampled.sw, blit2);
}

console.log('\n' + (check.failed ? `${check.failed} check(s) failed` : 'all annotation checks passed'));
process.exit(check.failed ? 1 : 0);
