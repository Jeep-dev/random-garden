// background.js —— 调度:同时处理 N 个标签页,把每页的状态写进 chrome.storage.session 给 popup 显示。
//
// 消息约定
//   popup → 后台  { type:'START', options:{dryRun, concurrency}, tabs:[{id,title}] }   开始
//                 { type:'STOP' }                                                      停止(已点最终提交的页面不受影响)
//   页面 → 后台   { type:'PHASE', text, phase? }   进度文字;phase:'final-clicked' 表示马上要点最终提交
//                 { type:'RESULT', result }        成功结果(页面随后会跳走,所以要先报)
//   存储 'run'    { state:'running'|'done'|'stopped', total, done, counts, note, dryRun,
//                   items:[{tabId,title,status,message,afterFinal}] }

'use strict';

const MAX_CONSECUTIVE_FAILS = 3;            // 连续失败这么多个就整体停下
const TAB_WATCHDOG_MS = 4 * 60 * 1000;      // 单个标签页最长处理时间
const LOAD_WAIT_MS = 60 * 1000;             // 等标签页加载完的最长时间

let run = null;                              // 当前运行状态(内存里一份,同时写进 storage)
let stopRequested = false;
let stopReason = '';
let keepAliveTimer = null;
const waiters = new Map();                   // tabId -> { finalClicked, resolve }

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
// 必须诚实地标成「待确认」,绝不能当成功或失败,更不能自动重试。
(async function recover() {
  const { run: saved } = await chrome.storage.session.get('run');
  if (run || !saved || saved.state !== 'running') return; // run 已存在 = 这次启动就是为了开始新任务
  for (const it of saved.items) {
    if (it.status === 'running') {
      it.status = 'unknown';
      it.message = '扩展后台进程被浏览器重启,提交状态未知。请人工核实,切勿重复提交';
    } else if (it.status === 'pending') {
      it.status = 'skipped';
      it.message = '扩展后台进程被浏览器重启,未处理';
    }
  }
  saved.state = 'stopped';
  saved.note = '后台进程重启,任务已中断';
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

// 确保标签页已经加载:被浏览器休眠(discarded)的先刷新;还在加载的等它加载完
async function ensureLoaded(tabId) {
  let tab = await chrome.tabs.get(tabId);
  if (tab.discarded) await chrome.tabs.reload(tabId);
  const t0 = Date.now();
  for (;;) {
    tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && !tab.discarded) return;
    if (Date.now() - t0 > LOAD_WAIT_MS) return; // 单页应用往往早就能用了,让页面里的脚本自己等元素
    await sleep(500);
  }
}

/* ---------- 处理单个标签页 ---------- */

async function processItem(item, options) {
  const tabId = item.tabId;
  await setItem(item, { status: 'running', message: '准备中' });

  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { return setItem(item, { status: 'skipped', message: '标签页已关闭' }); }
  if (!/^https?:/i.test(tab.url || '')) {
    return setItem(item, { status: 'skipped', message: '非网页标签页,无法处理' });
  }

  // 切到正在处理的标签页,让你看到它在动(并发时停在最新开始的那个)
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});

  try { await ensureLoaded(tabId); }
  catch { return setItem(item, { status: 'skipped', message: '标签页已关闭' }); }

  const waiter = { finalClicked: false, resolve: null };
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

  // 整理结果。凡是已经点过最终提交、又没拿到明确结果的,一律「待确认」
  const after = waiter.finalClicked;
  if (!res || res.__error || res.__watchdog || !TERMINAL.has(res.status)) {
    let why;
    if (!res) why = '页面在处理过程中跳转或关闭,未获取到结果';
    else if (res.__watchdog) why = '处理超时(超过 ' + TAB_WATCHDOG_MS / 60000 + ' 分钟)';
    else if (res.__error) why = res.__error;
    else why = '页面返回结果无法识别';
    res = after
      ? { status: 'unknown', afterFinal: true, message: why + '。已执行最终提交,请人工核实提交状态,切勿重复提交' }
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
          stopReason = '连续 ' + MAX_CONSECUTIVE_FAILS + ' 项失败,已自动终止';
        }
      } else if (item.status === 'success' || item.status === 'ready') {
        fails = 0;
      }
    }
  };
  const n = Math.max(1, Math.min(10, options.concurrency | 0 || 5));
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));

  for (const it of items) {
    if (it.status === 'pending') { it.status = 'skipped'; it.message = stopReason || '已停止,未处理'; }
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
    if (run && run.state === 'running') { sendResponse({ ok: false, error: '已有任务正在执行' }); return; }
    sendResponse({ ok: true });
    startRun(msg).catch(async e => {
      if (run) { run.state = 'stopped'; run.note = '后台异常:' + e.message; stopKeepAlive(); await save(); }
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
  }
});
