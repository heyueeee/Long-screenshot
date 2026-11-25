/* Long Shot — 离线文字识别。
 * 引擎、worker 和中文/英文模型都随扩展打包（ocr/ 目录），不联网。
 * 只在结果页里跑：service worker 活不过 30 秒，装不下一个要初始化十几秒的 wasm。
 */

const OCR = (() => {
  const abs = (path) => chrome.runtime.getURL(path);
  /* MV3 的 CSP 不接受 blob URL 作为 worker，所以 workerBlobURL 必须关掉；
   * corePath 指到单个 .wasm.js，就不需要 worker 再按 CPU 特性去挑别的构建。 */
  const OPTIONS = {
    corePath: abs('ocr/core/tesseract-core-simd-lstm.wasm.js'),
    workerPath: abs('ocr/worker.min.js'),
    langPath: abs('ocr/lang'),
    workerBlobURL: false,
    gzip: true,
    cacheMethod: 'none'
  };
  const LANGS = ['chi_sim', 'eng'];

  let worker = null;
  let booting = null;

  /** 模型是本地文件，每次重新加载也就几百毫秒，不值得为它维护 IndexedDB 缓存。 */
  function boot(onProgress) {
    if (worker) return Promise.resolve(worker);
    if (booting) return booting;
    booting = Tesseract.createWorker(LANGS, 1, { ...OPTIONS, logger: (m) => onProgress(m) })
      .then((w) => {
        worker = w;
        return w;
      })
      .catch((err) => {
        booting = null;
        throw new Error(`OCR 引擎启动失败：${(err && err.message) || err}`);
      });
    return booting;
  }

  /** chi_sim 习惯在每个汉字之间塞一个空格，去掉它才像人写的。
   *  只收汉字之间的空格 —— 标点后面的空格可能是分栏，不能顺手合并。 */
  function tidy(text) {
    const han = '[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]';
    return String(text || '')
      .replace(new RegExp(`(${han})[ \\t]+(?=${han})`, 'g'), '$1')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** conf 是引擎自己的把握度：垃圾区域也能出字，只有它能看出认得对不对。 */
  async function recognize(canvas, onProgress) {
    const w = await boot(onProgress);
    const { data } = await w.recognize(canvas);
    const text = tidy(data && data.text ? data.text : '');
    const conf = data && Number.isFinite(data.confidence) ? Math.round(data.confidence) : 0;
    return { text, conf };
  }

  async function release() {
    const w = worker;
    worker = null;
    booting = null;
    if (w) await w.terminate();
  }

  return { boot, recognize, release, tidy, abs };
})();
