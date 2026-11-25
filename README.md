# Long Shot 整页长截图

一个 Manifest V3 的 Chrome / Edge 浏览器扩展：自动滚动网页、逐屏截图，并按每屏的**绝对滚动偏移**拼接成整页长图；支持框选区域、结果页标注（箭头 / 序号 / 文字 / 马赛克 / 模糊）、离线识别文字，并可直接下载到 PNG 或 JPEG。

```
long-screenshot/        扩展本体（加载这个目录；ocr/ 里是 7.5 MB 的离线识别包）
test/                   8 组 Node 自测 + 1 套 CDP 浏览器端到端检查，以及 3 个手工验证用的样例页面
```

## 安装（开发者模式加载）

1. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录下的 `long-screenshot` 文件夹
4. （可选）在扩展详情页 → 键盘 shortcuts 里确认或修改快捷键：整页 `Alt+Shift+S`，框选区域 `Alt+Shift+R`

## 使用

1. 打开要截图的网页，点扩展图标（或按 `Alt+Shift+S`）
2. 点 **开始长截图**，期间**不要切换标签页或最小化窗口**
3. 完成后图片自动下载到**浏览器下载目录下的 `LongShot` 子文件夹**（例如下载目录设成 `C:\Users\80495\Pictures\Screenshots`，文件就落在 `...\Screenshots\LongShot\`）。弹窗里会显示顶部预览和完整路径，点 **打开所在文件夹** 可直接定位文件。
4. 成品有三个出口：
   - **复制到剪贴板** —— 直接粘贴到微信 / 钉钉 / 文档里，不用先找文件。
   - **标注 / 新标签页打开** —— 在结果页里直接画箭头、打码、写字，认出文字、再复制或导出（见下面「标注结果图」和「识别文字」）。
   - **磁盘文件** —— 就是上面 `LongShot` 目录里的 PNG / JPEG。

   剪贴板、标注页和新标签页用的是后台 service worker 内存里缓存的那一份结果（不落第二次盘）。缓存会随后台脚本重启一起消失 —— 那种情况下弹窗不再显示结果卡片，请直接使用 `LongShot` 目录里的文件。

### 只截一块区域

弹窗里的 **在页面里框选**（参考 QQ 截图的交互）：

1. 页面上会出现十字光标和遮罩，**拖动**鼠标画一个矩形；**单击**则直接选中光标下的那个元素
2. **滚轮**沿着元素层级走：向上滚跳到父元素（选更大的卡片/整栏），向下滚回到子元素（选其中的按钮/图片）
3. **Enter** 或点「完成」开始截图，**Esc** 或点「取消」放弃；5 分钟不动会自动收起，不会把页面卡在遮罩下
4. 选框只影响当前可见的那一屏 —— 结果就是一张所见即所得的图：横向按选框的列裁切，纵向按选框的行裁切

框选会**自动关掉「隐藏固定元素」**：区域本来就只有一屏，不存在跨屏重复的页眉；而且被框选的往往正是一个吸顶栏或弹窗，隐藏它等于把要截的东西擦掉。手动标记起点/终点的范围模式仍然遵循这个开关。代价是同一块内容在两种成品里可能差着那条吸顶栏 —— 端到端检查因此分开量：栏覆盖的 56 行按屏幕原样，栏下 336 行必须与整页图逐行零错位。

不想开弹窗的话直接按 `Alt+Shift+R`，页面里立刻出现框选层；若框选被拒绝（内置页面、区域太小），原因会在下次打开弹窗时显示出来。

### 标注结果图

结果页（弹窗里的 **标注 / 新标签页打开**）顶部是一条 QQ 截图式的工具栏，一次点击就能在当前那一段上画：

| 工具 | 用法 |
| --- | --- |
| 选择 | 点中图形后拖动即可移动，`Delete` 删除，`Esc` 取消选中 |
| 矩形 / 椭圆 | 拖拽画框，「填充」切换实心 |
| 箭头 | 拖出方向，箭头自动成形 |
| 序号 | 点一下就是一个带数字的圆点，删掉中间一个，其余自动重排 |
| 文字 | 点一下出现文本框，`Ctrl+Enter` 提交、`Esc` 取消，留空则自动删掉这块 |
| 画笔 / 高亮 | 自由手绘，高亮是半透明压色（`multiply`），不挡住底下文字 |
| 马赛克 / 模糊 | 拖出一块即可打码，「强度」调颗粒大小 / 模糊半径 |

- 颜色 8 个预设 + 取色器；**选中某个图形后再改颜色 / 粗细 / 强度，改的就是这个图形**
- 「粗细」只影响描边类工具，「强度」只在马赛克 / 模糊 / 文字 / 序号时可用（后两者显示为「字号」，范围 12–60；强度范围 4–60，两者互不影响），其余情况自动置灰
- 每段都有独立的撤销 / 重做（`Ctrl+Z` / `Ctrl+Shift+Z` 或 `Ctrl+Y`）与「清除本段」
- 长图用**贴顶的可视区 canvas** 绘制：只画当前视口对应的那一条图像切片，几万 px 的长图也不会撑爆 canvas；缩放 5%–400%，「适应」按窗口宽度回位
- 两个出口：**复制标注图**（当前段，剪贴板放不下多段）与 **导出文件**（每段一个 `<原名>-标注-<时间>.png`，同样落在下载目录的 `LongShot` 子文件夹）。超出 canvas 上限时导出会自动缩小并在提示里说明比例。

### 识别文字（OCR）

结果页顶部的 **识别文字** 按钮，认的是「你现在正在看的那一块」：

1. 想认局部：先用矩形 / 椭圆工具框住那段文字（选中即可，不用提交），再点 **识别文字** —— 提示条会写「选中区域」
2. 想认整屏：什么都不选，直接点 —— 认的是贴顶 canvas 当前显示的那一条，提示条写「当前视口」
3. 结果出现在右下角的文本框里，**复制文字** 直接进剪贴板，**下载 .txt** 存到下载目录的 `LongShot` 子文件夹
4. 用完点面板右上角的 **✕**：识别引擎的 wasm 挺占内存，关掉就立刻还给浏览器

提示条上会给出**置信度**。深色底、缩略图或小字照样能出一堆字，所以光看结果看不出好坏 —— 低于 45% 时提示条会直接提醒「放大到 100% 以上、只框住文字那一行再认一次」，这个数比结果本身可靠得多。

识别在中式排版上会自动把每个汉字之间多出来的空格去掉（`识 别 文 字` → `识别文字`），但英文单词之间、中文标点后面的空格都会保留 —— 那往往是分栏，不是识别错误。

首次点击要先加载引擎和语言模型，视机器情况约 5–15 秒，进度会写在提示条上；之后同一页面里再识别就只需要识别本身的时间。**全程不联网**：模型和引擎都在扩展目录里（见下面「OCR 离线包」），页面内容不会发出去。

### 各项设置

| 设置 | 作用 |
| --- | --- |
| 输出格式 | PNG 无损；JPEG 体积小（长图建议 JPEG，文件能小 5–10 倍） |
| 清晰度 | 跟随屏幕 = 按 devicePixelRatio 输出；1× 按 CSS 像素；2× 强制超清 |
| 每屏重叠 | 相邻两屏重叠的像素。拼接靠绝对偏移，重叠只是容错余量；页面有视差/动画时调大 |
| 每屏等待 | 每滚一屏后等待图片/字体加载的时间，最低 500 ms（浏览器截屏配额就是约每秒 2 次，再小也不会更快）。慢网站调到 1000–2000 ms |
| 预滚动 | 先一路滚到底再回到顶部，把懒加载内容都触发出来（强烈建议开着） |
| 隐藏固定元素 | 截图时把 `position: fixed/sticky` 的工具条、客服浮窗设为 `visibility: hidden`（框选区域不受这项影响，框到什么截什么） |
| 合并重复屏 | 只在页面没有再前进（到底、吸附回弹）时丢掉多余的一屏；页面确实滚动了而画面没变，就按上报位置保留并在结果里说明 |
| 下载前询问位置 | 走系统保存对话框 |

## 实现要点

- **不做像素匹配。** 注入脚本每次滚动后回报真实的 `scrollTop`，拼接时把第 i 屏画到 `scrollTop_i × scale` 的位置，重叠区自然对齐。因此不需要寻找相似行，也不会因为页面有重复内容而错位。
- **页面自己会动就必须先按住。** `scroll-behavior:smooth` 把每次写入变成动画，`scroll-snap-type` 会把落点拽到吸附位，`overflow-anchor` 会在上方懒加载完成时改 `scrollTop` —— 三者都会让快门看到的行和上报的偏移不是一批，成品里就出现「已经渲染出来但不该在这里」的内容。截之前给滚动根钉上这三条（都不参与布局，像素一模一样），截之前再等 `scrollTop` 连续两次读数相同（`LS.waitStill`）才按快门，结束时连样式带属性一起撤掉。样式的选择器带 `body` 和 `[data-ls-pin]`，所以钉的是**真正在滚的那个元素**：文档页钉 html/body，容器页钉那个 `overflow-y:scroll` 的 div；在真实 Chromium 里验过层叠顺序 —— 页面自己写 `scroll-behavior:smooth !important;scroll-snap-type:y mandatory !important` 也压得住（同为 `!important` 时后插入的赢），撤掉样式后 `smooth`/`y` 原样回来。
- **重复的一屏只在页面没前进时才折叠。** 画面相同可能是「滚动吸附/整屏固定区块」，也可能是浏览器还没来得及重绘这一屏。只有偏移确实没动（≤4 px）才丢掉多余一屏并把它走过的距离从后续偏移里扣掉；偏移真的前进了就**保留原位**、只在结果里说明，因为扣掉一屏会把后面几万 px 整体上移一屏 —— 那是比重复一屏严重得多的错位。
- **滚动容器自适应。** 先在 `document.scrollingElement` 和所有 `overflow-y: auto/scroll` 的元素里选出可滚动距离最大的那个作为 root，所以后台管理类网站（内部 div 滚动）也能截。
- **懒加载。** 预滚动一遍触发；正式截图时每屏会等视口内的 `<img>` 加载完（`loading` 改成 `eager`）、等 `document.fonts.ready`、再等两帧 rAF。
- **固定/吸附元素**用 `visibility: hidden` 而不是 `display: none`，保证布局尺寸不变，偏移量才不会失效。覆盖整个视口的 fixed 容器不会被隐藏（它通常是滚动包装层，隐藏会导致整页空白）。
- **超长页自动降分辨率。** canvas 高度上限 30000 px、面积上限 9600 万像素，超了会自动降低 scale 并在结果里说明；极端长度（>15 万 CSS px）才会拆成多个分段文件。
- **拼接后自检。** 统计没有被任何一屏覆盖的行，若出现超过 8 px 的连续空白带，会提示“可能有区域未加载完成，建议增大每屏等待时间”。
- **分工。** 拼接在 offscreen 文档里做（那里才有 canvas），但这类文档只能调用 `chrome.runtime`，没有下载权限，所以成品以 data URL 交回后台 service worker，由它调 `chrome.downloads` 写盘；写盘结果（绝对路径或被拦截的原因）再回报给弹窗，不会出现「显示保存成功但找不到文件」。
- **结果缓存用 blob URL。** 拼接好的图片在 service worker 里转成 `URL.createObjectURL`，弹窗和新标签页各自 `fetch` 这个同源地址 —— 几十 MB 的长图不需要重复穿过 `chrome.runtime.sendMessage`（消息通道对超大负载并不友好）。代价是 blob 的生命周期等于 worker 的生命周期，所以缓存不是持久出口，文件才是。
- **剪贴板只能在页面里写。** 后台脚本和 offscreen 文档都没有用户激活状态，`navigator.clipboard.write` 在那里必然失败，所以复制动作放在弹窗 / 新标签页（需要 `clipboardWrite` 权限）。Chrome 的剪贴板只收 PNG，JPEG 结果会先解码再重新编码成 PNG；PNG 结果则把 blob 以 **Promise** 的形式交给 `ClipboardItem`，这样取数据的耗时不会把点击带来的激活状态耗光。
- **框选层只记内容坐标。** 覆盖层的数字全部换算成滚动根的「内容坐标」（和驱动比较 `scrollTop` 用的是同一套），所以选完区域后即使页面还在滚，选框也不会漂。遮罩打开期间同样钉住上面那三条，动画页不会再把手刚画好的选区从框里搬走（实测：打开遮罩后 0.6 s 内 `scrollTop` 不变）。投给拼接的横向选区用**视口宽度的比例**表示，滚动条宽度与 devicePixelRatio 就都影响不到它。命中测试会过滤掉自己的节点，元素链靠 `elementsFromPoint` 从里到外排，滚轮只是在数组里前后移动。
- **框选期间要续命。** 画选框可能耗上几分钟，而空转的 service worker 30 秒就被回收了 —— 那会让遮罩孤零零留在页面上、选择结果丢失，所以等待期间每 20 秒调一次 `chrome.runtime.getPlatformInfo()` 保持后台活着。
- **标注坐标一律用原图像素。** 图形存的是图片坐标，显示时只乘一个 zoom，所以改缩放不会错位、导出时按原尺寸重绘一遍就能得到无损成品；可视区用「贴顶 sticky canvas + 窗口切片」，每次 `scroll` / `resize` 只重画当前那一条，避免给几万 px 的长图建一个超大 canvas。
- **马赛克 / 模糊按图形缓存渲染结果。** 打码需要读原始像素，所以每块区域只在尺寸、位置或缩放变化时重新取一次（模糊还会向外多取一圈再裁回框内，否则边缘会露出没糊的缝）；这块缓存是 canvas 对象，序列化进撤销快照前会被剔掉。
- **截屏频率由后台统一限速。** `chrome.tabs.captureVisibleTab` 有每秒约 2 次的硬配额，超了直接抛 `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`；「每屏等待」调到 120–300 ms 就会撞上，所以后台自己保证两次截屏间隔 ≥520 ms（并在真撞上时退避重试），不靠用户那个滑块。
- **一帧没截到不算整轮白干。** 页面正在跳转、窗口刚被切走的那一瞬间，`captureVisibleTab` 与 `executeScript` 都可能抛 `Cannot access contents of url ""`。被拒绝的注入根本没有执行，所以重放不会让滚动跳步 —— 截屏退避重试 4 次、注入重试 3 次，已经滚完的十几屏不会因此丢掉。实在重试不完才报错，写的是「截图时页面不在前台……」和「把每屏等待调大」，而不是浏览器那句没法操作的权限原文。
- **离屏文档只答自己的消息。** `chrome.runtime.sendMessage` 是广播，谁先 `sendResponse` 谁赢；离屏文档原本会对所有消息回执，于是弹窗的状态查询有概率拿到它的 `unknown message` 而不是后台的真实进度。现在离屏文档对不属于自己那三种消息既不回答、也不占通道（`return false`）。
- **导出要等浏览器写完。** 结果页的「导出文件 / 下载 .txt」调 `chrome.downloads.download` 只是把写盘排进队列，立刻报「已导出」就会出现提示成功、文件还没落盘；现在等 `downloads.onChanged` 到 `complete` 才报成功，`interrupted` 或 30 秒没写完会明说哪几个文件没写出，并让去 `chrome://downloads` 看原因。
- **OCR 只在结果页里跑。** service worker 里既没有 DOM 也不能装 wasm 引擎，所以引擎活在新标签页的 worker 里；代价是必须在 manifest 开 `script-src 'self' 'wasm-unsafe-eval'`（MV3 的 CSP 不接受 blob URL 当 worker，所以 `workerBlobURL` 要关掉、`workerPath` 指到扩展内的文件）。`corePath` 直接给单个 `.wasm.js`，worker 就不会再去按 CPU 特性挑别的构建；`cacheMethod:'none'` 是因为模型已经在包里，没必要再往磁盘写一份缓存。
- **OCR 取块先算准整像素。** 选中区域和当前视口都过一遍 `clipBox()`：小数偏移会让 `drawImage` 重采样（小字最容易在这里被认花），而源矩形越界时浏览器的行为是「裁掉再拉伸」，尺寸会悄悄变大 —— 所以宽度、高度都得先夹回图内，不能留给 `drawImage`。
- 页面中途跳转、被最小化、切标签页都会中止并给出原因（瞬时够不着的情况先按上一条重取）；无论成功失败，滚动位置和临时样式都会还原。

