# 批量提交助手(batch-submit)代码逐行详解(小白版)

> 对应版本:v0.3.2。本文把 `batch-submit` 目录下每个文件的每一行都解释了一遍。
> 这是我读代码后写的说明,**没有在真实的标注平台上运行验证过**,点击流程是否适配你们的平台,以首次试运行的结果为准。

---

## 0. 先搞懂几个基础概念

| 名词 | 大白话解释 |
|---|---|
| **浏览器扩展** | 装在 Chrome/Edge 里的小程序,能读写网页、控制标签页 |
| **manifest.json** | 扩展的"身份证 + 权限申请单",浏览器先看它才知道这个扩展是什么、能干什么 |
| **popup(弹窗)** | 点工具栏图标弹出来的小界面,就是一个小网页(`popup.html` + `popup.js`)。**一失去焦点就会被销毁**,所以不能在里面放长时间运行的任务 |
| **service worker(后台脚本)** | `background.js`,躲在后台干活的脚本。没有界面,闲置久了会被浏览器杀掉 |
| **注入(inject)** | 把一段脚本"塞进"某个网页里运行,这样脚本就能像人一样点击那个网页上的按钮 |
| **消息(message)** | 弹窗、后台、被注入的页面脚本是三个互相隔离的环境,它们靠 `chrome.runtime.sendMessage` 互相发消息通信 |
| **DOM** | 网页的结构树。网页上每个按钮、文字都是 DOM 里的一个"元素",脚本通过它找到并操作按钮 |
| **async / await** | 让"要等一会儿才有结果"的操作(比如等弹窗出现)写起来像按顺序执行。`await xxx` 就是"在这里等 xxx 完成再往下" |
| **Promise** | "将来会有结果"的承诺。可能成功(resolve)也可能失败(reject) |

### 三个角色怎么配合

```
 ┌──────────┐  START / STOP    ┌──────────────┐  executeScript   ┌──────────────┐
 │ popup.js │ ───────────────▶ │ background.js │ ───────────────▶ │  inject.js   │
 │ (界面)    │ ◀─── 读 storage ─ │ (调度、记状态) │ ◀── PHASE/RESULT ─│ (页面里点按钮)│
 └──────────┘                  └──────────────┘                   └──────────────┘
```

- `popup.js`:你操作的界面,只负责发指令和显示进度。
- `background.js`:总指挥,安排多个标签页同时跑,并把进度写进 `chrome.storage.session`。
- `inject.js`:真正在网页里"动手点按钮"的人。

### 文件清单

| 文件 | 作用 |
|---|---|
| `manifest.json` | 扩展的身份证和权限 |
| `popup.html` | 弹窗的界面(HTML + CSS) |
| `popup.js` | 弹窗的逻辑 |
| `background.js` | 后台调度 |
| `inject.js` | 被注入网页、执行点击的脚本 |
| `README.txt` | 安装和使用说明 |

---

## 1. manifest.json —— 扩展的身份证

JSON 格式不允许写注释,所以这里用表格逐行解释。

```json
{
  "manifest_version": 3,
  "name": "批量提交助手",
  "version": "0.3.2",
  "description": "在标注平台的多个任务标签页中批量执行提交流程:提交 → 选择「质检通过」→ 确认提交 → 返回主页",
  "minimum_chrome_version": "102",
  "permissions": ["scripting", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html", "default_title": "批量提交助手" }
}
```

| 行 | 含义 |
|---|---|
| `"manifest_version": 3` | 使用第 3 代扩展规范(目前 Chrome/Edge 的标准)。它规定后台脚本必须是会被回收的 service worker |
| `"name"` | 扩展显示的名字 |
| `"version": "0.3.2"` | 版本号,你自己用来区分新旧 |
| `"description"` | 扩展管理页里显示的一句话介绍 |
| `"minimum_chrome_version": "102"` | 要求浏览器版本 ≥ 102。因为代码用到了 `chrome.storage.session`,它从 102 才有 |
| `"permissions": ["scripting", "storage"]` | 申请两项能力:`scripting` = 能往网页里注入脚本;`storage` = 能用浏览器的存储 |
| `"host_permissions": ["<all_urls>"]` | 申请"能访问所有网站"。因为注入脚本要有目标网站的访问权,而你的标注平台域名不固定,所以写成所有网站 |
| `"background": {...}` | 声明后台脚本文件是 `background.js` |
| `"action": {...}` | 声明工具栏图标:点开弹出 `popup.html`,鼠标悬停显示"批量提交" |

**注意**:没有 `content_scripts` 字段,说明这个扩展**不会常驻在每个网页里**,只在你点"开始"后才临时注入目标标签页。

---

## 2. popup.html —— 弹窗的界面

HTML 负责"有哪些控件",CSS(`<style>` 里)负责"长什么样"。

### 2.1 文档头部

```html
<!doctype html>                      <!-- 声明这是 HTML5 文档 -->
<html lang="zh-CN">                  <!-- 根标签,语言是简体中文 -->
<head>                               <!-- 头部:放不显示的信息 -->
<meta charset="utf-8">               <!-- 用 UTF-8 编码,中文才不乱码 -->
<title>批量提交助手</title>               <!-- 页面标题 -->
<style>                              <!-- 下面是 CSS 样式 -->
```

### 2.2 CSS 样式(逐行)

```css
/* 让浏览器把表单控件(复选框、数字框)也画成深色风格,配合深色背景 */
:root { color-scheme: dark; }

/* body = 整个页面:宽 380 像素,外边距 0,内边距上12/左右14/下14;
   字体 13px、行高 1.6,优先用系统字体、苹方、微软雅黑;文字浅灰白,背景深灰蓝 */
body { width: 380px; margin: 0; padding: 12px 14px 14px; font: 13px/1.6 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; color: #e6e9ee; background: #1b1f26; }

/* 凡是带 hidden 属性的元素一律不显示,!important 表示优先级最高,
   防止其他样式把它"又显示出来" */
[hidden] { display: none !important; }

/* 标题:无外边距(底部留 10px),字号 15px */
h1 { margin: 0 0 10px; font-size: 15px; }

/* .row = 一行控件:横向排列(flex),垂直居中,控件间隔 6px,上下外边距 6px,放不下就换行 */
.row { display: flex; align-items: center; gap: 6px; margin: 6px 0; flex-wrap: wrap; }

/* .dim = 次要文字,用灰色 */
.dim { color: #98a2b3; }

/* 数字框、文本框:深色背景、继承文字颜色、细边框、圆角 6px、内边距、继承字体 */
input[type="number"], input[type="text"] { background: #11141a; color: inherit; border: 1px solid #2c333d; border-radius: 6px; padding: 2px 6px; font: inherit; }

/* 数字框宽度固定 56px */
input[type="number"] { width: 56px; }

/* 文本框占满一行剩余空间(flex:1),min-width:0 防止被内容撑破 */
input[type="text"] { flex: 1; min-width: 0; }

/* 普通按钮:细边框、透明背景、圆角、鼠标移上去变手形、继承字体 */
button { border: 1px solid #2c333d; background: transparent; color: inherit; border-radius: 6px; padding: 5px 14px; cursor: pointer; font: inherit; }

/* 主按钮(开始执行):蓝底白字 */
button.primary { background: #2f8cff; border-color: #2f8cff; color: #fff; }

/* 被禁用的按钮:半透明,鼠标移上去显示"禁止"图标 */
button:disabled { opacity: .5; cursor: not-allowed; }

/* 分隔线:去掉默认边框,只留上边一条细线 */
hr { border: 0; border-top: 1px solid #2c333d; margin: 10px 0; }

/* 进度条:占满宽度,高 8px */
progress { width: 100%; height: 8px; margin: 6px 0; }

/* 列表:去掉圆点,无边距,最高 260px,超出部分出现竖向滚动条 */
ul { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; }

/* 列表项:一张"卡片"。网格布局两列:左边 60px 放状态,右边放任务名;可点击 */
li { padding: 4px 8px; margin-bottom: 3px; border-radius: 6px; background: #232a33; cursor: pointer; display: grid; grid-template-columns: 60px 1fr; gap: 6px; }

/* 卡片里的小字(报错信息):放第 2 列(标题下方),灰色,允许任意位置换行 */
li small { grid-column: 2; color: #98a2b3; word-break: break-all; }

/* 标题(.t):任务名很长、前半段都一样,所以不截断,允许任意位置换行,保证能看到最后的编号 */
li .t { word-break: break-all; }

/* 状态文字(.s)按状态上色:失败=红;待确认/已跳过=黄;成功/预检通过=绿;处理中=蓝 */
li.error .s { color: #ff6b6f; } li.unknown .s, li.skipped .s { color: #f2b84b; }
li.success .s, li.ready .s { color: #5fd3a0; } li.running .s { color: #2f8cff; }
```

