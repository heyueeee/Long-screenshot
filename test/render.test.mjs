import { canvases, check, claim, holesIn, makeFrames, post, scenario, scrollPath } from './stitch-env.mjs';

/** Sizes are read back from the exported data URLs: MARK_<width>x<height>. */
function sizes(files) {
  return files.map((f) => f.dataUrl.match(/MARK_(\d+)x(\d+)/).slice(1, 3).map(Number));
}

/* ---------------------------------------------------------- normal 2x export */

console.log('1200x6000 page, dpr 2');
{
  const res = await scenario('render', { docHeightCss: 6000, frames: makeFrames(scrollPath(6000)) });
  const canvas = canvases[0];
  check('one file returned', res.files.length === 1, res.files.length);
  check('file name', res.files[0].name === 'page.png', res.files[0].name);
  check('file is a png data url', res.files[0].dataUrl.startsWith('data:image/png'), res.files[0].dataUrl.slice(0, 24));
  check('canvas width = cssWidth * 2', canvas.size[0] === 2400, canvas.size);
  check('canvas height = docHeight * 2', canvas.size[1] === 12000, canvas.size);
  check('first frame at y=0', canvas.draws[0].dy === 0, canvas.draws[0].dy);
  check('offset scaled by 2', canvas.draws[2].dy === 2720, canvas.draws[2].dy);
  check('draw order top to bottom', canvas.draws.every((d, i) => i === 0 || d.dy >= canvas.draws[i - 1].dy));
  check('every row painted', holesIn(canvas.draws, canvas.size[1]) === 0, holesIn(canvas.draws, canvas.size[1]));
  check('white background filled first', canvas.fills[0][3] === canvas.size[1], canvas.fills[0]);
  check('bitmaps released', canvas.draws.every((d) => d.bmp.closed));
  check('thumbnail is a jpeg data url', /^data:image\/jpeg/.test(res.thumb), res.thumb);
  const thumbCanvas = canvases[1];
  check(
    'thumbnail crops the page top instead of the whole strip',
    thumbCanvas.size[1] <= Math.round(thumbCanvas.size[0] * 1.5),
    thumbCanvas.size
  );
  check('thumbnail crops from the very top', thumbCanvas.draws[0].sx === 0 && thumbCanvas.draws[0].sy === 0, thumbCanvas.draws[0]);
  check('no warnings', res.message === '', res.message);
}

/* ------------------------------------------------------- scale auto-clamped */

console.log('1200x20000 page, dpr 2 -> height clamp');
{
  const res = await scenario('render', { docHeightCss: 20000, frames: makeFrames(scrollPath(20000)) });
  const canvas = canvases[0];
  check('scale clamped to 1.5', canvas.size[0] === 1800, canvas.size);
  check('still one canvas', canvas.size[1] === 30000, canvas.size);
  check('downscale explained', /150%/.test(res.message), res.message);
  check('every row painted', holesIn(canvas.draws, canvas.size[1]) === 0, holesIn(canvas.draws, canvas.size[1]));
}

/* ------------------------------------------------------------------ 1x mode */

console.log('scale mode 1x');
{
  await scenario('render', { docHeightCss: 2160, frames: makeFrames(scrollPath(2160)), scaleMode: '1' });
  const canvas = canvases[0];
  check('width = cssWidth', canvas.size[0] === 1200, canvas.size);
  check('height = docHeight', canvas.size[1] === 2160, canvas.size);
  check('2x capture downscaled to css width', canvas.draws[0].dw === 1200 && canvas.draws[0].dh === 800, canvas.draws[0]);
  check('every row painted', holesIn(canvas.draws, canvas.size[1]) === 0, holesIn(canvas.draws, canvas.size[1]));
}

/* -------------------------------------------------------- missing frame -> warn */

console.log('frame lost mid-capture -> gap warning');
{
  const ys = scrollPath(6000);
  ys.splice(ys.indexOf(2040), 1);
  const res = await scenario('render', { docHeightCss: 6000, frames: makeFrames(ys) });
  check('gap reported', /空白/.test(res.message), res.message);
  check('gap size matches missing band', /1120/.test(res.message), res.message);
}

/* --------------------------------------------------------------------- parts */

console.log('1200x200000 page -> split into parts');
{
  const res = await scenario('render', {
    docHeightCss: 200000,
    frames: makeFrames(scrollPath(200000), { dpr: 1 }),
    deviceScale: 1
  });
  check('two files returned', res.files.length === 2, res.files.map((f) => f.name));
  check('part naming', res.files.map((f) => f.name).join(','), 'page_part1of2.png,page_part2of2.png');
  const total = sizes(res.files).reduce((acc, s) => acc + s[1], 0);
  check('parts cover full length', total === 40000, sizes(res.files));
  check('parts mentioned in message', /段已渲染/.test(res.message), res.message);
}

/* ----------------------------------------------------------------- framed band */