## 已知限制

- `chrome://`、Edge 内置页、Chrome Web Store 页面无法注入脚本
- 内容在 `<iframe>` 里滚动的页面（部分文档站）只能截到外框
- 视频/Canvas 动画、滚动触发的入场动画可能在拼接缝处出现轻微错位，把“每屏重叠”调大即可
- 单屏截图受浏览器可视区域限制，窗口越小截出的宽度越小；建议把浏览器窗口最大化后再截
- 页面拿不到渲染表面时（窗口被最小化、远程桌面断开、IDE 内嵌 webview 里 `innerHeight` 为 0、`requestAnimationFrame` 不触发）宁可失败也不要错位的成品：开跑前先查一次 `visibilityState` 与 `innerHeight`，拿不到就直接报「页面当前不可见」而不是截一张过期画面；跑到一半才被切走的，重拍一次仍相同的那些屏会按页面上报的位置保留并在结果里说明（见上面「重复的一屏」），不会再把它后面几万 px 整体上移
- 无限滚动页面会一直滚到不增长为止（最多 400 屏），必要时先关掉页面的“加载更多”
- 分段导出时「复制到剪贴板」只给第 1 段（剪贴板放不下一组图片）；新标签页会把各段都列出来
- 特别长的图（几万像素）浏览器可能拒绝解码显示，新标签页会提示改用磁盘文件；这与拼接和下载无关
- 新标签页 / 剪贴板 / 标注页都依赖后台内存里的缓存，浏览器或后台脚本重启后需要重新截一次（磁盘上的文件不受影响）
- 标注只针对本次结果，不能往标注页里导入别的图片；导出的标注图会重新编码一次，超出 canvas 上限时按比例缩小
- 标注图形存在内存里，刷新结果页就没了；要长期保留请导出文件
- 框选只能圈**当前可见**的那一屏（超出可视区的部分会被夹回来）；要截更长的段落请用范围模式的起点 / 终点标记，或者先滚再重新框选
- 框选命中测试取的是页面上真实可见的元素，`<iframe>` 内部的子元素看不见，也就选不中
- OCR 一次只认一块（选中的框，或贴顶窗口当前显示的那一条），整篇长图要分屏多点几次；识别质量取决于屏幕像素，字小或图糊时先把缩放调到 100% 以上再认
- OCR 只预置了横排简中 + 英文，竖排（`chi_sim_vert`）、日文等其他字符集需要另外往 `ocr/lang/` 里放模型并改 `ocr.js` 的 `LANGS`
- OCR 引擎（wasm + 两个模型）常驻内存不小，所以关掉识别面板就会释放；再点一次会重新加载，首次那 5–15 秒要再等一遍

