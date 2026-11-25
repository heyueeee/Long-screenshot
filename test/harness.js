async function longShotHarness() {


const FUNC_INSTALL = async function (opts) {
  if (!window.__LS__) {
    const LS = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /** The element that actually scrolls: the document, or an inner overflow container. */
    LS.findRoot = function () {
      let best = document.scrollingElement || document.documentElement;
      let bestRange = (best.scrollHeight || 0) - (best.clientHeight || 0);
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length < 2) continue;
        const cs = getComputedStyle(el);
        if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
        const range = el.scrollHeight - el.clientHeight;
        if (range > bestRange + 40) {
          bestRange = range;
          best = el;
        }
      }
      return best;
    };

    LS.root = function () {
      let el = document.querySelector('[data-ls-root]');
      if (!el || !el.isConnected) {
        el = LS.findRoot();
        el.setAttribute('data-ls-root', '1');
      }
      return el;
    };

    /** visibility (not display) so the layout flow stays byte-identical between frames. */
    LS.hideOverlays = function () {
      if (!document.getElementById('__ls_style')) {
        const style = document.createElement('style');
        style.id = '__ls_style';
        style.textContent = '[data-ls-hide]{visibility:hidden !important}';
        (document.head || document.documentElement).appendChild(style);
      }
      const vw = window.innerWidth || 800;
      const vh = window.innerHeight || 600;
      for (const el of document.querySelectorAll('body *')) {
        if (el.hasAttribute('data-ls-hide') || el.hasAttribute('data-ls-root')) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        // A fixed/sticky box covering the whole viewport is a page wrapper, not an overlay.
        if (r.width > vw * 0.9 && r.height > vh * 0.9) continue;
        el.setAttribute('data-ls-hide', '1');
      }
    };

    /* The rows the shutter sees must be the rows the reported offset describes. A page is
     * free to move them under us: `scroll-behavior:smooth` turns every write into an
     * animation, snap points pull the settled value to the nearest element, and scroll
     * anchoring shifts scrollTop once lazy content above the viewport finishes loading.
     * Each of those makes the capture show a different band than the one being stitched,
     * which reads as 「截到了不该在这里的内容」. None of them touch layout, so switching
     * them off changes the pixels not at all — only where the page sits. */
    LS.pinRules = 'html,body,[data-ls-pin],[data-ls-root]{scroll-behavior:auto !important;scroll-snap-type:none !important;overflow-anchor:none !important}';
    LS.pin = function (root) {
      if (!document.getElementById('__ls_pin')) {
        const style = document.createElement('style');
        style.id = '__ls_pin';
        style.textContent = LS.pinRules;
        (document.head || document.documentElement).appendChild(style);
      }
      if (root && !root.hasAttribute('data-ls-pin')) root.setAttribute('data-ls-pin', '1');
    };

    /* Scroll is only trustworthy once it has stopped: two reads in a row at the same
     * value, so an animation still running cannot be mistaken for a settled page. */
    LS.waitStill = async function (maxMs) {
      const root = LS.root();
      const limit = Math.max(120, Number(maxMs) || 600);
      let last = root.scrollTop;
      let stable = 0;
      for (let waited = 0; waited < limit && stable < 2; waited += 40) {
        await sleep(40);
        const now = root.scrollTop;
        stable = now === last ? stable + 1 : 0;
        last = now;
      }
      return last;
    };

    LS.waitSettle = async function (timeout) {
      const vh = LS.root().clientHeight || window.innerHeight || 600;
      const pending = [];
      for (const img of Array.prototype.slice.call(document.images || [])) {
        if (img.complete && img.naturalWidth) continue;
        const r = img.getBoundingClientRect();
        if (r.bottom <= -vh || r.top >= vh * 2) continue;
        try {
          img.loading = 'eager';
          if (img.decoding === 'async') img.decoding = 'sync';
        } catch (_) {}
        pending.push(
          new Promise((res) => {
            img.addEventListener('load', res, { once: true });
            img.addEventListener('error', res, { once: true });
          })
        );
      }
      await Promise.race([Promise.all(pending), sleep(Math.max(80, timeout))]);
      await Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), sleep(220)]);
      // rAF stops firing when the window is hidden or minimized, so never await it unbounded.
      await Promise.race([
        new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))),
        sleep(500)
      ]);
      await LS.waitStill(600);
    };

    /** Only a start that is strictly above a given end counts as a range.
     *  viewTop is set by a framed region: how far inside the viewport the top of the
     *  box was when it was drawn, so the capture can start from the same scroll
     *  position instead of dragging the box up under a sticky header. */
    LS.validRange = function (range) {
      if (!range) return null;
      const start = Math.max(0, Math.round(Number(range.start)));
      const end = Math.round(Number(range.end));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 20) return null;
      return { start, end, viewTop: Math.max(0, Math.round(Number(range.viewTop) || 0)) };
    };

    /* Where the scroll root's content box sits inside a viewport capture.
     * captureVisibleTab grabs the whole window — classic scrollbar included — so
     * stitching needs the window's own CSS width to turn bitmap pixels back into CSS
     * pixels, plus how much browser chrome (a nav rail, a toolbar) sits left of and
     * above the scrolling content. For the document root both offsets are zero. */
    LS.frame = function () {
      const root = LS.root();
      const doc = root === document.documentElement || root === document.scrollingElement || root === document.body;
      const r = doc ? null : root.getBoundingClientRect();
      return {
        winW: Math.max(1, window.innerWidth || root.clientWidth || 1),
        left: r ? Math.max(0, r.left + (root.clientLeft || 0)) : 0,
        top: r ? Math.max(0, r.top + (root.clientTop || 0)) : 0
      };
    };

    LS.init = function (options) {
      const root = LS.findRoot();
      const html = document.documentElement;
      const range = LS.validRange(options.range);
      const viewport = root.clientHeight || window.innerHeight;
      /* First screen of a run: the top of the range, except that a framed region keeps
       * the margin it had inside the viewport (origin - viewTop is where the page stood
       * while the user dragged), so a sticky header cannot slide over the selection. */
      const target = range ? Math.max(0, range.start - Math.min(viewport, range.viewTop || 0)) : null;
      LS.state = {
        origTop: root.scrollTop,
        origBehavior: html.style.scrollBehavior,
        y: root.scrollTop,
        origin: range ? range.start : null,
        limit: range ? range.end : Infinity,
        target,
        prev: -1,
        first: true,
        hideFixed: options.hideFixed !== false
      };
      // probe mode only measures, so marking a range never touches the page.
      if (!options.probe) {
        root.setAttribute('data-ls-root', '1');
        html.style.scrollBehavior = 'auto';
        LS.pin(root);
      }
      LS.stepSize = Math.max(60, Math.round(viewport - (Number(options.overlap) || 120)));
      return {
        ok: true,
        cssWidth: root.clientWidth || window.innerWidth,
        viewport,
        frame: LS.frame(),
        scrollY: root.scrollTop,
        docHeight: Math.max(root.scrollHeight, html.scrollHeight),
        range,
        dpr: window.devicePixelRatio || 1,
        scrollable: root.scrollHeight - root.clientHeight > 4,
        visible: document.visibilityState === 'visible' && window.innerHeight > 0
      };
    };

    LS.prepass = async function (options) {
      const root = LS.root();
      const from = LS.state.origin == null ? root.scrollTop : LS.state.target;
      const jump = Math.round((root.clientHeight || window.innerHeight || 600) * 1.4);
      root.scrollTop = from;
      await LS.waitSettle(200);
      let last = -1;
      for (let i = 0; i < 60; i++) {
        root.scrollTop = root.scrollTop + jump;
        await LS.waitSettle(Math.max(140, Math.round((Number(options.waitMs) || 500) / 2)));
        if (root.scrollTop === last) break;
        if (LS.state.limit !== Infinity && root.scrollTop + root.clientHeight >= LS.state.limit) break;
        last = root.scrollTop;
      }
      await sleep(320);
      root.scrollTop = LS.state.origin == null ? 0 : LS.state.origin;
      LS.state.y = root.scrollTop;
      LS.state.first = true;
      LS.state.prev = -1;
      await LS.waitSettle(420);
      return { ok: true, docHeight: Math.max(root.scrollHeight, document.documentElement.scrollHeight) };
    };

    LS.step = async function (options) {
      const root = LS.root();
      if (LS.state.hideFixed) LS.hideOverlays();
      const viewport = root.clientHeight || window.innerHeight;
      /* A marked end limits where the bottom edge of the last screen may reach, but it
       * must never lift the top edge above where this run may start: a box shorter than
       * one screen would otherwise be captured from above the range. */
      const floor = LS.state.target || 0;
      const max = Math.max(floor, Math.min(root.scrollHeight - viewport, LS.state.limit - viewport));
      if (LS.state.first) {
        LS.state.first = false;
        if (LS.state.origin != null) {
          root.scrollTop = Math.min(max, LS.state.target);
          await LS.waitSettle(Number(options.waitMs) || 500);
        }
        LS.state.y = root.scrollTop;
      } else {
        LS.state.y = Math.min(max, LS.state.y + LS.stepSize);
      }
      root.scrollTop = LS.state.y;
      await LS.waitSettle(Number(options.waitMs) || 500);
      const actual = root.scrollTop;
      const noMovement = LS.state.prev >= 0 && Math.abs(actual - LS.state.prev) < 1;
      LS.state.prev = actual;
      LS.state.y = actual;
      return {
        ok: true,
        scrollY: actual,
        viewport,
        frame: LS.frame(),
        docHeight: Math.max(root.scrollHeight, document.documentElement.scrollHeight),
        cssWidth: root.clientWidth || window.innerWidth,
        done: actual >= max - 1 || noMovement
      };
    };

    LS.restore = function () {
      const st = LS.state;
      if (st) {
        LS.root().scrollTop = st.origTop;
        document.documentElement.style.scrollBehavior = st.origBehavior || '';
      }
      const style = document.getElementById('__ls_style');
      if (style) style.remove();
      const pin = document.getElementById('__ls_pin');
      if (pin) pin.remove();
      for (const el of document.querySelectorAll('[data-ls-pin]')) el.removeAttribute('data-ls-pin');
      for (const el of document.querySelectorAll('[data-ls-hide]')) el.removeAttribute('data-ls-hide');
      const root = document.querySelector('[data-ls-root]');
      if (root) root.removeAttribute('data-ls-root');
      return { ok: true };
    };

    window.__LS__ = LS;
  }
  try {
    return window.__LS__.init(opts);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
};

