// background.js —— 调度:同时处理 N 个任务,把每个任务的状态写进 chrome.storage.session 给 popup 显示。
// 纯接口提交:不注入页面、不点按钮、不切标签页,页面没加载完甚至标签页休眠都不影响。
//
// 每个任务的流程(task 取自标签页网址里的 task 参数)
//   1. GET  /api/v1/task/{task}                          任务详情:必须是「质检」环节、状态 Working
//   2. GET  /api/v1/workflow/{wf}/actions/               按名字找到「质检通过」的 action id
//      GET  /api/v1/workflow/{wf}/nodes/{node}           确认该 action 属于当前环节
//   3. GET  /api/v1/task/data/{task}                     取 labeling_data(质检时只读,原样提交)
//   4. POST /api/v1/task/submit                          { action, task_id, labeling_data, skip_acceptance_for_unmodified_tasks:false }
//   5. GET  /api/v1/task/{task}                          复查:环节或状态变了才算成功
//   6. 成功后关掉任务标签页、刷新已打开的主页(和手动点「返回主页领取新任务」一样)
//
// 消息约定
//   popup → 后台  { type:'START', options:{dryRun, concurrency}, tabs:[{id,title,url}] }   开始
//                 { type:'STOP' }                                                          停止(已发出提交的任务不受影响)
//   存储 'run'    { state:'running'|'done'|'stopped', total, done, counts, note, dryRun,
//                   items:[{tabId,title,url,status,message,afterFinal}] }

'use strict';

const CFG = {
  ACTION_NAME: '质检通过',                 // 要执行的操作名(和页面下拉框里的文字一致)
  NODE_TYPE: 'quality_inspection',         // 只处理这个环节的任务
  WORKING: 'Working',                      // 只处理这个状态的任务,其他状态(比如已提交)跳过
  HOME_PATH: '/operator/home',             // 主页路径:提交成功后刷新这个页面
  REQUEST_TIMEOUT_MS: 30 * 1000,
};
const MAX_CONSECUTIVE_FAILS = 3;            // 连续失败这么多个就整体停下

let run = null;                              // 当前运行状态(内存里一份,同时写进 storage)
let stopRequested = false;
let stopReason = '';
let keepAliveTimer = null;

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

function startKeepAlive() {
  stopKeepAlive();
  // 有任务在跑时,定期调用一个扩展 API,避免后台脚本因空闲被回收
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
}
function stopKeepAlive() { clearInterval(keepAliveTimer); keepAliveTimer = null; }

/* ---------- 登录令牌 ---------- */

// 注入页面执行(必须自包含):从 localStorage / sessionStorage / cookie 里找登录令牌(JWT),取过期时间最晚的那个
function findToken() {
  const re = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  const texts = [document.cookie];
  for (const s of [localStorage, sessionStorage]) {
    try { for (let i = 0; i < s.length; i++) texts.push(s.getItem(s.key(i)) || ''); } catch (e) { /* 忽略 */ }
  }
  let best = null;
  for (const t of texts) for (const tok of t.match(re) || []) {
    let exp = 0;
    try { exp = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || 0; } catch (e) { continue; }
    if (!best || exp > best.exp) best = { token: tok, exp };
  }
  return best;
}