### 2.3 页面主体(逐行)

```html
</style>
</head>
<body>                                         <!-- 主体:真正显示的内容 -->
  <h1>批量提交助手</h1>                         <!-- 大标题 -->

  <!-- 文本框 id="host":域名筛选。留空 = 全部域名;填了只处理域名里含这段文字的标签页 -->
  <div class="row">域名筛选 <input type="text" id="host" placeholder="留空表示全部域名" spellcheck="false" autocomplete="off"></div>
  <div class="row">
    <!-- 数字框 id="limit":处理上限,0 表示不限,范围 0~500 -->
    处理上限 <input type="number" id="limit" min="0" max="500"><span class="dim">(0 表示不限)</span>
    <!-- 数字框 id="concurrency":并发数(同时处理几个标签页),范围 1~10 -->
    并发数 <input type="number" id="concurrency" min="1" max="10">
  </div>
  <!-- 复选框 id="dry":勾上 = 试运行(走到最后一步但不真提交)。每次打开都不勾选 -->
  <label class="row"><input type="checkbox" id="dry"> 试运行模式(执行至最终提交前停止,不实际提交)</label>
  <!-- id="count":显示"检测到 X 个任务页,本次将处理 Y 个",由 popup.js 填写 -->
  <div class="row dim" id="count">正在检测任务页</div>

  <div class="row">
    <button id="start" class="primary">开始执行</button>   <!-- 开始按钮,点了扩展窗口立刻关闭 -->
    <!-- 重试失败项:默认隐藏(hidden),有可重试的才显示 -->
    <button id="retry" hidden title="仅重试最终提交前失败的标签页;提交后失败或待确认的不会重试">重试失败项</button>
    <button id="stop" hidden>停止</button>              <!-- 停止:只在运行中显示 -->
    <button id="clear">清空记录</button>                <!-- 清空上次运行的记录 -->
  </div>

  <div class="dim" id="hint"></div>             <!-- 提示文字(比如"未检测到任务页") -->

  <hr>                                          <!-- 分隔线 -->
  <div id="summary" class="dim">暂无执行记录</div>     <!-- 汇总:如 进度 3/10 · 成功 3 -->
  <progress id="bar" value="0" max="1"></progress>    <!-- 进度条,没有运行记录时隐藏 -->
  <ul id="list"></ul>                           <!-- 每个任务一行的结果列表,由 popup.js 动态生成 -->

  <script src="popup.js"></script>              <!-- 最后加载 popup.js,让它能找到上面所有 id 的控件 -->
</body>
</html>
```

> 为什么 `<script>` 放最后?因为 JS 一加载就要去找 `id="dry"` 这些控件,放最后才能保证控件已经存在。

---

## 3. background.js —— 后台总指挥

它的职责:接收弹窗的"开始/停止"指令 → 安排多个标签页同时处理 → 收集每个页面汇报的进度和结果 → 把状态存起来给弹窗显示。

### 3.1 文件开头:消息约定

```js
// background.js —— 调度:同时处理 N 个标签页,把每页的状态写进 chrome.storage.session 给 popup 显示。
//
// 消息约定(三方互相发的消息格式)
//   popup → 后台  { type:'START', options:{dryRun, concurrency}, tabs:[{id,title}] }   开始
//                 { type:'STOP' }                                                      停止(已点最终提交的页面不受影响)
//   页面 → 后台   { type:'PHASE', text, phase? }   进度文字;phase:'final-clicked' 表示马上要点最终提交
//                 { type:'RESULT', result }        成功结果(页面随后会跳走,所以要先报)
//   存储 'run'    { state:'running'|'done'|'stopped', total, done, counts, note, dryRun,
//                   items:[{tabId,title,status,message,afterFinal}] }
//   (run 就是"本次运行的全部状态",popup 从存储里读它来画界面)

'use strict';   // 严格模式:让 JS 对写错的代码(比如用了没声明的变量)直接报错,而不是悄悄放过
```

### 3.2 常量和全局变量

```js
const MAX_CONSECUTIVE_FAILS = 3;            // 连续失败这么多个就整体停下(熔断,防止一直出错还硬提交)
const TAB_WATCHDOG_MS = 4 * 60 * 1000;      // 单个标签页最长处理时间:4 分钟(单位毫秒)。超时就放弃等待
const LOAD_WAIT_MS = 60 * 1000;             // 等标签页加载完的最长时间:60 秒

let run = null;                              // 当前运行状态(内存里一份,同时写进 storage)。null = 还没开始过
let stopRequested = false;                   // 有没有人要求停止(用户点停止,或连续失败触发熔断)
let stopReason = '';                         // 停止的原因文字,显示给用户
let keepAliveTimer = null;                   // "保活定时器"的编号,后面用来取消它
const waiters = new Map();                   // 字典:标签页 id → 它的"等待记录" { finalClicked, resolve }

// 这些是"已经有最终结论"的状态。凡是在这个集合里的,就算这个标签页处理完了
const TERMINAL = new Set(['success', 'ready', 'error', 'unknown', 'skipped']);
```

> `let` 声明可以改的变量,`const` 声明不能重新赋值的变量。`Map`、`Set` 是 JS 内置的"字典"和"集合"。

### 3.3 状态保存

```js
/* ---------- 状态保存 ---------- */

function summarize() {                       // 统计函数:数一数各种结果各有几个
  const counts = { success: 0, ready: 0, error: 0, unknown: 0, skipped: 0 };  // 5 种结果的计数器,初始都是 0
  let done = 0;                              // 已经处理完的数量
  for (const it of run.items) {              // 遍历本次运行里的每个标签页记录(it = item)
    if (TERMINAL.has(it.status)) { done++; counts[it.status]++; }  // 状态是"最终态"就算处理完:总数+1,对应类别+1
  }
  run.done = done;                           // 把统计结果写回 run
  run.counts = counts;
}

let saving = Promise.resolve();              // 一条"保存队列"。先放一个已完成的承诺当起点
function save() {                            // 把 run 存进浏览器存储
  if (!run) return saving;                   // 还没有 run 就什么都不用存
  summarize();                               // 存之前先重新统计一遍数量
  const snapshot = JSON.parse(JSON.stringify(run));  // 做一份"深拷贝快照"(转成文本再转回来),避免存的时候 run 又被改了
  // 排队保存:等上一次保存完成后,再存这一次;存失败就忽略(.catch(() => {}))。排队是为了保证后写的覆盖先写的,顺序不乱
  saving = saving.then(() => chrome.storage.session.set({ run: snapshot })).catch(() => {});
  return saving;                             // 返回承诺,调用者可以 await 等保存完成
}

function setItem(item, patch) {              // 修改某个标签页记录的若干字段,并保存
  Object.assign(item, patch);                // 把 patch 里的字段(如 status、message)覆盖到 item 上
  return save();                             // 然后保存
}
```

> `chrome.storage.session` 是"会话存储":关闭浏览器就清空,但后台脚本被回收重启后还在。弹窗关掉再打开也能从这里读到进度。

### 3.4 后台被浏览器回收后的善后