const FUNC_CALL = async function (name, opts) {
  const LS = window.__LS__;
  if (!LS || typeof LS[name] !== 'function') return { error: '页面状态丢失，请重新发起截图' };
  try {
    return await LS[name](opts || {});
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
};

/* ------------------------------------------------- region selector (overlay) */

/* The QQ Screenshot 框选 equivalent: drag for a free rectangle, a plain click for
 * the element under the cursor, and the wheel walks the selection out to that
 * element's parents or back in to its children.
 *
 * Resolves with the chosen box expressed in the scroll root's content coordinates
 * (the same numbers the driver compares against root.scrollTop), plus the horizontal
 * band as a fraction of that root's content width.
 */
const FUNC_REGION = function () {
  const MIN = 4;
  const AUTO_CANCEL = 300000;
  const LS = window.__LS__;
  const root = LS ? LS.root() : document.scrollingElement || document.documentElement;
  const isDocRoot = root === document.documentElement || root === document.scrollingElement || root === document.body;

  return new Promise((resolve) => {
    const style = document.createElement('style');
    // The page's own rules can reach our nodes through broad selectors, so every
    // overlay rule is reset first and then re-declared with an attribute selector.
    style.textContent = [
      '[data-ls-pick]{all:initial;box-sizing:border-box;font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:12px;line-height:1.4;color:#e8eaed}',
      '[data-ls-pick="layer"]{position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;cursor:crosshair;overflow:hidden}',
      '[data-ls-pick="band"]{position:fixed;display:none;border:1px solid #2f6bff;box-shadow:0 0 0 9999px rgba(12,14,18,.38);pointer-events:none}',
      '[data-ls-pick="bar"]{position:fixed;display:none;gap:6px;align-items:center;padding:4px;border-radius:8px;background:rgba(24,26,30,.94);box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap}',
      '[data-ls-pick="bar"]>span{padding:0 4px;color:#9aa1ab}',
      '[data-ls-pick="btn"]{display:inline-block;padding:4px 8px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.14)}',
      '[data-ls-pick="btn-primary"]{background:#2f6bff;color:#fff}',
      '[data-ls-pick="hint"]{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);padding:7px 12px;border-radius:8px;background:rgba(24,26,30,.9);pointer-events:none;white-space:nowrap}',
      // While the box is on screen the page must not move: a smooth scroll still running
      // from the user's own wheel, or a snap point pulling the settled position away,
      // would leave the framed rows somewhere else than the pixels that get captured.
      'html,body,[data-ls-pin]{scroll-behavior:auto !important;scroll-snap-type:none !important;overflow-anchor:none !important}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
    root.setAttribute('data-ls-pin', '1');

    const node = (kind) => {
      const el = document.createElement('div');
      el.setAttribute('data-ls-pick', kind);
      return el;
    };
    const layer = node('layer');
    const band = node('band');
    const bar = node('bar');
    const hint = node('hint');
    const sizeLabel = document.createElement('span');
    hint.textContent = '拖动框选 · 单击选中元素 · 滚轮切换父/子元素 · Enter 完成 · Esc 取消';

    let timer = null;
    const pickButton = (text, kind) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.setAttribute('data-ls-pick', kind);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        finish(kind === 'btn-primary');
      });
      return btn;
    };
    bar.append(sizeLabel, pickButton('完成', 'btn-primary'), pickButton('取消', 'btn'));
    layer.append(band, bar, hint);
    (document.body || document.documentElement).appendChild(layer);

    /* Where the scroll root's content box sits inside the captured viewport. For the
     * documentElement that is simply the viewport origin — its own client rect has
     * already been shifted up by the scroll, so it cannot be used here. */
    function origin() {
      if (isDocRoot) return { x: 0, y: 0 };
      const r = root.getBoundingClientRect();
      return { x: r.left + (root.clientLeft || 0), y: r.top + (root.clientTop || 0) };
    }

    let box = null;
    let chain = [];
    let level = 0;
    let anchor = null;
    let dragging = false;
    let locked = false;

    function visibleBand() {
      return {
        left: root.scrollLeft,
        top: root.scrollTop,
        right: root.scrollLeft + root.clientWidth,
        bottom: root.scrollTop + root.clientHeight
      };
    }

    function clamp(rect) {
      const v = visibleBand();
      const left = Math.max(v.left, Math.min(v.right, rect.x));
      const top = Math.max(v.top, Math.min(v.bottom, rect.y));
      const right = Math.max(v.left, Math.min(v.right, rect.x + rect.width));
      const bottom = Math.max(v.top, Math.min(v.bottom, rect.y + rect.height));
      return { x: left, y: top, width: right - left, height: bottom - top };
    }

    function toContent(clientX, clientY) {
      const o = origin();
      return { x: clientX - o.x + root.scrollLeft, y: clientY - o.y + root.scrollTop };
    }

    function underPoint(clientX, clientY) {
      const list = document.elementsFromPoint
        ? document.elementsFromPoint(clientX, clientY)
        : [document.elementFromPoint(clientX, clientY)];
      const out = [];
      for (const el of list || []) {
        if (!el || el.nodeType !== 1) continue;
        if (el.closest && el.closest('[data-ls-pick]')) continue;
        if (el === document.documentElement || el === document.body) continue;
        out.push(el);
      }
      return out;
    }

    function ofElement(el) {
      const r = el.getBoundingClientRect();
      const o = origin();
      return clamp({
        x: r.left - o.x + root.scrollLeft,
        y: r.top - o.y + root.scrollTop,
        width: r.width,
        height: r.height
      });
    }

    function paint() {
      if (!box || box.width < 1 || box.height < 1) {
        band.style.display = 'none';
        bar.style.display = 'none';
        hint.style.display = '';
        return;
      }
      const o = origin();
      const left = Math.round(box.x - root.scrollLeft + o.x);
      const top = Math.round(box.y - root.scrollTop + o.y);
      hint.style.display = locked ? 'none' : '';
      band.style.display = 'block';
      band.style.left = left + 'px';
      band.style.top = top + 'px';
      band.style.width = Math.round(box.width) + 'px';
      band.style.height = Math.round(box.height) + 'px';
      sizeLabel.textContent = `${Math.round(box.width)} × ${Math.round(box.height)}`;
      bar.style.display = 'flex';
      bar.style.left = Math.max(4, Math.min((window.innerWidth || 800) - (bar.offsetWidth || 160) - 4, left - 5)) + 'px';
      bar.style.top = Math.max(4, top - (bar.offsetHeight || 30) - 8) + 'px';
    }

    function dragRect(from, to) {
      return clamp({
        x: Math.min(from.x, to.x),
        y: Math.min(from.y, to.y),
        width: Math.abs(to.x - from.x),
        height: Math.abs(to.y - from.y)
      });
    }

    function onMove(e) {
      if (dragging && anchor) {
        box = dragRect(anchor, toContent(e.clientX, e.clientY));
        paint();
        return;
      }
      if (locked) return;
      // Hover follows the element under the pointer, innermost first.
      chain = underPoint(e.clientX, e.clientY);
      level = 0;
      box = chain.length ? ofElement(chain[0]) : null;
      paint();
    }

    function onDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      locked = false;
      anchor = toContent(e.clientX, e.clientY);
      chain = underPoint(e.clientX, e.clientY);
      level = 0;
      try {
        layer.setPointerCapture(e.pointerId);
      } catch (_) {}
    }

    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      const rect = dragRect(anchor, toContent(e.clientX, e.clientY));
      // A press without a drag means "take this whole element", not a three-pixel box.
      box = rect.width >= MIN && rect.height >= MIN ? rect : chain.length ? ofElement(chain[level]) : null;
      locked = true;
      paint();
    }

    function onWheel(e) {
      e.preventDefault();
      if (!chain.length) chain = underPoint(e.clientX, e.clientY);
      if (!chain.length) return;
      level = Math.max(0, Math.min(chain.length - 1, level + (e.deltaY < 0 ? 1 : -1)));
      box = ofElement(chain[level]);
      locked = true;
      paint();
    }

    function onKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    }

    function finish(confirmed) {
      clearTimeout(timer);
      layer.removeEventListener('pointermove', onMove);
      layer.removeEventListener('pointerdown', onDown);
      layer.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointerup', onUp);
      layer.removeEventListener('wheel', onWheel, { passive: false });
      document.removeEventListener('keydown', onKey, true);
      layer.remove();
      style.remove();
      root.removeAttribute('data-ls-pin');
      if (!confirmed || !box || box.width < MIN || box.height < MIN) {
        resolve(null);
        return;
      }
      const width = Math.max(1, root.clientWidth || window.innerWidth || 1);
      // Content coordinates already exclude the root box origin, so the band is a
      // fraction of the content box — the same box the stitched image is as wide as.
      const xRatio = Math.max(0, Math.min(1, (box.x - root.scrollLeft) / width));
      // How far the top of the box sat below the edge of the visible area. The capture
      // has to keep that margin: pulling the box up to the top of the viewport would
      // slide a sticky header over the rows the user just framed.
      resolve({
        xRatio,
        widthRatio: Math.max(0, Math.min(1 - xRatio, box.width / width)),
        width: Math.round(box.width),
        height: Math.round(box.height),
        top: Math.round(box.y),
        bottom: Math.round(box.y + box.height),
        viewTop: Math.max(0, Math.round(box.y - root.scrollTop))
      });
    }

    timer = setTimeout(() => finish(false), AUTO_CANCEL);
    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerdown', onDown);
    layer.addEventListener('pointerup', onUp);
    window.addEventListener('pointerup', onUp);
    layer.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKey, true);
    paint();
  });
};


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

}
