/* Long Shot — annotation layer for the viewer page.

Shapes are stored in the part's own device-pixel space, so a stroke stays glued to
the screenshot no matter how the window is resized or zoomed. The surface is
virtualised: the canvas only ever covers the slice of the (possibly 30 000 px tall)
image that is on screen, and every repaint draws that slice plus the shapes whose
box intersects it.

Everything above the "DOM" marker is pure and unit-tested in Node (test/annotate.test.mjs).
*/

/* ------------------------------------------------------- geometry and state */

const SWATCHES = ['#ff3b30', '#ff9500', '#ffcc00', '#24c05a', '#2f6bff', '#af52de', '#111111', '#ffffff'];
const MIN_SHAPE = 4;
const MAX_CANVAS_AREA = 96000000;
const MAX_CANVAS_SIDE = 32000;
/* Fallback for the sticky header + toolbar height, used before the page has laid out. */
const STICK_TOP = 86;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/** How much of the viewport the sticky header + toolbar eat, measured rather than
 *  guessed because the toolbar wraps into two rows on a narrow window. */
function chromeTop() {
  const bar = document.querySelector('.topbar');
  if (!bar) return STICK_TOP;
  const h = bar.getBoundingClientRect().height;
  return h > 0 ? Math.round(h) : STICK_TOP;
}

/** Any drag direction becomes a positive rectangle. */
function normalizeBox(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** New shape from a drag: boxes keep their rect, freehand kinds keep the points. */
function makeShape(kind, a, b, style) {
  const shape = { kind, ...style };
  if (kind === 'arrow' || kind === 'pen' || kind === 'hl') {
    shape.points = [a, b];
  } else {
    const box = normalizeBox(a, b);
    Object.assign(shape, box);
    if (kind === 'text') {
      shape.text = '';
      shape.size = style.text || 26;
    }
  }
  if (kind === 'mosaic') shape.size = style.block || 14;
  if (kind === 'blur') shape.size = style.radius || 10;
  return shape;
}

/** Badge radius for a 序号 at the given 字号. */
function stepRadius(size) {
  return Math.max(10, Math.round((size || 26) * 0.6));
}

/** Outer edge of a shape including its stroke, in image pixels. */
function shapeBox(shape) {
  const pad = (shape.kind === 'pen' || shape.kind === 'hl' || shape.kind === 'arrow') && !shape.clip ? (shape.width || 4) / 2 + 1 : 0;
  if (shape.points) {
    const xs = shape.points.map((p) => p.x);
    const ys = shape.points.map((p) => p.y);
    return {
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      w: Math.max(...xs) - Math.min(...xs) + pad * 2,
      h: Math.max(...ys) - Math.min(...ys) + pad * 2
    };
  }
  if (shape.kind === 'step') {
    const r = shape.r || 16;
    return { x: shape.x - r, y: shape.y - r, w: r * 2, h: r * 2 };
  }
  return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
}

function inBox(box, p, pad) {
  return p.x >= box.x - pad && p.x <= box.x + box.w + pad && p.y >= box.y - pad && p.y <= box.y + box.h + pad;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Whether a pointer is on the shape; `tol` lets a thin stroke stay grabbable. */
function hitsShape(shape, p, tol) {
  if (shape.kind === 'arrow' || shape.kind === 'pen' || shape.kind === 'hl') {
    for (let i = 1; i < shape.points.length; i++) {
      if (distToSegment(p, shape.points[i - 1], shape.points[i]) <= tol + (shape.width || 4) / 2) return true;
    }
    return false;
  }
  return inBox(shapeBox(shape), p, tol);
}

/** Last drawn wins, so the selection picks what the user actually sees. */
function hitTest(shapes, p, tol) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitsShape(shapes[i], p, tol)) return i;
  }
  return -1;
}

/** Which rows of the part the canvas has to paint right now. */
function viewWindow({ stageTop, canvasTop, cssHeight, zoom, dpr, imgHeight }) {
  const sy = clamp((canvasTop - stageTop) / zoom, 0, Math.max(0, imgHeight - 1));
  const sh = clamp(cssHeight / zoom, 0, imgHeight - sy);
  return { sy, sh, scale: zoom * dpr };
}