```js
/* ---------- 后台被浏览器回收后的善后 ---------- */
// 后台脚本空闲太久会被浏览器杀掉。如果杀掉时还有任务在跑,重启后我们不知道结果,
// 必须诚实地标成「待确认」,绝不能当成功或失败,更不能自动重试。
(async function recover() {                  // 定义一个异步函数并立刻执行(后台脚本每次启动都会跑一次)
  const { run: saved } = await chrome.storage.session.get('run');  // 从存储里取出上次保存的 run,叫它 saved
  // 没必要善后的情况:内存里已有 run(说明这次启动是为了开始新任务)/ 存储里没有 / 存的状态不是"运行中"
  if (run || !saved || saved.state !== 'running') return;
  for (const it of saved.items) {            // 逐个检查上次的标签页记录
    if (it.status === 'running') {           // 当时正在处理的:不知道到底提交没有
      it.status = 'unknown';                 // 诚实地标成"待确认"
      it.message = '扩展后台进程被浏览器重启,提交状态未知。请人工核实,切勿重复提交';
    } else if (it.status === 'pending') {    // 还在排队、没开始的:肯定没动过
      it.status = 'skipped';                 // 标成"已跳过"
      it.message = '扩展后台进程被浏览器重启,未处理';
    }
  }
  saved.state = 'stopped';                   // 整次运行标为"已停止"
  saved.note = '后台进程重启,任务已中断';
  run = saved;                               // 把它装进内存里的 run
  await save();                              // 并保存
})();
```

### 3.5 工具函数

```js
/* ---------- 工具 ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));   // 睡眠函数:await sleep(500) = 等 500 毫秒再继续

function startKeepAlive() {                  // 开启"保活"
  stopKeepAlive();                           // 先停掉可能存在的旧定时器,避免重复
  // 有任务在跑时,每 20 秒调用一次无害的扩展 API,让浏览器以为后台脚本"还在忙",不要把它回收掉
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
}
function stopKeepAlive() { clearInterval(keepAliveTimer); keepAliveTimer = null; }  // 关闭保活

// 确保标签页已经加载:被浏览器休眠(discarded)的先刷新;还在加载的等它加载完
async function ensureLoaded(tabId) {
  let tab = await chrome.tabs.get(tabId);    // 读取这个标签页的当前信息
  if (tab.discarded) await chrome.tabs.reload(tabId);   // 如果被浏览器"休眠"丢弃了(省内存),先刷新唤醒
  const t0 = Date.now();                     // 记下开始等待的时刻
  for (;;) {                                 // 死循环,直到满足条件 return
    tab = await chrome.tabs.get(tabId);      // 重新读取最新状态
    if (tab.status === 'complete' && !tab.discarded) return;   // 加载完成且没休眠 → 可以开始了
    if (Date.now() - t0 > LOAD_WAIT_MS) return; // 等了超过 60 秒也不再等;单页应用往往早就能用了,让页面里的脚本自己等元素
    await sleep(500);                        // 每 500 毫秒检查一次
  }
}
```

### 3.6 处理单个标签页(核心)

```js
/* ---------- 处理单个标签页 ---------- */

async function processItem(item, options) {  // item = 这个标签页的记录;options = {dryRun, concurrency}
  const tabId = item.tabId;                  // 取出标签页 id
  await setItem(item, { status: 'running', message: '准备中' });   // 标记为"进行中"并保存,弹窗立刻能看到

  let tab;
  try { tab = await chrome.tabs.get(tabId); }   // 尝试获取标签页
  catch { return setItem(item, { status: 'skipped', message: '标签页已关闭' }); }  // 获取失败 = 已被关掉,标"已跳过"并结束
  if (!/^https?:/i.test(tab.url || '')) {    // 网址不是 http/https 开头(比如 edge:// 内置页)
    return setItem(item, { status: 'skipped', message: '非网页标签页,无法处理' });  // 注入不了,跳过
  }

  try { await ensureLoaded(tabId); }         // 确保标签页加载好
  catch { return setItem(item, { status: 'skipped', message: '标签页已关闭' }); }  // 加载期间被关了,跳过

  // 为这个标签页准备一个"等待记录":finalClicked 记录页面是否已点过最终提交;resolve 是收到成功结果时要调用的函数
  const waiter = { finalClicked: false, resolve: null };
  // 创建一个承诺 resultMsg:当页面发来 RESULT 消息时(调用 waiter.resolve),这个承诺就完成
  const resultMsg = new Promise(resolve => { waiter.resolve = resolve; });
  waiters.set(tabId, waiter);                // 登记到全局字典,这样消息入口能按标签页 id 找到它

  // "看门狗":4 分钟后自动完成,并返回一个带 __watchdog 标记的对象,代表超时了
  const watchdog = new Promise(resolve => setTimeout(() => resolve({ __watchdog: true }), TAB_WATCHDOG_MS));
  const injected = (async () => {            // "注入并执行"这件事,包装成一个异步任务
    // 第 1 步:把 inject.js 注入到该标签页(执行后,页面里就有了 window.__bs)
    await chrome.scripting.executeScript({ target: { tabId }, files: ['inject.js'] });
    // 第 2 步:在页面里调用 window.__bs.run(...),真正开始点击流程;dryRun 转成布尔值传进去
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: opts => window.__bs.run(opts),
      args: [{ dryRun: !!options.dryRun }],
    });
    return r && r.result;                    // 返回页面脚本给出的结果
  })().catch(e => ({ __error: e && e.message ? e.message : String(e) }));  // 任何出错都转成 {__error: 报错文字},不让它直接抛出

  // 三个承诺"赛跑",谁先完成就用谁的结果:
  //   resultMsg = 页面主动汇报的成功;injected = 脚本执行完返回的结果;watchdog = 超时
  let res = await Promise.race([resultMsg, injected, watchdog]);
  waiters.delete(tabId);                     // 赛跑结束,删掉等待记录

  // 整理结果。凡是已经点过最终提交、又没拿到明确结果的,一律「待确认」
  const after = waiter.finalClicked;         // 是否已点过最终提交
  // 如果:没结果 / 是错误 / 是超时 / 状态不在"最终态"里 —— 说明没拿到明确结论
  if (!res || res.__error || res.__watchdog || !TERMINAL.has(res.status)) {
    let why;                                 // 原因文字
    if (!res) why = '页面在处理过程中跳转或关闭,未获取到结果';
    else if (res.__watchdog) why = '处理超时(超过 ' + TAB_WATCHDOG_MS / 60000 + ' 分钟)';
    else if (res.__error) why = res.__error;
    else why = '页面返回结果无法识别';
    res = after                              // 关键判断:
      ? { status: 'unknown', afterFinal: true, message: why + '。已执行最终提交,请人工核实提交状态,切勿重复提交' }  // 点过最终提交 → 待确认(不能重试!)
      : { status: 'error', message: why };   // 还没点最终提交 → 普通失败(可以重试)
  }
  await setItem(item, { status: res.status, message: res.message || '', afterFinal: !!res.afterFinal });  // 把最终结果存下来
}
```

> **为什么"点过最终提交后没结果"必须标待确认,而不是失败?** 因为提交可能已经成功只是页面没来得及告诉我们。若标成失败并允许重试,可能造成**重复提交**。

### 3.7 一次运行

```js
/* ---------- 一次运行 ---------- */

async function startRun({ options, tabs }) { // 参数是弹窗发来的 START 消息(解构出 options 和 tabs)
  stopRequested = false;                     // 重置停止标志
  stopReason = '';
  // 把每个标签页转成一条记录,初始状态都是 pending(排队中)
  const items = tabs.map(t => ({ tabId: t.id, title: t.title || '(无标题)', status: 'pending', message: '', afterFinal: false }));
  run = { state: 'running', total: items.length, done: 0, counts: {}, note: '', dryRun: !!options.dryRun, items };  // 创建 run
  await save();                              // 保存,弹窗就能看到"0/总数"
  startKeepAlive();                          // 开启保活,防止后台被回收

  const queue = items.slice();               // 复制一份作为"待办队列"
  let fails = 0;                             // 连续失败计数
  const worker = async () => {               // 一个"工人":不停从队列取标签页处理
    while (!stopRequested && queue.length) { // 没人叫停且队列还有活
      const item = queue.shift();            // 取出队首(取走后别的工人就拿不到它了,避免重复处理)
      await processItem(item, options);      // 处理这个标签页,等它完成
      if (item.status === 'error' || item.status === 'unknown') {   // 失败或待确认
        if (++fails >= MAX_CONSECUTIVE_FAILS) {   // 连续失败计数+1,达到 3 次就熔断
          stopRequested = true;              // 叫停所有工人
          stopReason = '连续 ' + MAX_CONSECUTIVE_FAILS + ' 项失败,已自动终止';
        }
      } else if (item.status === 'success' || item.status === 'ready') {
        fails = 0;                           // 成功一个,连续失败计数清零
      }
    }
  };
  // 并发数:取弹窗传来的值,限制在 1~10 之间;`| 0` 把它转成整数,转不成就用默认 5
  const n = Math.max(1, Math.min(10, options.concurrency | 0 || 5));
  // 同时启动 n 个工人(但不超过标签页总数),等所有工人都干完
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));

  for (const it of items) {                  // 所有工人收工后,还在 pending 的就是没被处理的
    if (it.status === 'pending') { it.status = 'skipped'; it.message = stopReason || '已停止,未处理'; }
  }
  run.state = stopRequested ? 'stopped' : 'done';   // 有人叫停 → stopped,否则 → done
  run.note = stopReason;
  stopKeepAlive();                           // 关闭保活
  await save();                              // 最后保存一次
}
```