## OCR 离线包

识别用的是 tesseract.js v7（引擎）+ 它的 wasm core，加上 `chi_sim` / `eng` 两个语言模型，全部 vendored 在 `long-screenshot/ocr/` 里，合计约 7.5 MB —— 这是安装体积的主要来源，换来的是断网也能用、页面像素不出本机。

```
ocr/tesseract.min.js                        页面侧 API
ocr/worker.min.js                           worker 侧调度
ocr/core/tesseract-core-simd-lstm.wasm.js   wasm 引擎（单个文件，不做特性探测）
ocr/lang/chi_sim.traineddata.gz             简体中文字符集（fast）
ocr/lang/eng.traineddata.gz                 英文字符集（fast）
```

引擎三件套取自 npm（`unpkg.com` / `data.jsdelivr.com` / `registry.npmjs.org` 在这台机器上可直连；`cdn.jsdelivr.net` 与 `raw.githubusercontent.com` 会被重置）。语言模型取自 tessdata 的三个档位，下面这批文件就是按 `4.0.0_fast` 原样下载的（字节数完全一致）：

```bash
curl -L -o ocr/tesseract.min.js       https://unpkg.com/tesseract.js@7.0.0/dist/tesseract.min.js
curl -L -o ocr/worker.min.js          https://unpkg.com/tesseract.js@7.0.0/dist/worker.min.js
curl -L -o ocr/core/tesseract-core-simd-lstm.wasm.js \
      https://unpkg.com/tesseract-core-simd-lstm@7.0.0/tesseract-core-simd-lstm.wasm.js
curl -L -o ocr/lang/chi_sim.traineddata.gz https://tessdata.projectnaptha.com/4.0.0_fast/chi_sim.traineddata.gz
curl -L -o ocr/lang/eng.traineddata.gz     https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz
```

