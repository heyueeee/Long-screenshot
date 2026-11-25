/* Static wiring audit: the failure modes here are "the extension loads but a file
 * or an id is missing", which a real browser only shows as a silent half-broken UI. */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'long-screenshot');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const path = (rel) => join(ROOT, rel).replace(/\\/g, '/');

let bad = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) bad += 1;
};
const uniq = (list) => [...new Set(list)].sort();

console.log('manifest 引用的文件都在');
{
  const manifest = JSON.parse(read('manifest.json'));
  const files = [];
  files.push(manifest.background.service_worker, manifest.action.default_popup);
  for (const set of [manifest.action.default_icon, manifest.icons]) files.push(...Object.values(set));
  const missing = uniq(files).filter((f) => !existsSync(join(ROOT, f)));
  check('service worker / popup / icons 全部存在', missing.length === 0, missing);
  check('扩展页 CSP 允许 wasm', /wasm-unsafe-eval/.test(manifest.content_security_policy.extension_pages),
    manifest.content_security_policy);
}

console.log('页面引用的资源都在');
{
  const tags = [];
  for (const page of ['popup.html', 'edit.html']) {
    const html = read(page);
    for (const m of html.matchAll(/(?:<script[^>]*src|<link[^>]*href|<img[^>]*src)="([^"]+)"/g)) {
      tags.push({ page, ref: m[1] });
    }
  }
  const local = tags.filter((t) => !/^(https?:|data:|chrome:)/.test(t.ref));
  const gone = local.filter((t) => !existsSync(join(ROOT, t.ref)));
  check(`${local.length} 个本地 src/href 都能读到`, gone.length === 0, gone);
  /* ocr/tesseract.min.js 是唯一提供 window.Tesseract 的地方，漏掉它 OCR 只会一直报错。 */
  const edit = read('edit.html');
  check('识别页加载了引擎主脚本', /src="ocr\/tesseract\.min\.js"/.test(edit), edit.match(/script src="[^"]+"/g));
  check('引擎脚本在 ocr.js 之前', edit.indexOf('tesseract.min.js') < edit.indexOf('src="ocr.js"'), null);
}

console.log('脚本里用到的元素 id 都在页面上');
{
  for (const [js, html] of [['edit.js', 'edit.html'], ['popup.js', 'popup.html']]) {
    const used = uniq([...read(js).matchAll(/\$\('([A-Za-z][A-Za-z0-9]*)'\)/g)].map((m) => m[1]));
    const ids = new Set([...read(html).matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const missing = used.filter((id) => !ids.has(id));
    check(`${js} 的 ${used.length} 个 id 都有对应节点`, missing.length === 0, missing);
  }
}

console.log('OCR 只依赖扩展内的文件');
{
  const src = read('ocr.js');
  const refs = uniq([...src.matchAll(/abs\('([^']+)'\)/g)].map((m) => m[1]));
  check('启动参数列出了 core / worker / lang 三处', refs.length === 3, refs);
  const gone = refs.filter((rel) => !existsSync(join(ROOT, rel)));
  check('三个路径在磁盘上都存在', gone.length === 0, gone);
  /* worker 拿到 .js 结尾的 corePath 会直接 importScripts，不再做 CPU 特性探测。 */
  check('corePath 指向单文件 wasm 构建', /\.wasm\.js$/.test(refs.find((r) => r.includes('core')) || ''), refs);
  check('worker 不走 blob URL', /workerBlobURL:\s*false/.test(src), null);
  check('语言包按 <lang>.traineddata.gz 命名', existsSync(join(ROOT, 'ocr/lang/chi_sim.traineddata.gz')), path('ocr/lang'));
}

console.log('版本号三处一致');
{
  const manifest = JSON.parse(read('manifest.json'));
  const bg = read('background.js').match(/const BUILD = '([^']+)'/)[1];
  const pop = read('popup.js').match(/const EXPECTED_BUILD = '([^']+)'/)[1];
  check('manifest = 后台 = 弹窗', manifest.version === bg && bg === pop, { v: manifest.version, bg, pop });
}

console.log(bad ? `\n${bad} check(s) failed` : '\nall wiring checks passed');
process.exit(bad ? 1 : 0);