console.log('a 400 px band of a 1200 px page');
{
  const crop = { xRatio: 100 / 1200, widthRatio: 400 / 1200 };
  const res = await scenario('crop', { docHeightCss: 1000, frames: makeFrames(scrollPath(1000)), crop });
  const canvas = canvases[0];
  check('canvas width follows the band', canvas.size[0] === 800, canvas.size);
  check('canvas height still covers the range', canvas.size[1] === 2000, canvas.size);
  const d = canvas.draws[0];
  check('source rect moved to the band', d.sx === 200 && d.sw === 800, d);
  check('band stretched to the whole canvas width', d.dw === 800 && d.dh === 1600, d);
  check('every row painted', holesIn(canvas.draws, canvas.size[1]) === 0, holesIn(canvas.draws, canvas.size[1]));
  check('width reported for the viewer', res.files[0].width === 800, res.files[0].width);
}

console.log('a band that spans the viewport is not cropped');
{
  await scenario('no crop', { docHeightCss: 1000, frames: makeFrames(scrollPath(1000)), crop: { xRatio: 0, widthRatio: 1 } });
  const canvas = canvases[0];
  check('full width kept', canvas.size[0] === 2400, canvas.size);
  check('plain draw call without a source rect', canvas.draws[0].sx === undefined, canvas.draws[0]);
}

/* ---------------------------------------------- window wider than the page */

console.log('1254 px window, 1239 px content box (classic scrollbar), 1x output');
{
  const doc = 4000;
  const viewport = 807;
  const frames = makeFrames(scrollPath(doc, viewport, 120), { dpr: 1, cssWidth: 1239, viewportCss: viewport, winW: 1254 });
  const res = await scenario('scrollbar column dropped', { cssWidth: 1239, docHeightCss: doc, frames, deviceScale: 1, scaleMode: '1', viewportCss: viewport });
  const canvas = canvases[0];
  const first = canvas.draws[0];
  check('output is the content box width', canvas.size[0] === 1239, canvas.size);
  check('source skips the 15 px scrollbar', first.sx === 0 && first.sw === 1239, first);
  check('a screen keeps its own height instead of the width ratio', first.dh === 807, first);
  check('seam pitch equals the scroll step', canvas.draws[1].dy - canvas.draws[0].dy === 687, canvas.draws.map((d) => d.dy));
  check('every row painted', holesIn(canvas.draws, canvas.size[1]) === 0, holesIn(canvas.draws, canvas.size[1]));
  check('no warnings', res.message === '', res.message);
}

console.log('scroll root is a container behind a 180 px rail and a 48 px bar');
{
  const doc = 4000;
  const viewport = 759;
  const frames = makeFrames(scrollPath(doc, viewport, 120), {
    dpr: 2,
    cssWidth: 1059,
    viewportCss: viewport,
    winW: 1254,
    winH: 807,
    left: 180,
    top: 48
  });
  await scenario('container inset', { cssWidth: 1059, docHeightCss: doc, frames, deviceScale: 2, viewportCss: viewport });
  const canvas = canvases[0];
  const first = canvas.draws[0];
  check('rail cropped out of the source', first.sx === 360, first);
  check('source width is the container, not the window', first.sw === 2118, first);
  check('bar above the container cropped out', first.sy === 96 && first.sh === 1518, first);
  check('height scaled by the same factor as width', first.dh === 1518, first);
  check('canvas is the container width at 2x', canvas.size[0] === 2118, canvas.size);
  check('every row painted', holesIn(canvas.draws, canvas.size[1]) === 0, holesIn(canvas.draws, canvas.size[1]));
}

console.log('a box shorter than one screen keeps exactly its own rows');
{
  const frames = makeFrames([0], { dpr: 2, cssWidth: 1200, viewportCss: 800 });
  await scenario('500 px box on an 800 px screen', { cssWidth: 1200, docHeightCss: 500, frames, deviceScale: 2, viewportCss: 500 });
  const canvas = canvases[0];
  check('canvas is the box, not the screen', canvas.size[1] === 1000, canvas.size);
  check('the frame is clipped by the canvas bottom', canvas.draws[0].dy === 0 && canvas.draws[0].dh === 1600, canvas.draws[0]);
}

/* ---------------------------------------------------------------------- jpeg */

console.log('jpeg export');
{
  const res = await scenario('render', { docHeightCss: 1600, frames: makeFrames(scrollPath(1600)), format: 'jpeg' });
  check('jpg filename', res.files[0].name.endsWith('.jpg'), res.files[0].name);
  check('jpeg mime and quality', res.files[0].dataUrl.startsWith('data:image/jpeg'), res.files[0].dataUrl.slice(0, 20));
}

/* ------------------------------------------------- pinned section collapsing */

/* A page that stopped advancing (bottom clamp, snap rebound) answers twice from the same
 * offset. The second screen cannot add rows, and folding it moves nothing. */