> 加新语言要同时改 `ocr.js` 里的 `LANGS`（如 `['chi_sim', 'eng', 'jpn']`）和 `tidy()` 的汉字范围，否则新字符之间的空格不会被合并。
> 档位差别：`4.0.0_fast` 的中文是 1.7 MB，`4.0.0_best` 是 12 MB，`4.0.0`（standard）是 20 MB —— fast 认屏幕上的正常字号已经够用，换 best 主要慢在模型加载和内存，准确率提升有限，所以默认不预置。

## 自测

驱动、拼接、框选层与标注核心的逻辑在 Node 里用假 DOM / 假 canvas 验证（不需要浏览器）：

```bash
node test/make-harness.mjs    # 从 background.js 抽取注入脚本
node test/driver.test.mjs     # 滚动偏移、覆盖完整性、懒加载、还原
node test/render.test.mjs     # 拼接几何、缩放上限、分段、空白自检、区域裁切
node test/background.test.mjs # 后台调度 + 下载回执 + 结果缓存（假 chrome.* 环境）
node test/output.test.mjs     # 剪贴板出口（PNG-only、激活保持、分段只复制第一段）
node test/region.test.mjs     # 框选层交互（拖动、单击选元素、滚轮切父子、坐标换算、还原）
node test/annotate.test.mjs   # 标注核心（图形几何、命中、可视区切片、撤销栈、马赛克/模糊取块、导出缩放）
node test/ocr.test.mjs        # 离线 OCR（启动参数全指向扩展内文件、进度转发、中文空格清洗、引擎释放）
node test/wiring.test.mjs     # 装配自检（manifest/资源/id 都在、CSP 允许 wasm、三处版本号一致）
```

