// background.js —— 调度:同时处理 N 个标签页,把每页的状态写进 chrome.storage.session 给 popup 显示。
//
// 消息约定
//   popup → 后台  { type:'START', options:{dryRun, concurrency}, tabs:[{id,title}] }   开始
//                 { type:'STOP' }                                                      停止(已点最终提交的页面不受影响)
//   页面 → 后台   { type:'PHASE', text, phase? }   进度文字;phase:'final-clicked' 表示马上要点最终提交
//                 { type:'RESULT', result }        成功结果(页面随后会跳走,所以要先报)
//                 { type:'WAKE' }                  页面在后台没画出来,请切到前台;回复 { ok } 表示切好了
//                 { type:'WOKE' }                  不再需要前台了,可以切下一个
//   存储 'run'    { state:'running'|'done'|'stopped', total, done, counts, note, dryRun,
//                   items:[{tabId,title,status,message,afterFinal}] }

'use strict';

const MAX_CONSECUTIVE_FAILS = 3;            // 连续失败这么多个就整体停下
const TAB_WATCHDOG_MS = 4 * 60 * 1000;      // 单个标签页最长处理时间
const LOAD_WAIT_MS = 60 * 1000;             // 等标签页加载完的最长时间
const WAKE_HOLD_MS = 15 * 1000;             // 一个标签页最多占着前台这么久(页面没回 WOKE 时的兜底)

let run = null;                              // 当前运行状态(内存里一份,同时写进 storage)
let stopRequested = false;
let stopReason = '';
let keepAliveTimer = null;
const waiters = new Map();                   // tabId -> { finalClicked, resolve, releaseWake }
let wakeQueue = Promise.resolve();           // 切到前台要排队:同一时间只切一个

const TERMINAL = new Set(['success', 'ready', 'error', 'unknown', 'skipped']);

/* ---------- 状态保存 ---------- */

function summarize() {
  const counts = { success: 0, ready: 0, error: 0, unknown: 0, skipped: 0 };
  let done = 0;
  for (const it of run.items) {
    if (TERMINAL.has(it.status)) { done++; counts[it.status]++; }
  }
  run.done = done;
  run.counts = counts;
}

let saving = Promise.resolve();
function save() {
  if (!run) return saving;
  summarize();
  const snapshot = JSON.parse(JSON.stringify(run));
  saving = saving.then(() => chrome.storage.session.set({ run: snapshot })).catch(() => {});
  return saving;
}

function setItem(item, patch) {
  Object.assign(item, patch);
  return save();
}

/* ---------- 后台被浏览器回收后的善后 ---------- */
// 后台脚本空闲太久会被浏览器杀掉。如果杀掉时还有任务在跑,重启后我们不知道结果,
// 必须诚实地标成「未知」,绝不能当成功或失败,更不能自动重试。
(async function recover() {
  const { run: saved } = await chrome.storage.session.get('run');
  if (run || !saved || saved.state !== 'running') return; // run 已存在 = 这次启动就是为了开始新任务
  for (const it of saved.items) {
    if (it.status === 'running') {
      it.status = 'unknown';
      it.message = '后台脚本被浏览器重启,不确定是否已提交。请到该标签页手动确认,不要重试';
    } else if (it.status === 'pending') {
      it.status = 'skipped';
      it.message = '后台脚本被浏览器重启,没有处理';
    }
  }
  saved.state = 'stopped';
  saved.note = '后台被重启,已中断';
  run = saved;
  await save();
})();

/* ---------- 工具 ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function startKeepAlive() {
  stopKeepAlive();
  // 有任务在跑时,定期调用一个扩展 API,避免后台脚本因空闲被回收
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
}
function stopKeepAlive() { clearInterval(keepAliveTimer); keepAliveTimer = null; }

// 确保标签页已经加载:被浏览器休眠(discarded)或还没加载过(unloaded)的先刷新;还在加载的等它加载完
async function ensureLoaded(tabId) {
  let tab = await chrome.tabs.get(tabId);
  if (tab.discarded || tab.status === 'unloaded') await chrome.tabs.reload(tabId);
  const t0 = Date.now();
  for (;;) {
    tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && !tab.discarded) return;
    if (Date.now() - t0 > LOAD_WAIT_MS) return; // 单页应用往往早就能用了,让页面里的脚本自己等元素
    await sleep(500);
  }
}

// 把标签页切到前台。浏览器不绘制后台标签页、最小化或被挡住的窗口里的页面,
// 而任务页要先画出来才会出现顶栏按钮,所以从没显示过的标签页要切过去一次。
// 画出来以后再回到后台不影响后面的步骤。排队进行,轮到时任务已经结束就不切了。
function wakeTab(tabId, waiter) {
  const turn = wakeQueue.then(async () => {
    if (stopRequested || waiters.get(tabId) !== waiter) return false;
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    await chrome.tabs.update(tabId, { active: true });
    if (win.state === 'minimized') await chrome.windows.update(win.id, { state: 'normal' });
    await chrome.windows.update(win.id, { focused: true });
    return true;
  }).catch(() => false);
  const released = new Promise(r => { waiter.releaseWake = r; });
  wakeQueue = turn.then(ok => ok && Promise.race([released, sleep(WAKE_HOLD_MS)]));
  return turn;
}

/* ---------- 处理单个标签页 ---------- */