### 3.8 停止

```js
async function stopAll() {                   // 用户点"停止"时执行
  if (!run || run.state !== 'running') return;   // 没在运行就什么都不做
  stopRequested = true;                      // 告诉工人:别再取新活了
  // 通知正在跑的页面:还没点最终提交的就地中止
  for (const it of run.items) {
    if (it.status !== 'running') continue;   // 只处理"进行中"的
    chrome.scripting.executeScript({         // 往页面里执行一小段代码
      target: { tabId: it.tabId },
      func: () => { if (window.__bs) window.__bs.abort = true; },   // 把页面里的 abort 标志设为 true
    }).catch(() => {});                      // 失败(比如页面已关)就忽略
  }
}
```

> 页面脚本每次检查条件时都看一眼 `abort`,为 true 就中止。但一旦点了最终提交(`locked`),就不再响应停止。

### 3.9 消息入口

```js
/* ---------- 消息入口 ---------- */

// 注册一个"收消息"的监听器。别的脚本调用 chrome.runtime.sendMessage 时,这里会被触发
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;    // 消息不是对象就不理

  if (msg.type === 'START') {                // 来自弹窗:开始
    if (run && run.state === 'running') { sendResponse({ ok: false, error: '已有任务正在执行' }); return; }  // 已有任务在跑,拒绝
    sendResponse({ ok: true });              // 先回复"收到"(不等任务做完,否则弹窗要一直等)
    startRun(msg).catch(async e => {         // 开始运行;如果运行过程抛出意外错误:
      if (run) { run.state = 'stopped'; run.note = '后台异常:' + e.message; stopKeepAlive(); await save(); }
    });
    return;
  }

  if (msg.type === 'STOP') {                 // 来自弹窗:停止
    stopAll();
    sendResponse({ ok: true });
    return;
  }

  // 以下消息来自被注入的页面
  const tabId = sender.tab && sender.tab.id; // sender.tab 是发消息的那个标签页,取它的 id
  const waiter = tabId != null && waiters.get(tabId);   // 找到这个标签页的等待记录
  if (!waiter || !run) { sendResponse({ ok: false }); return; }   // 没有记录(不是我们派出去的页面)就拒绝
  const item = run.items.find(i => i.tabId === tabId);  // 找到对应的运行记录

  if (msg.type === 'PHASE') {                // 页面汇报进度
    if (msg.phase === 'final-clicked') waiter.finalClicked = true; // 先记下"要点最终提交了",再回执,页面收到回执后才点
    if (item && msg.text) setItem(item, { message: msg.text });    // 把进度文字存下来,弹窗会显示
    sendResponse({ ok: true });              // 回执
    return;
  }

  if (msg.type === 'RESULT') {               // 页面汇报成功结果
    waiter.resolve(msg.result);              // 让 processItem 里的 resultMsg 承诺完成,赛跑有了结果
    sendResponse({ ok: true });
  }
});
```

> **为什么 `final-clicked` 要"先记下、再回执、页面收到才点"?** 这样即使点击瞬间页面就跳转了,后台也已经知道"这个页面点过最终提交",就不会误判成可重试的普通失败。

---
## 4. inject.js —— 在网页里"动手点按钮"

这个文件被后台注入到每个标签页里,模拟人的操作:找按钮 → 点 → 等弹窗 → 选下拉 → 点确认 → 等结果。

### 4.1 文件头与防重复

```js
// inject.js —— 被后台注入到每个标签页里,在页面内执行点击流程。
// 流程:顶栏「提交」→ 弹窗里确认下拉是「质检通过」→ 弹窗「提交」→ 出现「提交任务成功」→ 点「返回主页领取新任务」
//
// 返回 { status, message, afterFinal }
//   ready    试运行走通了(没有真提交)
//   success  提交成功
//   error    出错,留给人处理(afterFinal=true 表示已经点过最终提交,服务端报了错)
//   skipped  前置条件不满足 / 被停止,没有动任何东西
//   unknown  点了最终提交但没等到结果,不知道成没成 —— 必须人工确认,不要重试
//
// 页面文案如果和你们平台不一致,只改下面的 CFG,其余不用动。
(() => {                                     // 立即执行函数:把所有变量包在里面,不污染网页自己的变量
  if (window.__bs && window.__bs.running) return;   // 如果这个页面里已经有一份在运行,就不要覆盖它,直接退出
```

### 4.2 配置 CFG(想适配别的平台就改这里)

```js
  const CFG = {
    TARGET: '质检通过',              // 要在下拉框里选中的选项文字
    READY_TEXT: '任务有效',          // 页面上必须出现的状态文字,没有就跳过;填 '' 关闭这个检查
    TOP_BTN: '提交',                 // 页面顶栏那个"提交"按钮的文字
    CONFIRM_HINT: '是否提交',        // 确认弹窗里的一句话,用来认出"这就是确认弹窗"
    OK_BTN: '提交',                  // 确认弹窗里的"提交"按钮文字
    CANCEL_BTN: '取消',              // 试运行时用它关掉弹窗
    SUCCESS_TEXT: '提交任务成功',    // 成功弹窗里的文字
    HOME_BTN: '返回主页领取新任务',  // 成功弹窗里的按钮文字
    // 各步骤最长等待(毫秒)。你们网络慢,所以给得很宽
    //   page 等页面出现提交按钮 30秒 / tag 等"任务有效"文字 8秒 / dialog 等确认弹窗 30秒
    //   option 等下拉选项 4秒 / value 等选中后的值 8秒 / final 点最终提交后等结果 30秒
    T: { page: 30000, tag: 8000, dialog: 30000, option: 4000, value: 8000, final: 30000 },
  };

  // 在 window 上挂一个对象 __bs(batch-submit 的缩写),后台通过 window.__bs.run(...) 来启动流程
  // running=是否在运行;abort=是否被要求中止;locked=是否已点最终提交(锁定后不再响应中止)
  const bs = (window.__bs = { running: false, abort: false, locked: false, run });
```

### 4.3 小工具函数

```js
  /* ---------------- 小工具 ---------------- */

  // antd 会在两个汉字的按钮里自动插空格("提 交"),所以比较前先去掉所有空白
  // \s 表示任何空白字符(空格、换行、制表符),+ 表示一个或多个,g 表示全部替换
  const norm = s => (s || '').replace(/\s+/g, '');

  // 真正看得见:有宽高、没被 display:none / visibility:hidden。
  // (antd 的无障碍隐藏列表高度为 0,弹窗关闭后是 display:none,都会被判为不可见)
  const isVisible = el => {
    if (!el || !el.isConnected) return false;       // 元素不存在,或已从页面上被移除 → 不可见
    const r = el.getBoundingClientRect();            // 获取元素在屏幕上的位置和大小
    if (!r.width || !r.height) return false;         // 宽或高为 0 → 不可见
    const cs = getComputedStyle(el);                 // 获取元素最终生效的样式
    return cs.display !== 'none' && cs.visibility !== 'hidden';   // 没被隐藏才算可见
  };

  // 按钮是否被禁用:有 disabled 属性、aria-disabled 为 true、或带 antd 的禁用样式类
  const isDisabled = el =>
    !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('ant-btn-disabled'));
```

### 4.4 waitFor:等某个条件成立

> 页面不会瞬间出现你要的弹窗,所以需要"等"。这个函数反复检查条件,成立就返回,超时就报错。

