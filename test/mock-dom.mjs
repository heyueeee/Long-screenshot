/** Minimal DOM stub: enough for the injected page driver (layout numbers are
 *  hand-set, since a real layout engine is not available in Node).
 */

/** Attach a browser-shaped listener registry to anything (elements, document, window). */
function withEvents(obj) {
  const map = new Map();
  obj.addEventListener = (type, handler) => {
    const list = map.get(type) || [];
    if (!list.includes(handler)) list.push(handler);
    map.set(type, list);
  };
  obj.removeEventListener = (type, handler) => {
    map.set(type, (map.get(type) || []).filter((h) => h !== handler));
  };
  obj.handlers = (type) => (map.get(type) || []).slice();
  return obj;
}

export class El {
  constructor(tag, props = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.style = {};
    this.isConnected = true;
    this.textContent = '';
    this.offsetWidth = props.offsetWidth || 0;
    this.offsetHeight = props.offsetHeight || 0;
    this.id = props.id || '';
    this.scrollTop = props.scrollTop || 0;
    this.scrollHeight = props.scrollHeight || 0;
    this.clientHeight = props.clientHeight || 0;
    this.clientWidth = props.clientWidth || 0;
    this.cs = props.cs || { position: 'static', overflowY: 'visible', visibility: 'visible' };
    this.rect = props.rect || { x: 0, y: 0, width: this.clientWidth, height: this.clientHeight };
    this.complete = true;
    this.naturalWidth = 10;
    withEvents(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  append(...nodes) {
    nodes.forEach((node) => this.appendChild(node));
  }
  remove() {
    this.isConnected = false;
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
  }
  /** Only the attribute selectors the picker itself uses are understood. */
  closest(selector) {
    const name = /^\[([a-z-]+)\]$/.test(selector) ? selector.slice(1, -1) : null;
    for (let node = this; node; node = node.parentNode) {
      if (name ? node.hasAttribute && node.hasAttribute(name) : false) return node;
    }
    return null;
  }
  setPointerCapture() {}
  getBoundingClientRect() {
    return { top: this.rect.y, left: this.rect.x, bottom: this.rect.y + this.rect.height, right: this.rect.x + this.rect.width, width: this.rect.width, height: this.rect.height };
  }
}

/** Build a fake tab: a document-level long page, or an inner scroll container. */
export function makePage({ mode = 'document', docHeight = 6000, viewport = 800, width = 1200, dpr = 2 } = {}) {
  const html = new El('html');
  const body = new El('body');
  const head = new El('head');

  const sticky = new El('div', { rect: { x: 0, y: 0, width, height: 60 }, cs: { position: 'sticky', overflowY: 'visible', visibility: 'visible' } });
  const fab = new El('div', { rect: { x: width - 60, y: viewport - 60, width: 52, height: 52 }, cs: { position: 'fixed', overflowY: 'visible', visibility: 'visible' } });
  const wrapper = new El('div', { rect: { x: 0, y: 0, width, height: viewport }, cs: { position: 'fixed', overflowY: 'visible', visibility: 'visible' } });
  const text = new El('div', { rect: { x: 0, y: 100, width, height: docHeight }, cs: { position: 'static', overflowY: 'visible', visibility: 'visible' } });

  let root;
  const all = [sticky, fab, wrapper, text];

  if (mode === 'container') {
    root = new El('div', {
      scrollHeight: docHeight,
      clientHeight: viewport,
      clientWidth: width,
      cs: { position: 'static', overflowY: 'auto', visibility: 'visible' }
    });
    root.children = [sticky, text];
    root.children.forEach((c) => (c.parentNode = root));
    body.children = [new El('nav'), root];
    body.children.forEach((c) => (c.parentNode = body));
    all.push(root, body.children[0]);
  } else {
    root = html;
    html.scrollHeight = docHeight;
    html.clientHeight = viewport;
    html.clientWidth = width;
    html.cs = { position: 'static', overflowY: 'visible', visibility: 'visible' };
    body.children = [sticky, fab, wrapper, text];
    body.children.forEach((c) => (c.parentNode = body));
  }

  const doc = withEvents({
    documentElement: html,
    body,
    head,
    images: [],
    fonts: { ready: Promise.resolve() },
    visibilityState: 'visible',
    scrollingElement: mode === 'container' ? html : html,
    createElement: (tag) => new El(tag),
    getElementById: (id) => (head.children.find((c) => c.id === id) || null),
    querySelector: (sel) => doc.querySelectorAll(sel)[0] || null,
    querySelectorAll: (sel) => {
      if (sel === 'body *') return flatten(body).filter((el) => el.isConnected);
      if (sel === '[data-ls-root]') return all.filter((el) => el.hasAttribute('data-ls-root'));
      if (sel === '[data-ls-hide]') return all.filter((el) => el.hasAttribute('data-ls-hide') && el.isConnected);
      return [];
    }
  });

  const win = withEvents({
    innerWidth: width,
    innerHeight: viewport,
    devicePixelRatio: dpr,
    scrollY: 0
  });

  return { doc, win, root, html, body, sticky, fab, wrapper, all };
}

/** A page laid out for the region picker: one nested chain the wheel can walk,
 *  plus a sibling column, all sized in *client* coordinates (what
 *  getBoundingClientRect and the pointer events report). The scroll root is the
 *  document element, parked at scrollTop so content offsets must be derived.
 */
export function makePickPage({ width = 1200, viewport = 800, scrollTop = 300, scrollLeft = 0, docHeight = 6000 } = {}) {
  const html = new El('html');
  html.clientWidth = width;
  html.clientHeight = viewport;
  html.scrollHeight = docHeight;
  html.scrollWidth = width;
  html.scrollTop = scrollTop;
  html.scrollLeft = scrollLeft;
  const body = new El('body');
  const head = new El('head');

  const main = new El('main', { rect: { x: 40, y: 0, width: width - 80, height: viewport } });
  const section = new El('section', { rect: { x: 80, y: 40, width: 900, height: 500 } });
  const card = new El('div', { rect: { x: 200, y: 120, width: 400, height: 260 } });
  const btn = new El('button', { rect: { x: 240, y: 300, width: 120, height: 40 } });
  const side = new El('aside', { rect: { x: 1010, y: 40, width: 150, height: 500 } });
  card.appendChild(btn);
  section.appendChild(card);
  main.appendChild(section);
  body.appendChild(main);
  body.appendChild(side);
  html.appendChild(body);

  const nodes = [html, body, main, section, card, btn, side];
  const doc = withEvents({
    documentElement: html,
    body,
    head,
    scrollingElement: html,
    createElement: (tag) => new El(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    elementsFromPoint: (x, y) => hitTest(html, x, y),
    elementFromPoint: (x, y) => hitTest(html, x, y)[0] || html
  });
  const win = withEvents({ innerWidth: width, innerHeight: viewport, devicePixelRatio: 2 });
  win.__LS__ = { root: () => html };

  return { doc, win, root: html, html, body, head, main, section, card, btn, side, nodes };
}

/** Deepest nodes first, later siblings before earlier ones, like the real hit test.
 *  The picker layer covers the viewport but is created at runtime, so it is found by
 *  walking the tree instead of being listed up front.
 */
function hitTest(root, x, y) {
  const seen = [];
  const walk = (el) => {
    for (const child of el.children || []) {
      if (!child.isConnected) continue;
      seen.push(child);
      walk(child);
    }
  };
  walk(root);
  return seen
    .map((el, i) => ({ el, rect: rectOf(el), depth: depthOf(el), i }))
    .filter(({ rect }) => rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)
    .sort((a, b) => b.depth - a.depth || b.i - a.i)
    .map((hit) => hit.el);
}

function rectOf(el) {
  if (el.rect) return el.rect;
  return el.getAttribute && el.getAttribute('data-ls-pick') === 'layer' ? { x: 0, y: 0, width: 100000, height: 100000 } : null;
}

function depthOf(el) {
  let n = el;
  let d = 0;
  while (n.parentNode) {
    n = n.parentNode;
    d++;
  }
  return d;
}

/** Dispatch the way a browser would: target first, then every ancestor, then the
 *  window, so both the layer and the window pointerup listener see one release.
 */
export function fire(target, type, props = {}, { win } = {}) {
  let stopped = false;
  const event = {
    type,
    button: 0,
    buttons: 1,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    deltaY: 0,
    key: '',
    preventDefault() {},
    stopPropagation() {
      stopped = true;
    }
  };
  Object.assign(event, props);
  const chain = [];
  for (let node = target; node; node = node.parentNode) chain.push(node);
  for (const node of chain) {
    for (const handler of node.handlers(type)) {
      handler.call(node, event);
      if (stopped) return event;
    }
  }
  if (win && !stopped) {
    for (const handler of win.handlers(type)) handler.call(win, event);
  }
  return event;
}

function flatten(el) {
  const out = [];
  for (const child of el.children || []) {
    out.push(child);
    out.push(...flatten(child));
  }
  return out;
}

export const raf = (cb) => setTimeout(cb, 0);
export const getComputedStyle = (el) => ({ position: 'static', overflowY: 'visible', visibility: 'visible', ...(el.cs || {}) });