// 令牌存在本机扩展里,有效期内一直复用(浏览器重启也不用重新读),页面一个都没加载出来也能用;
// 过期或被平台拒绝(401/403)时才重新从任务页读取
async function getToken(tabIds) {
  const now = Date.now() / 1000;
  const { bsToken } = await chrome.storage.local.get('bsToken');
  if (bsToken && (!bsToken.exp || bsToken.exp > now + 60)) return bsToken.token;
  const tabs = (await Promise.all(tabIds.map(id => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  // 所有任务页同时读,不等页面加载完(injectImmediately),每页最多等 3 秒,谁先读到有效令牌就用谁
  const read = tab => Promise.race([
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findToken, injectImmediately: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
  ]).then(([g]) => {
    const t = g && g.result;
    if (t && (!t.exp || t.exp > now + 60)) return t;
    throw new Error('no token');
  });
  try {
    const t = await Promise.any(tabs.filter(t => !t.discarded).concat(tabs.filter(t => t.discarded)).map(read));
    await chrome.storage.local.set({ bsToken: t });
    return t.token;
  } catch { return ''; }
}

/* ---------- 接口 ---------- */

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// 从返回内容里挑出服务器给的说明文字
function serverMsg(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 200);
  const m = body.message || body.msg || body.detail || body.error;
  return typeof m === 'string' ? m : m ? JSON.stringify(m).slice(0, 200) : '';
}

async function api(origin, token, method, path, data) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(origin + path, {
      method,
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ApiError(e.name === 'AbortError' ? '请求超时(' + CFG.REQUEST_TIMEOUT_MS / 1000 + ' 秒)' : '网络错误:' + e.message, 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await r.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* 不是 JSON 就保留原文 */ }
  if (r.status === 401 || r.status === 403) {
    await chrome.storage.local.remove('bsToken');
    throw new ApiError('登录令牌失效或无权限(' + r.status + '),请刷新任意任务页后重试', r.status);
  }
  if (!r.ok) throw new ApiError('接口返回 ' + r.status + (serverMsg(body) ? ':' + serverMsg(body) : ''), r.status);
  return body;
}

// 「质检通过」的 action id 按工作流 + 环节缓存,同一次运行里只查一次
const actionCache = new Map();
function findAction(origin, token, wf, node) {
  const key = origin + '|' + wf + '|' + node;
  if (!actionCache.has(key)) {
    const p = (async () => {
      const [actions, nodeInfo] = await Promise.all([
        api(origin, token, 'GET', `/api/v1/workflow/${wf}/actions/`),
        api(origin, token, 'GET', `/api/v1/workflow/${wf}/nodes/${node}`),
      ]);
      const list = Array.isArray(actions) ? actions : (actions && actions.data) || [];
      const allowed = Object.keys((nodeInfo && nodeInfo.action_map) || {});
      const hit = list.find(a => a && a.name === CFG.ACTION_NAME);
      if (!hit) throw new Error('工作流里没有「' + CFG.ACTION_NAME + '」操作(现有:' + list.map(a => a && a.name).join('、') + ')');
      if (allowed.length && !allowed.includes(hit._id)) throw new Error('当前环节不能执行「' + CFG.ACTION_NAME + '」');
      return hit._id;
    })();
    actionCache.set(key, p);
    p.catch(() => actionCache.delete(key)); // 查失败的不缓存,下一个任务重新查
  }
  return actionCache.get(key);
}

/* ---------- 主页 ---------- */

const homeUrl = origin => origin + CFG.HOME_PATH;
async function homeTabs(origin) {
  return (await chrome.tabs.query({})).filter(t => {
    try { const u = new URL(t.url); return u.origin === origin && u.pathname.startsWith(CFG.HOME_PATH); } catch { return false; }
  });
}

// 刷新主页。批量提交时成功会接连发生,1.5 秒内的多次合并成一次,免得主页一直闪
const homeTimers = new Map();
function refreshHome(origin) {
  clearTimeout(homeTimers.get(origin));
  homeTimers.set(origin, setTimeout(async () => {
    homeTimers.delete(origin);
    const tabs = await homeTabs(origin);
    if (tabs.length) for (const t of tabs) chrome.tabs.reload(t.id).catch(() => {});
    else chrome.tabs.create({ url: homeUrl(origin), active: false }).catch(() => {}); // 没开主页才新开一个
  }, 1500));
}

// 运行结束后切到主页标签页
async function focusHome(origin) {
  const [t] = await homeTabs(origin);
  if (!t) return;
  await chrome.tabs.update(t.id, { active: true }).catch(() => {});
  await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
}

/* ---------- 处理单个任务 ---------- */

async function processItem(item, options, token) {
  await setItem(item, { status: 'running', message: '读取任务信息' });

  let u;
  try { u = new URL(item.url); } catch { return setItem(item, { status: 'skipped', message: '网址无法识别' }); }
  const task = u.searchParams.get('task');
  if (!task) return setItem(item, { status: 'skipped', message: '网址里没有 task 参数' });
  const origin = u.origin;
  const call = (method, path, data) => api(origin, token, method, path, data);

  // 1. 前置检查:不是质检环节 / 不在作业中(比如已经提交过)就什么都不做
  let before;
  try { before = await call('GET', `/api/v1/task/${encodeURIComponent(task)}`); }
  catch (e) { return setItem(item, { status: 'error', message: '读取任务失败:' + e.message }); }
  if (before.workflow_node_type !== CFG.NODE_TYPE) {
    return setItem(item, { status: 'skipped', message: '当前环节是「' + (before.workflow_node_type || '未知') + '」,不是质检,未执行操作' });
  }
  if (before.status !== CFG.WORKING) {
    return setItem(item, { status: 'skipped', message: '任务状态是「' + (before.status || '未知') + '」,不是作业中(可能已提交),未执行操作' });
  }
  if (before.clip_valid === false) return setItem(item, { status: 'skipped', message: '任务无效(clip_valid=false),未执行操作' });

  // 2. 找「质检通过」的 action;3. 取标注数据
  let action, data;
  try {
    await setItem(item, { message: '读取标注数据' });
    [action, data] = await Promise.all([
      findAction(origin, token, before.workflow_id, before.workflow_node_id),
      call('GET', `/api/v1/task/data/${encodeURIComponent(task)}`),
    ]);
  } catch (e) { return setItem(item, { status: 'error', message: e.message }); }
  const labeling = data && data.labeling_data;
  if (!labeling || typeof labeling !== 'object') return setItem(item, { status: 'error', message: '没有读到标注数据(labeling_data 为空),未提交' });

  if (options.dryRun) {
    return setItem(item, { status: 'ready', message: '预检通过(试运行,未提交):质检环节、作业中,将以「' + CFG.ACTION_NAME + '」提交' });
  }
  if (stopRequested) return setItem(item, { status: 'skipped', message: '已停止,未提交' });

  // 4. 提交。从这一刻起不再响应「停止」,也不会重试
  await setItem(item, { message: '正在提交', afterFinal: true });
  let submitErr = null;
  try {
    await call('POST', '/api/v1/task/submit', {
      action, task_id: before.id || task, labeling_data: labeling, skip_acceptance_for_unmodified_tasks: false,
    });
  } catch (e) { submitErr = e; }

  // 5. 复查任务:环节或状态变了才算真正提交成功
  let after = null;
  try { after = await call('GET', `/api/v1/task/${encodeURIComponent(task)}`); } catch { /* 复查失败按下面的规则处理 */ }
  const moved = after && (after.workflow_node_id !== before.workflow_node_id || after.status !== before.status);

  if (moved) {
    // 和手动点「返回主页领取新任务」一样:关掉任务标签页,刷新已打开的主页
    chrome.tabs.remove(item.tabId).catch(() => {});
    refreshHome(origin);
    return setItem(item, { status: 'success', message: submitErr ? '提交成功(提交请求报错但任务已流转:' + submitErr.message + ')' : '提交成功' });
  }
  // 服务器明确拒绝(4xx)且任务没动 = 没提交上
  if (submitErr && submitErr.status >= 400 && submitErr.status < 500 && after) {
    return setItem(item, { status: 'error', message: '服务器拒绝提交:' + submitErr.message });
  }
  return setItem(item, {
    status: 'unknown',
    message: (submitErr ? '提交请求出错:' + submitErr.message + '。' : '服务器已接收提交,但任务状态未变化。') + '请人工核实提交状态,切勿重复提交',
  });
}

/* ---------- 一次运行 ---------- */

async function startRun({ options, tabs }) {
  stopRequested = false;
  stopReason = '';
  actionCache.clear();
  const items = tabs.map(t => ({ tabId: t.id, title: t.title || '(无标题)', url: t.url || '', status: 'pending', message: '', afterFinal: false }));
  run = { state: 'running', total: items.length, done: 0, counts: {}, note: '', dryRun: !!options.dryRun, items };
  await save();
  startKeepAlive();

  const token = await getToken(items.map(it => it.tabId));
  if (!token) {
    for (const it of items) { it.status = 'error'; it.message = '所有任务页里都没找到有效的登录令牌:请刷新任意任务页或重新登录后重试'; }
    run.state = 'stopped';
    run.note = '未找到登录令牌';
    stopKeepAlive();
    await save();
    return;
  }

  const queue = items.slice();
  let fails = 0;
  const worker = async () => {
    while (!stopRequested && queue.length) {
      const item = queue.shift();
      try { await processItem(item, options, token); }
      catch (e) {
        await setItem(item, item.afterFinal
          ? { status: 'unknown', message: e.message + '(已发出提交,请人工核实,切勿重复提交)' }
          : { status: 'error', message: e.message });
      }
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

  // 有提交成功的,等最后一次主页刷新排上后切到主页
  const ok = items.find(it => it.status === 'success');
  if (ok) { try { setTimeout(() => focusHome(new URL(ok.url).origin), 1600); } catch { /* 忽略 */ } }
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
    if (run && run.state === 'running') stopRequested = true; // 还没发出提交的任务就地停下
    sendResponse({ ok: true });
  }
});