async function processItem(item, options) {
  const tabId = item.tabId;
  await setItem(item, { status: 'running', message: '准备中…' });

  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { return setItem(item, { status: 'skipped', message: '标签页已经关闭' }); }
  if (!/^https?:/i.test(tab.url || '')) {
    return setItem(item, { status: 'skipped', message: '不是普通网页,无法操作' });
  }

  try { await ensureLoaded(tabId); }
  catch { return setItem(item, { status: 'skipped', message: '标签页已经关闭' }); }

  const waiter = { finalClicked: false, resolve: null, releaseWake: null };
  const resultMsg = new Promise(resolve => { waiter.resolve = resolve; });
  waiters.set(tabId, waiter);

  const watchdog = new Promise(resolve => setTimeout(() => resolve({ __watchdog: true }), TAB_WATCHDOG_MS));
  const injected = (async () => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['inject.js'] });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: opts => window.__bs.run(opts),
      args: [{ dryRun: !!options.dryRun }],
    });
    return r && r.result;
  })().catch(e => ({ __error: e && e.message ? e.message : String(e) }));

  let res = await Promise.race([resultMsg, injected, watchdog]);
  waiters.delete(tabId);
  if (waiter.releaseWake) waiter.releaseWake();

  // 整理结果。凡是已经点过最终提交、又没拿到明确结果的,一律「未知」
  const after = waiter.finalClicked;
  if (!res || res.__error || res.__watchdog || !TERMINAL.has(res.status)) {
    let why;
    if (!res) why = '页面中途跳转或被关闭,没有拿到结果';
    else if (res.__watchdog) why = '处理超过 ' + TAB_WATCHDOG_MS / 60000 + ' 分钟,放弃等待';
    else if (res.__error) why = res.__error;
    else why = '页面返回了无法识别的结果';
    res = after
      ? { status: 'unknown', afterFinal: true, message: why + '。已点过最终提交,请手动确认,不要重试' }
      : { status: 'error', message: why };
  }
  await setItem(item, { status: res.status, message: res.message || '', afterFinal: !!res.afterFinal });
}

/* ---------- 一次运行 ---------- */

async function startRun({ options, tabs }) {
  stopRequested = false;
  stopReason = '';
  const items = tabs.map(t => ({ tabId: t.id, title: t.title || '(无标题)', status: 'pending', message: '', afterFinal: false }));
  run = { state: 'running', total: items.length, done: 0, counts: {}, note: '', dryRun: !!options.dryRun, items };
  await save();
  startKeepAlive();

  const queue = items.slice();
  let fails = 0;
  const worker = async () => {
    while (!stopRequested && queue.length) {
      const item = queue.shift();
      await processItem(item, options);
      if (item.status === 'error' || item.status === 'unknown') {
        if (++fails >= MAX_CONSECUTIVE_FAILS) {
          stopRequested = true;
          stopReason = '连续 ' + MAX_CONSECUTIVE_FAILS + ' 个失败,已自动停止';
        }
      } else if (item.status === 'success' || item.status === 'ready') {
        fails = 0;
      }
    }
  };
  const n = Math.max(1, Math.min(10, options.concurrency | 0 || 5));
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));

  for (const it of items) {
    if (it.status === 'pending') { it.status = 'skipped'; it.message = stopReason || '已停止,没有处理'; }
  }
  run.state = stopRequested ? 'stopped' : 'done';
  run.note = stopReason;
  stopKeepAlive();
  await save();
}

async function stopAll() {
  if (!run || run.state !== 'running') return;
  stopRequested = true;
  // 通知正在跑的页面:还没点最终提交的就地中止
  for (const it of run.items) {
    if (it.status !== 'running') continue;
    chrome.scripting.executeScript({
      target: { tabId: it.tabId },
      func: () => { if (window.__bs) window.__bs.abort = true; },
    }).catch(() => {});
  }
}

/* ---------- 消息入口 ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'START') {
    if (run && run.state === 'running') { sendResponse({ ok: false, error: '已经有任务在运行' }); return; }
    sendResponse({ ok: true });
    startRun(msg).catch(async e => {
      if (run) { run.state = 'stopped'; run.note = '后台出错:' + e.message; stopKeepAlive(); await save(); }
    });
    return;
  }

  if (msg.type === 'STOP') {
    stopAll();
    sendResponse({ ok: true });
    return;
  }

  // 以下消息来自被注入的页面
  const tabId = sender.tab && sender.tab.id;
  const waiter = tabId != null && waiters.get(tabId);
  if (!waiter || !run) { sendResponse({ ok: false }); return; }
  const item = run.items.find(i => i.tabId === tabId);

  if (msg.type === 'PHASE') {
    if (msg.phase === 'final-clicked') waiter.finalClicked = true; // 先记下,再回执,页面收到回执后才点
    if (item && msg.text) setItem(item, { message: msg.text });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'RESULT') {
    waiter.resolve(msg.result);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'WAKE') {
    wakeTab(tabId, waiter).then(ok => sendResponse({ ok }));
    return true; // 异步回复:排到队、切好之后才回
  }

  if (msg.type === 'WOKE') {
    if (waiter.releaseWake) waiter.releaseWake();
    sendResponse({ ok: true });
  }
});