```js
  // 等条件成立。用 MutationObserver 触发检查(后台标签页的定时器会被浏览器降频,
  // 但 DOM 变化的回调不受影响),定时器只做兜底。
  function waitFor(check, { timeout, label }) {      // check = 返回"真值"就表示条件成立的函数;timeout = 最长等多久;label = 超时时显示的名称
    return new Promise((resolve, reject) => {
      let done = false;                              // 是否已经结束(防止重复结束)
      let last = 0;                                  // 上次检查的时刻
      let mo, poll, deadline;                        // 观察器、定时器、超时器
      const finish = (fn, v) => {                    // 结束:fn 是 resolve 或 reject,v 是结果
        if (done) return;                            // 已结束就不再处理
        done = true;
        mo.disconnect(); clearInterval(poll); clearTimeout(deadline);   // 清理三样东西
        fn(v);                                       // 交出结果
      };
      const tick = () => {                           // 做一次检查
        if (done) return;
        last = Date.now();                           // 记下检查时刻
        try {
          if (bs.abort && !bs.locked) return finish(reject, new Error('__abort'));   // 被要求中止且还没点最终提交 → 以"__abort"报错结束
          const v = check();                         // 执行条件检查
          if (v) finish(resolve, v);                 // 条件成立 → 成功结束,并把检查到的东西(如按钮)交出去
        } catch (e) { finish(reject, e); }           // 检查过程出错 → 失败结束
      };
      // MutationObserver:监听页面结构变化,一有变化就检查(但两次检查间隔至少 100 毫秒,避免页面狂变时检查太频繁)
      mo = new MutationObserver(() => { if (Date.now() - last >= 100) tick(); });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });  // 监听整个页面的子节点、属性、文字变化
      poll = setInterval(tick, 400);                 // 兜底:每 400 毫秒也检查一次
      deadline = setTimeout(() => finish(reject, new Error('等待超时:' + label)), timeout);   // 超时就报错
      tick();                                        // 先立刻检查一次(也许条件已经成立了)
    });
  }
```

### 4.5 模拟点击

```js
  // 模拟一次完整的鼠标点击。antd 的下拉框监听的是 mousedown,只发 click 打不开
  function realClick(el) {
    const r = el.getBoundingClientRect();            // 取元素位置大小
    // 事件的公共参数:冒泡、可取消、穿透影子 DOM、左键(button 0),点击坐标取元素正中心
    const base = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const P = window.PointerEvent || MouseEvent;     // 优先用指针事件,浏览器不支持就退回鼠标事件
    const fire = (Type, type, extra) => el.dispatchEvent(new Type(type, { ...base, ...extra }));   // 触发一个事件
    // 按真人点击的顺序依次触发:指针按下 → 鼠标按下 → 指针抬起 → 鼠标抬起 → 点击
    fire(P, 'pointerdown', { buttons: 1, pointerType: 'mouse', isPrimary: true });
    fire(MouseEvent, 'mousedown', { buttons: 1 });
    fire(P, 'pointerup', { buttons: 0, pointerType: 'mouse', isPrimary: true });
    fire(MouseEvent, 'mouseup', { buttons: 0 });
    fire(MouseEvent, 'click', { buttons: 0 });
  }
```

### 4.6 找按钮、找弹窗

```js
  // 找按钮:在 scope(默认整个页面)里,找文字等于 text 的、可见的按钮;
  // outside 如果给了,就排除在该选择器内部的按钮(比如排除弹窗里的)
  const findButton = (text, { scope = document, outside = null } = {}) =>
    [...scope.querySelectorAll('button, [role="button"], .ant-btn')].find(    // 候选:所有 button、role=button 的元素、antd 按钮
      b => norm(b.textContent) === norm(text) && isVisible(b) && !(outside && b.closest(outside))   // 文字(去空白后)相等 + 可见 + 不在被排除区域
    ) || null;                                       // 找不到就返回 null

  // 所有"可见的弹窗":role="dialog" 的元素里挑可见的
  const visibleDialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
  // 找包含某段文字的可见弹窗
  const findDialog = text => visibleDialogs().find(d => norm(d.textContent).includes(norm(text))) || null;
```

### 4.7 下拉框相关

```js
  /* ---------------- 下拉框 ---------------- */

  // 找弹窗里的下拉框根元素:优先 antd 的 .ant-select,找不到就找 role="combobox"
  const selectRoot = dialog => dialog.querySelector('.ant-select') || dialog.querySelector('[role="combobox"]');
  // 读下拉框当前选中的值(去空白后)
  const selectValue = root => {
    const item = root.querySelector('.ant-select-selection-item');   // antd 显示选中值的元素
    return norm(item ? item.textContent : root.textContent);         // 有就取它,没有就取整个下拉框文字
  };
  // 只认「可见下拉层」里的选项,不会点到高度为 0 的无障碍隐藏列表;文字必须完全相等,不会误选别的
  const findOption = text => {
    // 候选:antd 下拉层里没被标记为 hidden 的所有选项
    const antd = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')];
    const pool = antd.length ? antd : [...document.querySelectorAll('[role="option"]')];   // antd 没有就退回通用 role="option"
    return pool.find(o => norm(o.textContent) === norm(text) && isVisible(o)) || null;     // 文字完全相等且可见的那个
  };
```

### 4.8 和后台通信

```js
  /* ---------------- 和后台通信 ---------------- */

  const send = msg => {                              // 给后台发消息
    try { return chrome.runtime.sendMessage(msg).catch(() => null); }   // 发送;后台没回应就当作 null
    catch { return Promise.resolve(null); }          // 扩展被重载等原因会同步抛错,同样当作 null
  };
  const step = text => { send({ type: 'PHASE', text }); };   // 汇报一条进度文字(不等回执)
```

### 4.9 提交之后的判断

```js
  /* ---------------- 提交之后的判断 ---------------- */

  // 把文字压成单行(连续空白变成一个空格)、去首尾空白,最多保留 200 字符
  const clip = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  // 弹窗文字:优先取「标题:内容」,取不到再退回整段文字
  const dialogText = d => {
    const t = d.querySelector('.ant-modal-confirm-title, .ant-modal-title');         // 弹窗标题
    const b = d.querySelector('.ant-modal-confirm-content, .ant-modal-body');        // 弹窗正文
    return t && b ? clip(t.textContent) + ':' + clip(b.textContent) : clip(d.textContent);
  };

  // 成功的标志:出现「提交任务成功」弹窗,或带「返回主页领取新任务」按钮的弹窗
  const findSuccess = () => findDialog(CFG.SUCCESS_TEXT) || findDialog(CFG.HOME_BTN);

  // 找提交后的报错,没有返回 null。
  // before = 点最终提交前就开着的弹窗(比如「任务基本信息」),它们不是提交的结果,不算
  // 出现这些词的提示,就当作报错
  const ERROR_WORDS = /失败|错误|异常|无法|不能|缺少|未通过|请先|超时|不允许|没有权限/;
  function scanError(confirmDialog, before) {        // 返回报错文字,或 null(没发现报错)
    // 1. 新出现了别的弹窗(比如二次确认、错误弹窗):不替人做决定,当作需要人处理
    const other = visibleDialogs().find(d => !before.includes(d) &&   // 点提交前就开着的不算
      d !== confirmDialog && !d.contains(confirmDialog) && !confirmDialog.contains(d));   // 排除确认弹窗自己及它的父/子元素
    if (other) return '出现非预期弹窗:' + dialogText(other);

    // 2. 顶部提示 / 通知(antd 的 message 和 notification)
    for (const t of document.querySelectorAll('.ant-message-notice, .ant-notification-notice')) {
      if (!isVisible(t)) continue;                   // 不可见的跳过
      const text = clip(t.textContent);
      if (!text) continue;                           // 没文字的跳过
      // 看提示里有没有"错误/警告"图标或样式
      const iconErr = t.querySelector(
        '.anticon-close-circle, .anticon-exclamation-circle, .anticon-warning, [class*="-error"], [class*="-warning"]');
      if (iconErr || ERROR_WORDS.test(text)) return text;   // 有错误图标或含错误词 → 报错
    }

    // 3. 确认弹窗里的校验提示(表单下面的红字等)
    for (const a of confirmDialog.querySelectorAll('[role="alert"], .ant-form-item-explain-error, .ant-alert-error')) {
      if (isVisible(a) && clip(a.textContent)) return clip(a.textContent);
    }
    return null;                                     // 什么都没发现
  }

  // 成功:先把结果报给后台,再点「返回主页领取新任务」(点完页面会跳走,脚本随之消失)
  async function goHome(message) {
    const done = { status: 'success', afterFinal: true, message };
    await Promise.race([send({ type: 'RESULT', result: done }), new Promise(r => setTimeout(r, 3000))]);   // 发给后台,但最多等 3 秒
    const home = findButton(CFG.HOME_BTN, { scope: findSuccess() || document });   // 找"返回主页领取新任务"
    if (home) realClick(home);                       // 点它,页面会跳转
    return home ? done : { ...done, message: message + '(未找到「' + CFG.HOME_BTN + '」按钮,请手动关闭弹窗)' };
  }
```