`test/short-page.html`、`test/long-page.html`、`test/container-page.html` 是手工验证用的样例页面（长页 / 无限滚动页 / 内部容器滚动页）。

### 浏览器端到端（需要 Edge）

改完 UI 装配或注入层之后跑这个：它自己起一个 http 服务托管 `test/e2e-page.html`（11584 px 的定长夹具），用 CDP 驱动真实浏览器加载本扩展，走的是 popup → service worker → offscreen → downloads 的生产路径，最后把下载回来的 PNG 解码量尺寸，而不是靠眼睛看。

```bash
node test/browser-e2e.mjs capture     # 滚动截图 + 拼接几何 + 下载落盘
node test/browser-e2e.mjs range       # 两次标记定范围，成品逐行贴回整页图核对位置
node test/browser-e2e.mjs anim        # 页面自带 smooth+snap：上报偏移必须和快门里的行是同一批
node test/browser-e2e.mjs region      # 真实拖框（顶部 / 下滚 / 跨吸顶栏 / 单击选元素）
node test/browser-e2e.mjs container   # 只滚内部容器的页面（Feishu / Notion 那类），侧栏不进图
node test/browser-e2e.mjs container-region  # 容器里的吸顶栏 + 拖框
node test/browser-e2e.mjs dedupe      # 去重判据：直接读离屏文档里正在缓冲的相邻帧行差
node test/browser-e2e.mjs jpeg        # JPEG 与 2× 清晰度档位，和同页 PNG 比体积
node test/browser-e2e.mjs ocr         # 结果页里真跑一次离线识别（CSP / wasm worker / 语言包）
node test/browser-e2e.mjs annotate    # 真实拖拽画矩形和箭头、撤销重做、导出标注文件
node test/browser-e2e.mjs clipboard   # 复制：拦下交给剪贴板 API 的 PNG 量尺寸（LS_HEADED=1 才读回系统剪贴板）
node test/browser-e2e.mjs cancel      # 跑到一半点停止：状态要回 idle，页面样式要还原
node test/browser-e2e.mjs stale       # 杀掉 service worker 后结果页给兜底提示而不是白屏
node test/browser-e2e.mjs all         # 十三段连着跑（每段都先自己截一次图）
```