console.log('same offset twice -> folded');
{
  const ys = scrollPath(6000);
  const frames = makeFrames(ys);
  const at = frames.findIndex((f) => f.offsetY === 2040);
  frames.splice(at + 1, 0, { ...frames[at] });
  const res = await scenario('zero advance folded', { docHeightCss: 6000, frames });
  const canvas = canvases[0];
  check('fold reported', /没有再前进/.test(res.message) && /合并/.test(res.message), res.message);
  check('duplicate not drawn again', canvas.draws.length === ys.length, canvas.draws.length);
  check(
    'no later frame moved',
    canvas.draws.map((d) => d.dy).join(',') === ys.map((y) => y * 2).join(','),
    canvas.draws.map((d) => d.dy).slice(at)
  );
  check('height kept', canvas.size[1] === 6000 * 2, canvas.size);
}

/* A viewport that repeats while the page keeps scrolling is a different animal: the band
 * between the two offsets is content the browser never painted. Folding it used to pull
 * every later screen up by a viewport, which is what put rows where they had never been
 * rendered — so the frames stay where the page reported them and the run says so. */
console.log('scroll-jacked section repeats the same screen 5 times');
{
  const pinned = { dataUrl: 'data:image/png;base64,2400x1600#pin', offsetY: 0 };
  const frames = [
    ...makeFrames([0, 680, 1360]),
    ...[2040, 2720, 3400, 4080, 4760].map((y) => ({ ...pinned, offsetY: y })),
    { dataUrl: 'data:image/png;base64,2400x1600#tail', offsetY: 5200 }
  ];
  const res = await scenario('repeats keep their offsets', { docHeightCss: 6000, frames });
  const canvas = canvases[0];
  check('repeat explained instead of folded', /画面与上一屏相同但页面仍在滚动/.test(res.message), res.message);
  check('nothing pulled up', !/合并/.test(res.message), res.message);
  check('every screen drawn', canvas.draws.length === 9, canvas.draws.length);
  check(
    'each screen stays at the offset the page reported',
    canvas.draws.map((d) => d.dy).join(',') === '0,1360,2720,4080,5440,6800,8160,9520,10400',
    canvas.draws.map((d) => d.dy)
  );
  check('image as tall as the document', canvas.size[1] === 6000 * 2, canvas.size);
  check('still no blank rows', holesIn(canvas.draws, canvas.size[1]) === 0, holesIn(canvas.draws, canvas.size[1]));
  check('the repeat is traceable to its screens', /第 5、6、7、8 屏/.test(res.message), res.message);
}

/* A long list of near-identical cards: every screen has the same average tone, so the
 * only thing that tells the frames apart is *where* the divider rows land. A whole feed
 * folded into one screen is the worst failure this module can produce, so the frames must
 * survive even though they are the hardest kind to tell apart. */
console.log('sparse feed: 12 screens of the same cards, only the rules shifted');
{
  const ys = scrollPath(8000);
  const frames = makeFrames(ys, { content: 'feed', phase: (i) => i * 7 });
  const res = await scenario('nothing folded away', { docHeightCss: 8000, frames });
  const canvas = canvases[0];
  check('no merge reported', res.message === '', res.message);
  check('every screen drawn', canvas.draws.length === ys.length, canvas.draws.length);
  check('full height kept', canvas.size[1] === 8000 * 2, canvas.size);
  check('seam pitch follows the scroll step', canvas.draws[1].dy === 680 * 2, canvas.draws.map((d) => d.dy).slice(0, 3));
  check('every row painted', holesIn(canvas.draws, canvas.size[1]) === 0, holesIn(canvas.draws, canvas.size[1]));
}

console.log('collapsing can be turned off');
{
  const pinned = { dataUrl: 'data:image/png;base64,2400x1600#pin', offsetY: 0 };
  const frames = [
    ...makeFrames([0, 680, 1360]),
    ...[2040, 2720, 3400, 4080, 4760].map((y) => ({ ...pinned, offsetY: y })),
    { dataUrl: 'data:image/png;base64,2400x1600#tail', offsetY: 5200 }
  ];
  const res = await scenario('dedupe off', { docHeightCss: 6000, frames, dedupe: false });
  check('nothing reported', res.message === '', res.message);
  check('all frames drawn', canvases[0].draws.length === 9, canvases[0].draws.length);
  check('full height kept', canvases[0].size[1] === 6000 * 2, canvases[0].size);
}

/* --------------------------------------------------------------------- errors */

console.log('failure paths');
{
  await post({ type: 'LS_CLOSE' });
  const res = await post({ type: 'LS_RENDER', cssWidth: 1200, docHeightCss: 1000, fileName: 'x.png' });
  check('empty capture rejected', res.ok === false && /没有捕获/.test(res.error), res.error);
}

console.log('弹窗的状态查询不会被离屏文档抢答');
{
  const mine = await claim({ type: 'LS_RENDER', cssWidth: 1200, docHeightCss: 1000, fileName: 'x.png' });
  check('离屏文档回答并占住自己的消息', mine.answered && mine.claimed, mine);
  const query = await claim({ type: 'LS_STATE' });
  check('状态查询既不回答也不占通道', !query.answered && !query.claimed, query);
  const event = await claim({ type: 'LS_EVENT', state: {} });
  check('进度广播同样留给弹窗', !event.answered && !event.claimed, event);
}

console.log(check.failed ? `\n${check.failed} check(s) failed` : '\nall stitcher checks passed');
process.exit(check.failed ? 1 : 0);