> **为什么点提交前就开着的弹窗不算?** 比如「任务基本信息」(总帧数、data_id 那个窗口),它可能一直开着(后台标签页里关闭动画会停住)。以前它会被当成"提交后出现了另一个弹窗",把明明成功的任务标成失败。

### 4.10 主流程 flow

```js
  /* ---------------- 主流程 ---------------- */

  async function flow({ dryRun = true }) {           // dryRun 默认 true(默认试运行,更安全)
    const T = CFG.T;                                 // 各步骤超时时间

    // 0. 前置检查:找不到顶栏提交按钮 / 不是「任务有效」状态,就什么都不动
    step('等待页面加载');                            // 汇报进度
    let topBtn;
    try {
      // 等顶栏"提交"按钮出现(排除弹窗里的同名按钮)
      topBtn = await waitFor(() => findButton(CFG.TOP_BTN, { outside: '[role="dialog"]' }),
        { timeout: T.page, label: '顶栏「' + CFG.TOP_BTN + '」按钮' });
    } catch (e) {
      if (e.message === '__abort') throw e;          // 如果是被中止,继续往外抛
      return { status: 'skipped', message: '未检测到顶栏「' + CFG.TOP_BTN + '」按钮(非任务页或页面未加载完成)' };   // 否则跳过
    }

    // 页面上还开着成功弹窗 = 之前已经提交成功了(比如上次被误判成失败),绝不能再提交一次
    if (findSuccess()) {
      if (dryRun) return { status: 'skipped', message: '此前已提交成功(试运行,未执行任何操作)' };   // 试运行不点任何东西
      return goHome('此前已提交成功,本次仅执行「' + CFG.HOME_BTN + '」');   // 真实运行:补点「返回主页」
    }

    if (CFG.READY_TEXT) {                            // 配置了就绪文字才检查
      try {
        // 等页面文字里出现"任务有效"
        await waitFor(() => document.body && document.body.textContent.includes(CFG.READY_TEXT),
          { timeout: T.tag, label: CFG.READY_TEXT });
      } catch (e) {
        if (e.message === '__abort') throw e;
        return { status: 'skipped', message: '任务状态不是「' + CFG.READY_TEXT + '」,未执行操作' };
      }
    }

    // 1. 点顶栏「提交」(如果上次失败留下了打开的确认弹窗,就直接用它)
    let dialog = findDialog(CFG.CONFIRM_HINT);       // 先看确认弹窗是不是已经开着
    if (!dialog) {
      if (isDisabled(topBtn)) return { status: 'skipped', message: '顶栏「' + CFG.TOP_BTN + '」按钮不可用' };   // 按钮灰了,跳过
      step('步骤 1/3:点击顶栏「' + CFG.TOP_BTN + '」');
      realClick(topBtn);                             // 点击
      dialog = await waitFor(() => findDialog(CFG.CONFIRM_HINT),   // 等确认弹窗出现
        { timeout: T.dialog, label: '确认弹窗' });
    }

    // 2. 弹窗里的下拉框必须是「质检通过」(默认值可能已经是,不是才去改)
    const root = selectRoot(dialog);                 // 找下拉框
    if (!root) throw new Error('确认弹窗中未找到下拉框');
    if (selectValue(root) !== norm(CFG.TARGET)) {    // 当前值不是目标值,才需要操作
      step('步骤 2/3:选择「' + CFG.TARGET + '」');
      const trigger = root.querySelector('.ant-select-selector') || root;   // 点哪里能展开下拉
      const combo = root.querySelector('[role="combobox"]');                // 用来判断是否已展开
      let option = null;
      for (let i = 0; i < 3 && !option; i++) {       // 最多尝试 3 次
        if (!combo || combo.getAttribute('aria-expanded') !== 'true') realClick(trigger);   // 没展开就点开(已展开就别再点,否则会收起)
        try {
          option = await waitFor(() => findOption(CFG.TARGET), { timeout: T.option, label: '「' + CFG.TARGET + '」选项' });   // 等选项出现
        } catch (e) { if (e.message === '__abort') throw e; }   // 超时就进入下一轮重试
      }
      if (!option) throw new Error('下拉框中未找到「' + CFG.TARGET + '」选项');
      realClick(option);                             // 点选项
      await waitFor(() => selectValue(root) === norm(CFG.TARGET), { timeout: T.value, label: '选中后的值' });   // 等下拉框显示的值真的变成目标值
    }
    if (selectValue(root) !== norm(CFG.TARGET)) throw new Error('下拉框取值不是「' + CFG.TARGET + '」,已中止');   // 最后再核对一次,不对就中止

    // 3. 试运行:不点最终提交,点取消把弹窗关掉
    if (dryRun) {
      const cancel = findButton(CFG.CANCEL_BTN, { scope: dialog });   // 在弹窗里找"取消"
      if (cancel) realClick(cancel);
      try { await waitFor(() => !isVisible(dialog), { timeout: 3000, label: '弹窗关闭' }); } catch { /* 关得慢不影响结论 */ }
      return { status: 'ready', message: '预检通过(试运行,未提交)' };   // 试运行到此结束
    }

    // 4. 点弹窗里的「提交」。从这一刻起不再响应「停止」,也不会重试
    const okBtn = findButton(CFG.OK_BTN, { scope: dialog });          // 找弹窗里的"提交"按钮
    if (!okBtn || isDisabled(okBtn)) throw new Error('确认弹窗中的「' + CFG.OK_BTN + '」按钮不可用');
    step('步骤 3/3:确认提交');
    await send({ type: 'PHASE', phase: 'final-clicked', text: '已执行最终提交,等待结果' }); // 先告诉后台,再点(await 等后台回执)
    const before = visibleDialogs();                 // 记下点之前就开着的弹窗,它们不算提交结果
    // 点之前最后再核对一次下拉框,确保提交的一定是「质检通过」
    if (selectValue(root) !== norm(CFG.TARGET)) throw new Error('下拉框取值不是「' + CFG.TARGET + '」,已中止');
    bs.locked = true;                                // 上锁:此后"停止"无效
    realClick(okBtn);                                // 真正点击最终提交

    // 5. 等结果:只要成功弹窗出来就是成功。网络慢时它会晚到,所以看到报错也只先记下,继续等满 T.final
    let error = null;                                // 最近看到的报错文字
    const ok = await waitFor(() => {
      if (findSuccess()) return true;                // 成功弹窗出来了 → 成功,不管之前看到过什么
      error = scanError(dialog, before) || error;    // 有报错就记下(没有就保留上一次记下的)
      return false;                                  // 继续等
    }, { timeout: T.final, label: '提交结果' }).catch(() => false);   // 30 秒还没成功 → ok=false
    if (!ok && error) return { status: 'error', afterFinal: true, message: '提交后出现异常:' + error + '。请人工核实,切勿重复提交' };
    if (!ok) {                                       // 30 秒内既没成功也没报错
      return { status: 'unknown', afterFinal: true,
        message: '已执行最终提交,' + T.final / 1000 + ' 秒内未收到结果。请人工核实提交状态,切勿重复提交' };
    }

    // 6. 成功
    return goHome('提交成功');
  }
```

### 4.11 run:流程的外壳

