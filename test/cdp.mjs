/* Minimal CDP driver shared by the browser end-to-end checks: launch a Chromium
 * browser with the unpacked extension, attach flat sessions, evaluate real code. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Static file server rooted at dir, so the fixtures load over http:// and the
 *  extension does not need "allow access to file URLs". */
export function serve(dir, port) {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(root, rel));
      res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done({ server, port })));
}

/** Poll the debug endpoint until the browser answers, then return its ws url. */
export async function waitCdp(port, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP 端口没有响应');
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.waiters = new Map();
    this.events = [];
    this.listeners = [];
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.waiters.has(msg.id)) {
        const { ok, bad } = this.waiters.get(msg.id);
        this.waiters.delete(msg.id);
        if (msg.error) bad(new Error(`${msg.error.message} (${msg.error.code})`));
        else ok(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, bad) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => bad(new Error('CDP websocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.next += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((ok, bad) => {
      this.waiters.set(id, { ok, bad });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.waiters.has(id)) {
          this.waiters.delete(id);
          bad(new Error(`${method} 超时`));
        }
      }, 180000);
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  async newTarget(url, newWindow = false) {
    const { targetId } = await this.send('Target.createTarget', { url, newWindow });
    return targetId;
  }

  targets() {
    return this.send('Target.getTargets').then((r) => r.targetInfos);
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Runtime.enable', {}, sessionId);
    /* Page.* only exists for tab-like targets; a service worker rejects it. */
    try { await this.send('Page.enable', {}, sessionId); } catch {}
    return sessionId;
  }

  /** Evaluate a function body (use `return ...`) and hand back the JSON value. */
  async eval(sessionId, body) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: `(async () => {\n${body}\n})()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (exceptionDetails) {
      const d = exceptionDetails.exception || exceptionDetails;
      throw new Error(String(d.description || d.value || JSON.stringify(exceptionDetails)).split('\n')[0]);
    }
    return result.value;
  }

  async navigate(sessionId, url, waitMs = 1200) {
    await this.send('Page.navigate', { url }, sessionId);
    await sleep(waitMs);
  }

  async mouse(sessionId, type, x, y, clickCount = 0) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount }, sessionId);
  }

  /** The page only sees keys the browser routed, so press and release through the
   *  Input domain instead of dispatching a synthetic KeyboardEvent. */
  async key(sessionId, key, code, keyCode) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: key === 'Enter' ? '\r' : key, ...base }, sessionId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

/** Launch Edge/Chrome with the unpacked extension and return handles.
 *  Headless is the default because it never steals the desktop, but it also swaps the
 *  OS clipboard for an in-process stub, so a check that reads the real clipboard has to
 *  ask for `headless: false`. */
export async function launch({ bin, ext, profile, port, keep = false, headless = true }) {
  const { rmSync, mkdirSync } = await import('node:fs');
  if (!keep) rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    /* Without this the DevTools socket answers 403 to any client that sends an
     * Origin header, which includes Node's built-in WebSocket. */
    '--remote-allow-origins=*',
    `--user-data-dir=${profile.replace(/\\/g, '\\')}`,
    `--load-extension=${ext.replace(/\\/g, '\\')}`,
    /* Machine-wide "external extensions" (a registry push) get installed into a brand
     * new profile too, and one of them opens its update page mid-run, which silently
     * deactivates the fixture tab. Only our unpacked build should load. */
    `--disable-extensions-except=${ext.replace(/\\/g, '\\')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    'about:blank'
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');
  const child = spawn(bin, args, { stdio: 'ignore' });
  child.on('exit', (code) => console.log(`[browser exited ${code}]`));
  const version = await waitCdp(port);
  return { child, version };
}

export function kill(child) {
  try { child.kill('SIGKILL'); } catch {}
}