- 用 `BROWSER_BIN` 指浏览器，默认 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`；带品牌的 Chrome 从 137 起忽略 `--load-extension`，所以只能拿 Edge 跑。
- 检查项包括：拼接宽度＝滚动根的内容盒宽（文档页就是可视区宽减掉滚动条，容器页是容器自己的 clientWidth）、总高度±一屏、没有整屏重复带、选定范围的高度与逐行对齐、框选裁掉的列数、吸顶栏覆盖的那几十行按屏幕原样保留、OCR 置信度 ≥45、导出图里能数出红色像素。
- 全程用临时配置目录（`LS_PROFILE`），不会碰你日常使用的浏览器；扩展 id 从该目录的 `Secure Preferences` 里按路径反查。
- 弹窗必须开在**另一个窗口**里（`up()` 用 `newWindow` 开一次并复用）：`captureVisibleTab` 抓的是目标所在窗口的可见标签，弹窗和页面同窗就会互相挡。
- 启动时会断言「端口上就是本次启动的浏览器」：上一轮没退干净的 Edge 会占着同一个 CDP 端口，它的窗口不在前台，抓回来的像素属于另一个滚动位置 —— 那种失败长得和成品错位一模一样，只能先把旧进程收掉（`shutdown()` 会在 SIGKILL 之后补一次 `taskkill /T`）。
- 无头模式（默认）下 Chrome 把系统剪贴板换成了进程内的桩：`clipboard.write` 会成功、弹窗会说「已复制」，但 Windows 剪贴板里什么都没有。所以 `clipboard` 阶段判据是**拦下交给剪贴板 API 的那个 PNG**（类型、体积、尺寸），要连系统一起验就加 `LS_HEADED=1`。
- `LS_HEADED=1` 需要这台机器上真的有一个前台窗口：远程/无人值守的会话里窗口拿不到前台，后台会直接报「页面当前不可见（窗口被最小化或遮挡）」而不是拼出一张错位的图 —— 这句报错本身就是要验的行为，跑之前先把那扇 Edge 窗口点到最前。

> 说明：Node 侧覆盖的是几何、状态机与绘制顺序；canvas / clipboard / downloads 的 DOM 胶水层只能在真实浏览器里验证 —— 上面这些阶段就是用来抓这类只在浏览器里才炸的问题的（例如 `edit.js` 里写错一个变量名，Node 全绿但结果页一个编辑器都建不出来；又例如页面被切走的一瞬间 `captureVisibleTab` 抛 `Cannot access contents of url ""`，Node 侧永远见不到它毁掉一整轮截图）。

## 排查

- **弹窗底部会显示后台版本号**（例如 `后台版本 1.5.6`）。如果变成黄色提示条，说明改完代码后后台脚本没有被替换 —— 到 `chrome://extensions` 点该扩展卡片上的 **↻**，然后**关掉弹窗重新打开**（弹窗本身每次都是从磁盘重新读的，所以只有它显示的版本会立刻变新）。
- 勾选「下载前询问保存位置」时，文件位置由保存对话框决定，`LongShot` 子目录只是默认值；对话框被取消会直接报「未写出文件」。
- 显示「保存失败：文件被浏览器安全策略拦截」时改用 JPEG，或把清晰度设为 1×。
- 找不到文件时点弹窗里的 **打开所在文件夹**，或在浏览器地址栏输入 `chrome://downloads` 查看真实路径。
- 结果页显示「后台脚本已经重启」：内存里的图片没了（blob 的生命周期等于 service worker），标注无从下手 —— 重新截一次即可。
- 「复制标注图」点了没反应：剪贴板要求页面处于前台且刚发生点击；先点一下结果页再试，或直接用「导出文件」。
- 导出的标注图比原图小：长图超出了 canvas 上限（高 32000 px / 面积 9600 万 px），提示里会给出实际缩放比例。
- 点「识别文字」报「OCR 引擎启动失败」：九成是扩展没有被真正重载（`chrome://extensions` → ↻，然后关掉结果页重新打开）；F12 的 Console 里若同时出现 CSP 报错，说明 manifest 的 `extension_pages` 缺了 `wasm-unsafe-eval`，或 `ocr/` 目录里的文件少了、路径被改过。
- 「这一块里没识别到文字」：认的是屏幕像素，先把缩放调到 100% 以上、用矩形框住那一小段再点；跨栏、渐变底、艺术字都会拉低准确率。
- 出来一堆乱码、置信度只有 10–20%：多半是输入而不是引擎 —— 同一套 core + fast 模型在 Node 里直接认中文截图可以到 70% 以上（`chi_sim` 走 `4.0.0_fast`，见「OCR 离线包」）。深色底的页面是 fast 模型最弱的一类输入，先把缩放调到 100% 以上、只框住一行文字；实在不行就分几次认，别一次框半屏。
