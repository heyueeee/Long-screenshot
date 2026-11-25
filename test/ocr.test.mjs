/* 离线 OCR 驱动：在假 chrome / 假 Tesseract 环境下检查启动参数、进度转发和文本清洗。
 * 真正的 wasm 识别只能在浏览器里跑，这里验的是我们喂给它的东西对不对。
 */
import { readFileSync } from 'node:fs';
import { check } from './stitch-env.mjs';

const src = readFileSync(new URL('../long-screenshot/ocr.js', import.meta.url), 'utf8');
const PREFIX = 'chrome-extension://abcdefghijklmnopqrstuvwx/';

let calls = [];
let workers = [];
let failNext = null;

function fakeWorker() {
  const w = {
    jobs: [],
    terminated: 0,
    async recognize(input) {
      w.jobs.push(input);
      return { data: { text: '识 别 文 字  hello   world\n\n\n\n结束 ', confidence: 74.6 } };
    },
    async terminate() {
      w.terminated++;
    }
  };
  workers.push(w);
  return w;
}

function load() {
  calls = [];
  workers = [];
  failNext = null;
  const Tesseract = {
    createWorker: async (langs, oem, options) => {
      calls.push({ langs, oem, options });
      if (failNext) throw failNext;
      return fakeWorker();
    }
  };
  const chrome = { runtime: { getURL: (p) => `${PREFIX}${p}` } };
  return new Function('chrome', 'Tesseract', `${src}\nreturn OCR;`)(chrome, Tesseract);
}

console.log('启动参数全部指向扩展自带的文件');
{
  const OCR = load();
  const seen = [];
  const w = await OCR.boot((m) => seen.push(m));
  const opts = calls[0].options;
  check('中英文都要', String(opts.langs || calls[0].langs) === 'chi_sim,eng', calls[0].langs);
  check('只用 LSTM 引擎', calls[0].oem === 1, calls[0].oem);
  check('core 指向打包好的 wasm.js', opts.corePath === `${PREFIX}ocr/core/tesseract-core-simd-lstm.wasm.js`, opts.corePath);
  check('worker 是同源文件而不是 blob', opts.workerPath === `${PREFIX}ocr/worker.min.js` && opts.workerBlobURL === false, opts);
  check('语言包也从扩展目录读', opts.langPath === `${PREFIX}ocr/lang` && opts.gzip === true, opts);
  check('不写 IndexedDB 缓存', opts.cacheMethod === 'none', opts.cacheMethod);
  check('进度回调转给了引擎', typeof opts.logger === 'function', opts.logger);
  check('引擎确实起来了', workers.length === 1 && w === workers[0]);

  const again = await OCR.boot();
  check('第二次不再新建 worker', again === w && calls.length === 1, calls.length);
}

console.log('进度与失败');
{
  const OCR = load();
  failNext = new Error('wasm 被 CSP 拦了');
  const first = await OCR.boot().then(
    () => null,
    (err) => err.message
  );
  check('启动失败有中文说明', /OCR 引擎启动失败/.test(first || ''), first);
  check('失败信息带上原因', /wasm 被 CSP 拦了/.test(first || ''), first);
  failNext = null;
  const w = await OCR.boot();
  check('失败之后还能重试', calls.length === 2 && !!w, calls.length);
}

console.log('识别走引擎、结果回传');
{
  const OCR = load();
  const canvas = { tag: 'canvas', width: 800, height: 600 };
  const { text, conf } = await OCR.recognize(canvas);
  check('画布原样交给 worker', workers[0].jobs.length === 1 && workers[0].jobs[0] === canvas, workers[0].jobs);
  check('返回的是清洗过的文本', text === '识别文字  hello   world\n\n结束', JSON.stringify(text));
  check('置信度取整后一起返回', conf === 75, conf);
}

console.log('缺 confidence 时按 0 处理');
{
  const OCR = load();
  const w = await OCR.boot();
  w.recognize = async () => ({ data: { text: 'hi' } });
  const { text, conf } = await OCR.recognize({});
  check('没有 confidence 字段也不炸', conf === 0 && text === 'hi', { text, conf });
}

console.log('释放');
{
  const OCR = load();
  const w = await OCR.boot();
  await OCR.release();
  check('worker 被终止', w.terminated === 1, w.terminated);
  await OCR.boot();
  check('释放之后会重新加载', calls.length === 2, calls.length);
  await OCR.release();
  await OCR.release();
  check('重复释放不会报错', calls.length === 2, calls.length);
}

console.log('纯文本清洗');
{
  const OCR = load();
  check('英文单词之间的空格保留', OCR.tidy('hello world') === 'hello world');
  check('只有汉字之间才收紧', OCR.tidy('中 文 hello 世界') === '中文 hello 世界', OCR.tidy('中 文 hello 世界'));
  check('标点后空格不动', OCR.tidy('句子。 下一句') === '句子。 下一句', OCR.tidy('句子。 下一句'));
  check('行尾空白去掉', OCR.tidy('a   \nb') === 'a\nb', JSON.stringify(OCR.tidy('a   \nb')));
  check('三个以上空行压成一段', OCR.tidy('a\n\n\n\n\nb') === 'a\n\nb', JSON.stringify(OCR.tidy('a\n\n\n\n\nb')));
  check('没有内容时给空串', OCR.tidy(undefined) === '');
}

if (check.failed) {
  console.log(`\n${check.failed} ocr check(s) failed`);
  process.exit(1);
}
console.log('\nall ocr checks passed');