```js
  async function run(opts) {                         // 后台调用的入口
    if (bs.running) return { status: 'skipped', message: '该标签页正在处理中' };   // 防重复启动
    bs.running = true; bs.abort = false; bs.locked = false;   // 重置状态
    try {
      return await flow(opts || {});                 // 跑主流程,返回它的结果
    } catch (e) {                                    // 主流程里任何 throw 都落到这里
      if (e.message === '__abort') return { status: 'skipped', message: '已停止,未提交' };   // 被中止
      if (bs.locked) return { status: 'unknown', afterFinal: true, message: e.message + '(已执行最终提交,请人工核实,切勿重复提交)' };   // 已点最终提交后出错 → 待确认
      return { status: 'error', message: e.message };   // 点最终提交前出错 → 普通失败
    } finally {
      bs.running = false;                            // 不管成败,都标记"没在运行"
    }
  }
})();                                                // 立即执行函数结束
```

---
## 5. popup.js —— 弹窗的逻辑

它只负责:读设置 → 挑出要处理的标签页 → 发指令给后台 → 把后台存的进度画出来。真正干活的是后台。

### 5.1 文件头与默认设置

```js
// popup.js —— 只负责界面:读设置、挑出要处理的标签页、发指令、显示进度。
// 真正干活的是 background.js。popup 一失去焦点就会被浏览器销毁,所以进度不放在这里,
// 而是由后台写进 chrome.storage.session,popup 每次打开都从那里读。
//
// 范围固定是所有窗口的所有标签页;域名默认不限,填了才只处理该域名下的。
// 点「开始」后 popup 立刻关掉,不挡视线;再点扩展图标就能看到进度。

// 会保存下来的设置。试运行不保存,每次打开都是不勾选,只有你勾了才试运行
// host=域名筛选(空=全部域名) / limit=处理上限 / concurrency=并发数
const DEFAULTS = { host: '', limit: 1, concurrency: 1 };

// 状态显示文字 + 排序权重(问题项排在最前面)。数组第 1 项是显示的汉字,第 2 项是排序用的数字(越小越靠前)
const STATUS = {
  error:   ['失败', 0],
  unknown: ['待确认', 1],
  skipped: ['已跳过', 2],
  running: ['处理中', 3],
  pending: ['排队中', 4],
  ready:   ['预检通过', 5],
  success: ['成功', 6],
};
```

### 5.2 找到页面上的控件

```js
const $ = id => document.getElementById(id);      // 简写:$('dry') 就是按 id 找元素
const el = {                                       // 把所有要用的控件收集到一个对象 el 里,后面用 el.dry 这样访问
  dry: $('dry'), limit: $('limit'), concurrency: $('concurrency'), host: $('host'),
  count: $('count'), start: $('start'), retry: $('retry'), stop: $('stop'), clear: $('clear'),
  hint: $('hint'), summary: $('summary'), bar: $('bar'), list: $('list'),
};
const FORM_FIELDS = ['dry', 'limit', 'concurrency', 'host'];   // 属于"设置表单"的控件名;运行时要整体禁用、改动时要保存

let lastRun = null;   // 最近一次收到的运行状态,用来判断要不要显示「重试失败项」
```

### 5.3 设置的读写

```js
/* ---------- 设置 ---------- */

function readForm() {                              // 从界面控件读出当前设置
  const num = (v, min, max, fallback) => {         // 把文字转成数字并夹在 [min,max] 范围内;转不成数字就用 fallback
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    dryRun: el.dry.checked,                        // 试运行模式是否勾选
    limit: num(el.limit.value, 0, 500, DEFAULTS.limit),              // 处理上限,0~500
    concurrency: num(el.concurrency.value, 1, 10, DEFAULTS.concurrency),   // 并发数,1~10
    host: el.host.value.trim().toLowerCase(),      // 域名:去首尾空格、转小写
  };
}

function applyForm(s) {                            // 把保存的设置填回界面(试运行不填,保持不勾选)
  el.limit.value = s.limit;
  el.concurrency.value = s.concurrency;
  el.host.value = s.host;
}

// 旧版本存在 'settings' 里的设置(自动填的域名、默认勾选的试运行)不再读取
async function loadPrefs() {                       // 从浏览器本地存储读上次保存的设置
  const { prefs } = await chrome.storage.local.get('prefs');
  return { ...DEFAULTS, ...prefs };                // 用默认值打底,上次保存的覆盖在上面
}
```

### 5.4 找出要处理的标签页

```js
/* ---------- 找出要处理的标签页 ---------- */

function matches(tab, form) {                      // 判断某个标签页是否符合域名条件
  let u;
  try { u = new URL(tab.url); } catch { return false; }   // 网址解析失败 → 不符合
  if (!/^https?:$/.test(u.protocol)) return false; // edge:// 之类的页面注入不了
  return !form.host || u.hostname.toLowerCase().includes(form.host);   // 没填域名 → 全部符合;填了 → 域名里包含它才符合
}

// 任务页的网址是 …/editor?…,主页是 …/operator/home。只有任务页才处理
const isTaskPage = tab => new URL(tab.url).pathname.startsWith('/editor');   // 网址路径以 /editor 开头 = 任务页

// 标签页标题都是「LabelWise 标注平台」分不出来,所以用网址里的 task_name 当名字
function tabName(tab) {
  try { return new URL(tab.url).searchParams.get('task_name') || tab.title; }   // 网址里有 task_name 就用它,没有就用标题
  catch { return tab.title; }                      // 网址解析失败也退回标题
}

// 目标标签页在 popup 里确定,再把 id 发给后台。
// 这样「你看到的数量」和「实际处理的」一定一致(后台没有「当前窗口」的概念)
// 不是任务页的(主页等)先排除掉,不计入处理上限
// 顺序:从你当前所在的标签页开始往右,到头后再回到最左边,处理当前标签页左边的
async function getTargets(form) {
  const order = (a, b) => (a.windowId - b.windowId) || (a.index - b.index);   // 排序规则:先按窗口,再按标签页位置(从左到右)
  const all = (await chrome.tabs.query({})).filter(t => matches(t, form));   // 查所有窗口的所有标签页,按域名过滤
  all.sort(order);
  let tasks = all.filter(isTaskPage);              // 只留下任务页(去掉主页等)
  const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });   // 你当前所在的标签页
  const k = cur ? tasks.findIndex(t => order(t, cur) >= 0) : -1;   // 第一个"在当前标签页位置或其右边"的任务页
  if (k > 0) tasks = [...tasks.slice(k), ...tasks.slice(0, k)];   // 把它之前的(左边的)挪到队尾:先右后左
  const picked = form.limit > 0 ? tasks.slice(0, form.limit) : tasks;    // limit>0 就只取前 limit 个,0 表示全要
  return { all, tasks, picked };                   // all=匹配到的全部;tasks=其中的任务页;picked=本次实际处理的
}

async function refreshCount() {                    // 更新"检测到 X 个任务页,本次将处理 Y 个"那行文字
  const { tasks, picked } = await getTargets(readForm());
  el.count.textContent = `检测到 ${tasks.length} 个任务页,本次将处理 ${picked.length} 个`;
}

// 上一次运行里「提交之前就出错」的标签页(提交之后出错 / 待确认的不能重试)
async function retryTargets() {
  // 筛出:状态是 error 且 afterFinal 不为真(即最终提交之前出的错)
  const items = (lastRun?.items || []).filter(it => it.status === 'error' && !it.afterFinal);
  const out = [];
  for (const it of items) {
    const tab = await chrome.tabs.get(it.tabId).catch(() => null);   // 看标签页还在不在
    if (tab) out.push({ id: tab.id, title: tabName(tab) || it.title });  // 还在才加入
  }
  return out;
}
```

### 5.5 开始 / 重试 / 停止