/** A shape is worth painting when its box touches the visible slice. */
function visibleIn(shape, win) {
  const box = shapeBox(shape);
  return box.y + box.h >= win.sy && box.y <= win.sy + win.sh;
}

/** 序号 badges always run 1..n, even after one in the middle is deleted. */
function renumber(shapes) {
  let n = 0;
  for (const shape of shapes) if (shape.kind === 'step') shape.n = ++n;
  return shapes;
}

function isUsable(shape) {
  if (shape.kind === 'step' || shape.kind === 'text') return true;
  if (shape.points) {
    const xs = shape.points.map((p) => p.x);
    const ys = shape.points.map((p) => p.y);
    return (
      Math.max(...xs) - Math.min(...xs) >= MIN_SHAPE ||
      Math.max(...ys) - Math.min(...ys) >= MIN_SHAPE ||
      shape.points.length > 3
    );
  }
  return shape.w >= MIN_SHAPE && shape.h >= MIN_SHAPE;
}

/** Snapshot undo: a shape list is a handful of small objects, so copying the whole
 *  array is cheaper to reason about than diffing it. */
function createHistory(limit = 60) {
  const past = [];
  const future = [];
  /* The rendered mosaic/blur tile hangs off the shape as a cache, and a canvas is
   * neither cloneable nor serialisable, so it never goes into a snapshot. */
  const snap = (list) => JSON.stringify(list, (key, value) => (key === '_cache' ? undefined : value));
  return {
    push(snapshot) {
      past.push(snap(snapshot));
      if (past.length > limit) past.shift();
      future.length = 0;
    },
    undo(current) {
      if (!past.length) return null;
      future.push(snap(current));
      return JSON.parse(past.pop());
    },
    redo(current) {
      if (!future.length) return null;
      past.push(snap(current));
      return JSON.parse(future.pop());
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    get steps() {
      return past.length;
    }
  };
}

/** 取整像素并夹回图内：小数偏移会让 drawImage 重采样，OCR 更容易认错小字；
 *  源矩形越界时浏览器是“裁掉再拉伸”，所以这里必须先算准，不能留给 drawImage。 */
function clipBox(box, imgWidth, imgHeight) {
  const x = clamp(Math.floor(box.x), 0, Math.max(0, imgWidth - 1));
  const y = clamp(Math.floor(box.y), 0, Math.max(0, imgHeight - 1));
  const right = clamp(Math.ceil(box.x + (box.w || 0)), 0, imgWidth);
  const bottom = clamp(Math.ceil(box.y + (box.h || 0)), 0, imgHeight);
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

/** A 30 000 px part cannot be flattened at full size, so the export shrinks to fit. */
function flattenSize(width, height) {
  let scale = 1;
  if (height > MAX_CANVAS_SIDE) scale = MAX_CANVAS_SIDE / height;
  if (width * height * scale * scale > MAX_CANVAS_AREA) scale = Math.sqrt(MAX_CANVAS_AREA / (width * height));
  scale = Math.max(0.05, scale);
  /* Rounded up, the result could land a few pixels over the very limit the scale
   * was chosen to respect. */
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}

/* -------------------------------------------------------- shape rendering */

/* Every kind is painted in image-space coordinates; the caller owns the transform.
 * `scale` is how many device pixels one image pixel occupies right now, which is
 * what the raster kinds need in order to produce blocks that stay the same visual
 * size on screen and in the export. */
function drawShape(g, shape, base, scale) {
  const color = shape.color || '#ff3b30';
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = shape.width || 4;
  g.lineJoin = 'round';
  g.lineCap = 'round';

  if (shape.kind === 'rect') {
    if (shape.filled) g.fillRect(shape.x, shape.y, shape.w, shape.h);
    else g.strokeRect(shape.x, shape.y, shape.w, shape.h);
  } else if (shape.kind === 'ellipse') {
    g.beginPath();
    g.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, shape.w / 2, shape.h / 2, 0, 0, Math.PI * 2);
    shape.filled ? g.fill() : g.stroke();
  } else if (shape.kind === 'arrow') {
    drawArrow(g, shape);
  } else if (shape.kind === 'pen') {
    tracePath(g, shape.points);
    g.stroke();
  } else if (shape.kind === 'hl') {
    g.globalCompositeOperation = 'multiply';
    g.globalAlpha = 0.55;
    g.lineWidth = (shape.width || 4) * 3;
    tracePath(g, shape.points);
    g.stroke();
  } else if (shape.kind === 'step') {
    const r = shape.r || 16;
    g.beginPath();
    g.arc(shape.x, shape.y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = `600 ${Math.round(r * 1.2)}px system-ui, "Microsoft YaHei", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(shape.n || 1), shape.x, shape.y + 1);
  } else if (shape.kind === 'text') {
    const size = shape.size || 26;
    g.font = `600 ${size}px system-ui, "Microsoft YaHei", sans-serif`;
    g.textBaseline = 'top';
    const lines = wrapText(g, shape.text || '', shape.maxW || 600);
    lines.forEach((line, i) => g.fillText(line, shape.x, shape.y + i * size * 1.25));
  } else if (shape.kind === 'mosaic') {
    const art = rasterCanvas(shape, base, scale);
    g.imageSmoothingEnabled = false;
    g.drawImage(art.canvas, art.grab.x, art.grab.y, art.grab.w, art.grab.h);
  } else if (shape.kind === 'blur') {
    const art = rasterCanvas(shape, base, scale);
    g.beginPath();
    g.rect(shape.x, shape.y, shape.w, shape.h);
    g.clip();
    g.drawImage(art.canvas, art.grab.x, art.grab.y, art.grab.w, art.grab.h);
  }
  g.restore();
}

function tracePath(g, points) {
  g.beginPath();
  if (!points || !points.length) return;
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
  if (points.length === 1) g.lineTo(points[0].x + 0.01, points[0].y);
}

function drawArrow(g, shape) {
  const a = shape.points[0];
  const b = shape.points[shape.points.length - 1];
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = Math.max(10, (shape.width || 4) * 3.4);
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x - Math.cos(angle) * head * 0.6, b.y - Math.sin(angle) * head * 0.6);
  g.stroke();
  g.beginPath();
  g.moveTo(b.x, b.y);
  g.lineTo(b.x - Math.cos(angle - 0.42) * head, b.y - Math.sin(angle - 0.42) * head);
  g.moveTo(b.x, b.y);
  g.lineTo(b.x - Math.cos(angle + 0.42) * head, b.y - Math.sin(angle + 0.42) * head);
  g.stroke();
}

/* canvas.measureText is the only text layout available, so wrapping asks the
 * context it is about to draw with. */
function wrapText(g, text, maxWidth) {
  const out = [];
  for (const hard of String(text).split('\n')) {
    let line = '';
    for (const ch of hard) {
      if (line && g.measureText(line + ch).width > maxWidth) {
        out.push(line);
        line = ch;
      } else line += ch;
    }
    out.push(line);
  }
  return out;
}

/* Mosaic and blur cannot be vector: they have to read the pixels underneath. The
 * region is rendered into its own canvas at the current device scale and blitted
 * back, which keeps a 30 000 px part from ever needing a full-size working copy. */
function rasterCanvas(shape, base, scale) {
  const s = Math.max(0.05, Math.round(scale * 100) / 100);
  const box = shapeBox(shape);
  const pad = shape.kind === 'blur' ? Math.ceil((shape.size || 10) * 2.2) : 0;
  const key = `${s}|${box.x},${box.y},${box.w},${box.h},${shape.size}`;
  if (shape._cache && shape._cache.key === key) return shape._cache.art;

  const x = clamp(box.x - pad, 0, base.width - 1);
  const y = clamp(box.y - pad, 0, base.height - 1);
  /* Reading past the box is what keeps a blur edge from fading into transparent
   * pixels; the caller clips the result back to the box the user chose. */
  const grab = {
    x,
    y,
    w: Math.max(1, Math.min(base.width - x, box.w + pad * 2 - (x - (box.x - pad)))),
    h: Math.max(1, Math.min(base.height - y, box.h + pad * 2 - (y - (box.y - pad))))
  };
  const w = Math.max(1, Math.round(grab.w * s));
  const h = Math.max(1, Math.round(grab.h * s));

  const art = document.createElement('canvas');
  art.width = w;
  art.height = h;
  const g = art.getContext('2d');
  if (shape.kind === 'mosaic') {
    const block = Math.max(2, Math.round((shape.size || 14) * s));
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(w / block));
    small.height = Math.max(1, Math.round(h / block));
    small.getContext('2d').drawImage(base, grab.x, grab.y, grab.w, grab.h, 0, 0, small.width, small.height);
    g.imageSmoothingEnabled = false;
    g.drawImage(small, 0, 0, small.width, small.height, 0, 0, w, h);
  } else {
    g.filter = `blur(${((shape.size || 10) * s).toFixed(2)}px)`;
    g.drawImage(base, grab.x, grab.y, grab.w, grab.h, 0, 0, w, h);
  }
  const out = { canvas: art, grab, pad };
  shape._cache = { key, art: out };
  return out;
}

/* --------------------------------------------------------------- DOM editor */

const TOOLS = [
  { kind: 'select', label: '选择', hint: '点选已有标注拖动位置，Del 删除' },
  { kind: 'rect', label: '矩形', hint: '拖动画出矩形框' },
  { kind: 'ellipse', label: '椭圆', hint: '拖动画出椭圆' },
  { kind: 'arrow', label: '箭头', hint: '从起点拖到终点' },
  { kind: 'step', label: '序号', hint: '点一下放一个自动递增的编号' },
  { kind: 'text', label: '文字', hint: '点一下开始输入，Esc 取消' },
  { kind: 'pen', label: '画笔', hint: '自由绘制' },
  { kind: 'hl', label: '高亮', hint: '半透明记号笔划过文字' },
  { kind: 'mosaic', label: '马赛克', hint: '拖动把这块区域打格' },
  { kind: 'blur', label: '模糊', hint: '拖动高斯模糊这块区域' }
];

function createToolbar(host, api) {
  host.innerHTML = '';
  const group = (cls) => {
    const el = document.createElement('div');
    el.className = `tGroup ${cls || ''}`;
    host.append(el);
    return el;
  };

  const tools = group('tools');
  const buttons = {};
  for (const tool of TOOLS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = tool.label;
    btn.title = tool.hint;
    btn.addEventListener('click', () => api.setTool(tool.kind));
    tools.append(btn);
    buttons[tool.kind] = btn;
  }

  const style = group('colors');
  for (const color of SWATCHES) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'swatch';
    dot.style.background = color;
    dot.title = color;
    dot.addEventListener('click', () => api.setColor(color));
    style.append(dot);
  }
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'picker';
  picker.value = '#ff3b30';
  picker.addEventListener('input', () => api.setColor(picker.value, true));
  style.append(picker);

  const width = group('width');
  width.append(label('粗细'));
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '1';
  range.max = '24';
  range.value = '4';
  range.addEventListener('input', () => api.setWidth(Number(range.value)));
  width.append(range);

  const soft = group('soft');
  const softLabel = label('强度');
  soft.append(softLabel);
  const strength = document.createElement('input');
  strength.type = 'range';
  strength.min = '4';
  strength.max = '60';
  strength.value = '14';
  strength.addEventListener('input', () => api.setStrength(Number(strength.value)));
  soft.append(strength);

  const zoom = group('zoomBox');
  const zoomLabel = label('适应宽度');
  const mk = (text, fn) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', fn);
    zoom.append(btn);
    return btn;
  };
  mk('－', () => api.setZoomStep(-1));
  zoom.append(zoomLabel);
  mk('＋', () => api.setZoomStep(1));
  mk('100%', () => api.setZoom(1));
  mk('适应', () => api.setZoom(null));

  const acts = group('acts');
  const undo = mk('撤销', () => api.undo());
  const redo = mk('重做', () => api.redo());
  mk('清除本段', () => api.clear());
  const fill = mk('填充', () => api.toggleFill());

  const swatches = [...style.children].filter((el) => el.classList.contains('swatch'));

  function label(text) {
    const el = document.createElement('span');
    el.className = 'tLabel';
    el.textContent = text;
    return el;
  }

  api.paint = (state) => {
    for (const [kind, btn] of Object.entries(buttons)) btn.classList.toggle('on', kind === state.tool);
    for (const dot of swatches) dot.classList.toggle('on', dot.title === state.color);
    if (/^#[0-9a-f]{6}$/i.test(state.color)) picker.value = state.color;
    undo.disabled = !state.canUndo;
    redo.disabled = !state.canRedo;
    fill.classList.toggle('on', !!state.filled);
    fill.disabled = !['rect', 'ellipse'].includes(state.tool);
    zoomLabel.textContent = state.zoomLabel || '';
    range.value = String(state.width || 4);
    const isType = state.tool === 'text' || state.tool === 'step';
    softLabel.textContent = isType ? '字号' : '强度';
    strength.min = isType ? '12' : '4';
    strength.value = String(isType ? state.text || 26 : state.strength || 14);
    /* 粗细 only moves a stroked shape; 强度 feeds the two raster kinds and 字号 the two text ones. */
    strength.disabled = !isType && !(state.tool === 'mosaic' || state.tool === 'blur');
    range.disabled = !['rect', 'ellipse', 'arrow', 'pen', 'hl'].includes(state.tool);
  };
}

function createEditor(part, index, hooks) {
  const figure = document.createElement('figure');
  figure.className = 'ann';

  const stage = document.createElement('div');
  stage.className = 'stage';
  const surface = document.createElement('div');
  surface.className = 'surface';
  const canvas = document.createElement('canvas');
  canvas.className = 'canvas';
  surface.append(canvas);
  const editor = document.createElement('textarea');
  editor.className = 'editor';
  editor.hidden = true;
  editor.spellcheck = false;
  stage.append(surface, editor);

  const caption = document.createElement('figcaption');
  caption.className = 'annCaption';
  caption.textContent = `第 ${index + 1} 段 · ${part.width}×${part.height} px`;
  figure.append(stage, caption);

  const g = canvas.getContext('2d');
  let bitmap = null;
  let shapes = [];
  let draft = null;
  let drag = null;
  let selected = -1;
  let zoom = null;
  let dirty = true;
  const history = createHistory();
  const style = { color: '#ff3b30', width: 4, block: 14, radius: 10, text: 26, filled: false, tool: 'rect' };

  function notify(text, isBad) {
    if (hooks.notify) hooks.notify(text, isBad);
  }

  function imageHeight() {
    return bitmap ? bitmap.height : part.height || 1;
  }

  function imageWidth() {
    return bitmap ? bitmap.width : part.width || 1;
  }

  function fitZoom() {
    const avail = Math.max(120, stage.parentElement.clientWidth || 900);
    return Math.min(1, avail / imageWidth());
  }

  function effZoom() {
    return zoom === null ? fitZoom() : zoom;
  }

  function layout() {
    const z = effZoom();
    const dpr = window.devicePixelRatio || 1;
    const stick = chromeTop();
    const cssW = Math.round(imageWidth() * z);
    const cssH = Math.round(Math.min(imageHeight() * z, Math.max(200, window.innerHeight - stick)));
    stage.style.width = `${cssW}px`;
    stage.style.height = `${Math.round(imageHeight() * z)}px`;
    surface.style.top = `${stick}px`;
    surface.style.height = `${cssH}px`;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    dirty = true;
  }

  function currentWin() {
    const dpr = window.devicePixelRatio || 1;
    const z = effZoom();
    return viewWindow({
      stageTop: stage.getBoundingClientRect().top,
      canvasTop: surface.getBoundingClientRect().top,
      cssHeight: surface.clientHeight || canvas.clientHeight,
      zoom: z,
      dpr,
      imgHeight: imageHeight()
    });
  }

  function repaint() {
    if (!bitmap) return;
    const win = currentWin();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    /* an empty slice means the part has scrolled out of the pinned area entirely */
    if (win.sh < 1) return;
    g.setTransform(win.scale, 0, 0, win.scale, 0, -win.sy * win.scale);
    g.drawImage(bitmap, 0, win.sy, imageWidth(), win.sh, 0, win.sy, imageWidth(), win.sh);
    for (const shape of shapes) if (visibleIn(shape, win)) drawShape(g, shape, bitmap, win.scale);
    if (draft && visibleIn(draft, win)) drawShape(g, draft, bitmap, win.scale);
    if (selected >= 0 && shapes[selected]) outline(g, shapes[selected]);
  }

  function outline(g, shape) {
    const box = shapeBox(shape);
    g.save();
    g.strokeStyle = '#2f6bff';
    g.lineWidth = 1.5 / (effZoom() * (window.devicePixelRatio || 1));
    g.setLineDash([6 / effZoom(), 4 / effZoom()]);
    g.strokeRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4);
    g.restore();
  }

  let queued = false;
  function invalidate() {
    dirty = true;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!dirty) return;
      dirty = false;
      repaint();
    });
  }

  function toImage(e) {
    const rect = canvas.getBoundingClientRect();
    const win = currentWin();
    return { x: (e.clientX - rect.left) / effZoom(), y: win.sy + (e.clientY - rect.top) / effZoom() };
  }

  function commit(next) {
    history.push(shapes);
    shapes = next;
    renumber(shapes);
    sync();
    invalidate();
  }

  function addShape(shape) {
    const next = shapes.concat([shape]);
    selected = next.length - 1;
    commit(next);
  }

  function sync() {
    if (hooks.onState) hooks.onState(api);
  }

  function shift(shape, dx, dy) {
    if (shape.points) return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    if (shape.kind === 'step') return { ...shape, x: shape.x + dx, y: shape.y + dy };
    return { ...shape, x: shape.x + dx, y: shape.y + dy };
  }

  function onDown(e) {
    if (e.button !== 0) return;
    hooks.onActive(api);
    closeEditor();
    const p = toImage(e);
    if (style.tool === 'select') {
      const at = hitTest(shapes, p, 8 / effZoom());
      selected = at;
      if (at < 0) return;
      drag = { mode: 'move', from: p, index: at, before: shapes.slice() };
      canvas.setPointerCapture(e.pointerId);
      invalidate();
      return;
    }
    if (style.tool === 'step') {
      addShape({ kind: 'step', x: p.x, y: p.y, r: stepRadius(style.text), color: style.color, n: shapes.filter((s) => s.kind === 'step').length + 1 });
      return;
    }
    if (style.tool === 'text') {
      const shape = { kind: 'text', x: p.x, y: p.y, w: 0, h: 0, color: style.color, size: style.text || 26, maxW: 600 };
      addShape(shape);
      openEditor(shapes.length - 1);
      return;
    }
    draft = makeShape(style.tool, p, p, style);
    drag = { mode: 'draw', from: p };
    canvas.setPointerCapture(e.pointerId);
    invalidate();
  }

  function onMove(e) {
    if (!drag) return;
    const p = toImage(e);
    if (drag.mode === 'move') {
      const dx = p.x - drag.from.x;
      const dy = p.y - drag.from.y;
      if (!dx && !dy) return;
      const moved = shapes.slice();
      moved[drag.index] = shift(moved[drag.index], dx, dy);
      drag.from = p;
      shapes = moved;
      invalidate();
      return;
    }
    if (style.tool === 'pen' || style.tool === 'hl') {
      const last = draft.points[draft.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) * effZoom() < 2) return;
      draft.points.push(p);
    } else if (draft.points) {
      draft.points[1] = p;
    } else {
      Object.assign(draft, normalizeBox(drag.from, p));
    }
    invalidate();
  }

  function onUp() {
    if (!drag) return;
    if (drag.mode === 'move') {
      history.push(drag.before);
      drag = null;
      sync();
      invalidate();
      return;
    }
    const shape = draft;
    draft = null;
    drag = null;
    if (isUsable(shape)) addShape(shape);
    else invalidate();
  }

  function openEditor(at) {
    const shape = shapes[at];
    if (!shape) return;
    const z = effZoom();
    editor.value = shape.text || '';
    editor.hidden = false;
    /* the box lives inside the stage, which is exactly image size * zoom */
    editor.style.left = `${shape.x * z}px`;
    editor.style.top = `${shape.y * z}px`;
    editor.style.width = `${Math.min(480, Math.max(120, (shape.maxW || 600) * z))}px`;
    editor.style.fontSize = `${Math.max(12, (shape.size || 26) * z)}px`;
    editor.dataset.at = String(at);
    editor.focus();
  }

  function closeEditor() {
    if (editor.hidden) return;
    const at = Number(editor.dataset.at);
    const text = editor.value.trim();
    const shape = shapes[at];
    if (shape && shape.kind === 'text') {
      if (!text) {
        commit(shapes.filter((_, i) => i !== at));
        selected = -1;
      } else if (text !== shape.text) {
        const next = shapes.slice();
        next[at] = { ...shape, text };
        commit(next);
      }
    }
    editor.hidden = true;
    editor.dataset.at = '';
  }

  editor.addEventListener('blur', closeEditor);
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      editor.value = '';
      editor.blur();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      editor.blur();
    }
    e.stopPropagation();
  });

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  function onKey(e) {
    if (!hooks.isActive(api) || !editor.hidden) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? api.redo() : api.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      api.redo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selected < 0) return;
      e.preventDefault();
      api.removeSelected();
    } else if (e.key === 'Escape') {
      selected = -1;
      invalidate();
    }
  }
  document.addEventListener('keydown', onKey);

  const onScroll = () => invalidate();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  const api = {
    index,
    part,
    figure,
    style,
    get shapes() {
      return shapes;
    },
    get selected() {
      return selected;
    },
    get canUndo() {
      return history.canUndo;
    },
    get canRedo() {
      return history.canRedo;
    },
    get annotated() {
      return shapes.length > 0;
    },
    setTool(kind) {
      style.tool = kind;
      /* the cursor belongs to the canvas, which is not a descendant of the toolbar */
      canvas.style.cursor = kind === 'select' ? 'default' : 'crosshair';
      selected = -1;
      sync();
      invalidate();
    },
    setColor(color) {
      style.color = color;
      if (selected >= 0) {
        const next = shapes.slice();
        next[selected] = { ...next[selected], color };
        commit(next);
      }
      sync();
    },
    setWidth(value) {
      style.width = clamp(value, 1, 24);
      if (selected >= 0) {
        const next = shapes.slice();
        next[selected] = { ...next[selected], width: style.width };
        commit(next);
      }
      sync();
    },
    setStrength(value) {
      /* One slider, three meanings. Write only the key the current tool reads, or a
       * mosaic 强度 adjustment would silently reset the 字号. */
      const typed = style.tool === 'text' || style.tool === 'step';
      const v = clamp(Math.round(value), typed ? 12 : 4, 60);
      if (typed) style.text = v;
      else {
        style.block = v;
        style.radius = clamp(Math.round(v * 0.7), 3, 42);
      }
      const sel = shapes[selected];
      const patch =
        !sel ? null
        : sel.kind === 'mosaic' ? { size: style.block }
        : sel.kind === 'blur' ? { size: style.radius }
        : sel.kind === 'text' ? { size: style.text }
        : sel.kind === 'step' ? { r: stepRadius(style.text) }
        : null;
      if (patch && Object.keys(patch).some((key) => sel[key] !== patch[key])) {
        const next = shapes.slice();
        next[selected] = { ...next[selected], ...patch };
        commit(next);
      }
      sync();
    },
    toggleFill() {
      style.filled = !style.filled;
      if (selected >= 0) {
        const next = shapes.slice();
        next[selected] = { ...next[selected], filled: style.filled };
        commit(next);
      }
      sync();
    },
    setZoom(value) {
      zoom = value;
      layout();
      repaint();
      sync();
    },
    setZoomStep(dir) {
      const base = effZoom();
      zoom = clamp(dir > 0 ? base * 1.25 : base / 1.25, 0.05, 4);
      layout();
      repaint();
      sync();
    },
    zoomLabel() {
      return zoom === null ? '适应宽度' : `${Math.round(effZoom() * 100)}%`;
    },
    select(at) {
      selected = at;
      invalidate();
    },
    removeSelected() {
      if (selected < 0) return;
      const next = shapes.slice(0, selected).concat(shapes.slice(selected + 1));
      selected = Math.min(selected, next.length - 1);
      commit(next);
    },
    undo() {
      const prev = history.undo(shapes);
      if (!prev) return;
      shapes = renumber(prev);
      selected = -1;
      sync();
      invalidate();
    },
    redo() {
      const next = history.redo(shapes);
      if (!next) return;
      shapes = renumber(next);
      selected = -1;
      sync();
      invalidate();
    },
    clear() {
      if (!shapes.length) return;
      selected = -1;
      commit([]);
    },
    state() {
      return {
        tool: style.tool,
        color: style.color,
        width: style.width,
        strength: style.block,
        text: style.text,
        filled: style.filled,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        zoomLabel: this.zoomLabel()
      };
    },
    /** 框选中就认那块，否则认贴顶 canvas 当前显示的那一条。 */
    ocrRegion() {
      if (!bitmap) return null;
      const sel = shapes[selected];
      const boxed = !!sel && !sel.points && sel.kind !== 'step';
      if (boxed) {
        const src = clipBox(shapeBox(sel), imageWidth(), imageHeight());
        return { ...src, total: imageWidth() * imageHeight(), label: '选中区域' };
      }
      const win = currentWin();
      if (win.sh < 1) return null;
      const src = clipBox({ x: 0, y: win.sy, w: imageWidth(), h: win.sh }, imageWidth(), imageHeight());
      return { ...src, total: imageWidth() * imageHeight(), label: '当前视口' };
    },
    bitmapOf(box) {
      if (!bitmap) return null;
      const c = document.createElement('canvas');
      c.width = box.w;
      c.height = box.h;
      c.getContext('2d').drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      return c;
    },
    async flatten() {
      if (!bitmap) await ready();
      const size = flattenSize(imageWidth(), imageHeight());
      const out = document.createElement('canvas');
      out.width = size.width;
      out.height = size.height;
      const o = out.getContext('2d');
      o.fillStyle = '#fff';
      o.fillRect(0, 0, size.width, size.height);
      o.setTransform(size.scale, 0, 0, size.scale, 0, 0);
      o.drawImage(bitmap, 0, 0);
      for (const shape of shapes) drawShape(o, shape, bitmap, size.scale);
      const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
      o.setTransform(1, 0, 0, 1, 0, 0);
      out.width = 0;
      out.height = 0;
      if (!blob) throw new Error('浏览器拒绝导出这张图（可能超出了 canvas 尺寸上限）');
      return { blob, scaled: size.scale < 1 ? Math.round(size.scale * 100) : 100 };
    }
  };

  hooks.host.append(figure);

  let ready = async () => {
    const blob = await fetch(part.url).then((res) => {
      if (!res.ok) throw new Error(`结果缓存读取失败（${res.status}）`);
      return res.blob();
    });
    bitmap = await createImageBitmap(blob);
    layout();
    repaint();
    sync();
  };
  ready().catch((err) => notify(`${part.name} 解码失败：${(err && err.message) || err}`, true));

  return api;
}