```js
/* ---------- 开始 / 重试 / 停止 ---------- */

function setHint(text) { el.hint.textContent = text || ''; }   // 设置提示文字

// 发起运行。启动成功就关掉 popup,不挡视线;启动不了就留着显示原因
async function launch(key, targets) {              // key 是 'start'(开始执行)或 'retry'(重试失败项)
  const form = readForm();
  if (!targets.length) { setHint(key === 'start' ? '未检测到任务页。' : '没有可重试的标签页。'); return; }   // 没有目标就提示并结束
  setHint('');

  try {
    const r = await chrome.runtime.sendMessage({   // 给后台发 START 消息
      type: 'START',
      options: { dryRun: form.dryRun, concurrency: form.concurrency },
      tabs: targets.map(t => ({ id: t.id, title: tabName(t) || '(无标题)' })),   // 只传 id 和名字(任务名)
    });
    if (r && r.ok === false) { setHint(r.error || '启动失败'); return; }   // 后台拒绝了(比如已有任务在执行),留着窗口显示原因
    window.close();                                // 启动成功 → 立刻关掉扩展窗口
  } catch (e) {
    setHint('无法连接扩展后台:' + e.message);
  }
}

async function onStart() { await launch('start', (await getTargets(readForm())).picked); }   // 点"开始执行"

async function onRetry() { await launch('retry', await retryTargets()); }   // 点"重试失败项"

async function onStop() {                          // 点"停止"
  try { await chrome.runtime.sendMessage({ type: 'STOP' }); }
  catch (e) { setHint('无法连接扩展后台:' + e.message); }
}
```

### 5.6 显示进度

```js
/* ---------- 显示进度 ---------- */

function render(run) {                             // 根据后台存的 run 重画整个进度区
  lastRun = run || null;
  const running = !!run && run.state === 'running';
  el.stop.hidden = !running;                       // 只有运行中才显示"停止"
  el.start.disabled = running;                     // 运行中禁用"开始执行"
  el.clear.disabled = running;                     // 运行中禁用"清空记录"
  for (const k of FORM_FIELDS) el[k].disabled = running;   // 运行中禁用所有设置控件,防止中途乱改

  // 有"提交之前出错"的项,且没在运行,才显示"重试失败项"
  const retryable = !running && !!run && run.items.some(it => it.status === 'error' && !it.afterFinal);
  el.retry.hidden = !retryable;

  el.bar.hidden = !run || !run.total;              // 没有运行记录就不显示进度条
  if (!run || !run.total) {                        // 没有运行记录 → 显示空状态后结束
    el.summary.textContent = '暂无执行记录';
    el.list.replaceChildren();                     // 清空列表
    return;
  }

  const c = run.counts || {};
  const parts = [`进度 ${run.done}/${run.total}`]; // 汇总文字的各个片段,先放"已完成/总数"
  if (run.dryRun) parts.push('试运行模式');
  if (c.success) parts.push(`成功 ${c.success}`);
  if (c.ready) parts.push(`预检通过 ${c.ready}`);
  if (c.error) parts.push(`失败 ${c.error}`);
  if (c.unknown) parts.push(`待确认 ${c.unknown}`);
  if (c.skipped) parts.push(`已跳过 ${c.skipped}`);
  if (run.state === 'stopped') parts.push(run.note || '已停止');
  el.summary.textContent = parts.join(' · ');      // 用 · 拼接
  el.bar.max = run.total;                          // 进度条总量
  el.bar.value = run.done;                         // 进度条当前值

  const items = run.items
    .map((it, i) => ({ it, i }))                   // 记下原始序号,同权重时保持原顺序
    .sort((a, b) => (STATUS[a.it.status]?.[1] ?? 9) - (STATUS[b.it.status]?.[1] ?? 9) || a.i - b.i);   // 按权重排序:问题项靠前

  // 标签页标题和报错文字都来自网页,是不可信内容,所以全部用 textContent,绝不拼进 innerHTML
  // (用 innerHTML 的话,恶意网页标题里的 HTML/脚本会被当代码执行)
  el.list.replaceChildren(...items.map(({ it }) => {
    const li = document.createElement('li');       // 创建一行
    li.className = it.status;                      // 状态名作为样式类,配合 CSS 上色
    const s = document.createElement('span');      // 状态文字
    s.className = 's';
    s.textContent = STATUS[it.status]?.[0] ?? it.status;
    const t = document.createElement('span');      // 任务名
    t.className = 't';
    t.textContent = it.title;
    li.append(s, t);
    if (it.message) {                              // 有说明文字(进度/报错)就加一行小字
      const m = document.createElement('small');
      m.textContent = it.message;
      li.append(m);
    }
    li.addEventListener('click', () => focusTab(it.tabId));   // 点这一行 → 跳到对应标签页
    return li;
  }));
}

// 点一条记录,跳到对应的标签页(失败的页面会被保留着,方便你去处理)
async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) { setHint('该标签页已关闭。'); return; }
  await chrome.tabs.update(tabId, { active: true });                  // 切到该标签页
  await chrome.windows.update(tab.windowId, { focused: true });       // 并把它所在的窗口置前
}
```

### 5.7 事件绑定

```js
/* ---------- 事件绑定 ---------- */

async function onFormChange() {                    // 任何设置改动时执行
  setHint('');
  const { host, limit, concurrency } = readForm(); // 只保存这三项,试运行不保存
  await chrome.storage.local.set({ prefs: { host, limit, concurrency } });   // 存进本地存储(下次打开还在)
  refreshCount();                                  // 重新统计任务页数量
}
// 给每个设置控件绑定事件:文本框用 input(每输入一个字就触发),其他用 change(值改变时触发)
for (const k of FORM_FIELDS) el[k].addEventListener(k === 'host' ? 'input' : 'change', onFormChange);

el.start.addEventListener('click', onStart);       // 绑定各按钮
el.retry.addEventListener('click', onRetry);
el.stop.addEventListener('click', onStop);
el.clear.addEventListener('click', () => chrome.storage.session.remove('run'));   // 清空记录 = 删掉存储里的 run

// 后台每更新一次进度,这里就跟着重画(popup 开着或重新打开都一样)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.run) render(changes.run.newValue);   // 只关心 session 存储里 run 的变化
});
```

### 5.8 初始化

```js
(async function init() {                           // 弹窗一打开就执行
  applyForm(await loadPrefs());                    // 读上次保存的设置并填回界面
  const { run } = await chrome.storage.session.get('run');   // 读后台存的最新进度
  render(run);                                     // 画出来
  await refreshCount();                            // 统计任务页数量
})();
```

---

## 6. README.txt —— 使用说明

这是给人看的文字说明,不是代码,这里只概括要点:

1. **安装**:解压得到 `batch-submit` 文件夹 → 地址栏打开 `edge://extensions`(Chrome 用 `chrome://extensions`)→ 开启「开发人员模式」→「加载解压缩的扩展」→ 选这个文件夹。文件夹要放在固定位置,不能删、不能移动。
2. **处理顺序**:从当前所在的标签页开始往右,到头后再处理左边的。
3. **界面**:域名筛选(留空 = 全部域名)、处理上限(默认 1,0 = 不限)、并发数(默认 1)、试运行模式(每次打开都不勾选)。处理范围固定是所有窗口的全部标签页,只处理 `/editor` 任务页。点「开始执行」后扩展窗口立刻关闭。
4. **建议首次流程**:先勾选试运行处理 1 个,看到「预检通过」;再取消试运行真实提交 1 个;没问题后把处理上限改成 0。
5. **结果状态**:成功 / 预检通过 / 失败 / 待确认 / 已跳过(含义见前文第 3、4 节)。连续 3 项失败自动终止。
6. **文案不一致怎么办**:改 `inject.js` 最上面的 `CFG`,然后在扩展管理页重新加载该扩展。页面上没有"任务有效"字样,就把 `READY_TEXT` 改成 `''` 关闭这个检查。

---

## 7. 全局小结:一次真实提交的完整时间线

```
你点「开始执行」             popup → 后台:START {options, tabs},扩展窗口立即关闭
后台 startRun               建 run,保存,开保活,按并发数启动 N 个 worker
worker 取一个标签页         processItem:确认加载 → 注入 inject.js → 调用 window.__bs.run
inject.js flow              找顶栏提交 → 点 → 等确认弹窗 → 确认下拉=质检通过
inject.js                   发 PHASE(final-clicked) → 后台记下 finalClicked=true → 回执
inject.js                   bs.locked=true → 点弹窗「提交」
inject.js                   反复扫描:出现成功弹窗就算成功;报错只先记下,30 秒还没成功才报
成功                        发 RESULT → 点「返回主页领取新任务」→ 页面跳转
后台                        Promise.race 拿到结果 → setItem → 存储 → popup 实时重画
全部完成                    run.state='done',关保活,最后保存
```

**核心安全设计一句话:点最终提交之前,一切都可中止、可重试;点了之后,绝不重试,没把握就标"待确认"交给人。**
