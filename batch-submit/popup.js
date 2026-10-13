// popup.js —— 只负责界面:读设置、挑出要处理的标签页、发指令、显示进度。
// 真正干活的是 background.js。popup 一失去焦点就会被浏览器销毁,所以进度不放在这里,
// 而是由后台写进 chrome.storage.session,popup 每次打开都从那里读。
//
// 范围固定是所有窗口的所有标签页;域名默认不限,填了才只处理该域名下的。
// 点「开始」后 popup 立刻关掉,不挡视线;再点扩展图标就能看到进度。

// 会保存下来的设置。试运行不保存,每次打开都是不勾选,只有你勾了才试运行
const DEFAULTS = { host: '', limit: 1, concurrency: 1 };

// 状态显示文字 + 排序权重(问题项排在最前面)
const STATUS = {
  error:   ['失败', 0],
  unknown: ['待确认', 1],
  skipped: ['已跳过', 2],
  running: ['处理中', 3],
  pending: ['排队中', 4],
  ready:   ['预检通过', 5],
  success: ['成功', 6],
};

const $ = id => document.getElementById(id);
const el = {
  dry: $('dry'), limit: $('limit'), concurrency: $('concurrency'), host: $('host'),
  count: $('count'), start: $('start'), retry: $('retry'), stop: $('stop'), clear: $('clear'),
  hint: $('hint'), summary: $('summary'), bar: $('bar'), list: $('list'),
};
const FORM_FIELDS = ['dry', 'limit', 'concurrency', 'host'];

let lastRun = null;   // 最近一次收到的运行状态,用来判断要不要显示「重试失败项」

/* ---------- 设置 ---------- */

function readForm() {
  const num = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    dryRun: el.dry.checked,
    limit: num(el.limit.value, 0, 500, DEFAULTS.limit),
    concurrency: num(el.concurrency.value, 1, 10, DEFAULTS.concurrency),
    host: el.host.value.trim().toLowerCase(),
  };
}

function applyForm(s) {
  el.limit.value = s.limit;
  el.concurrency.value = s.concurrency;
  el.host.value = s.host;
}

// 旧版本存在 'settings' 里的设置(自动填的域名、默认勾选的试运行)不再读取
async function loadPrefs() {
  const { prefs } = await chrome.storage.local.get('prefs');
  return { ...DEFAULTS, ...prefs };
}

/* ---------- 找出要处理的标签页 ---------- */

function matches(tab, form) {
  let u;
  try { u = new URL(tab.url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false; // edge:// 之类的页面注入不了
  return !form.host || u.hostname.toLowerCase().includes(form.host);
}

// 任务页的网址是 …/editor?…,主页是 …/operator/home。只有任务页才处理
const isTaskPage = tab => new URL(tab.url).pathname.startsWith('/editor');

// 标签页标题都是「LabelWise 标注平台」分不出来,所以用网址里的 task_name 当名字
function tabName(tab) {
  try { return new URL(tab.url).searchParams.get('task_name') || tab.title; }
  catch { return tab.title; }
}

// 目标标签页在 popup 里确定,再把 id 发给后台。
// 这样「你看到的数量」和「实际处理的」一定一致(后台没有「当前窗口」的概念)
// 不是任务页的(主页等)先排除掉,不计入处理上限
async function getTargets(form) {
  const all = (await chrome.tabs.query({})).filter(t => matches(t, form));
  all.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
  const tasks = all.filter(isTaskPage);
  const picked = form.limit > 0 ? tasks.slice(0, form.limit) : tasks;
  return { all, tasks, picked };
}

async function refreshCount() {
  const { tasks, picked } = await getTargets(readForm());
  el.count.textContent = `检测到 ${tasks.length} 个任务页,本次将处理 ${picked.length} 个`;
}

// 上一次运行里「提交之前就出错」的标签页(提交之后出错 / 待确认的不能重试)
async function retryTargets() {
  const items = (lastRun?.items || []).filter(it => it.status === 'error' && !it.afterFinal);
  const out = [];
  for (const it of items) {
    const tab = await chrome.tabs.get(it.tabId).catch(() => null);
    if (tab) out.push({ id: tab.id, title: tabName(tab) || it.title });
  }
  return out;
}

/* ---------- 开始 / 重试 / 停止 ---------- */

function setHint(text) { el.hint.textContent = text || ''; }

// 发起运行。启动成功就关掉 popup,不挡视线;启动不了就留着显示原因
async function launch(key, targets) {
  const form = readForm();
  if (!targets.length) { setHint(key === 'start' ? '未检测到任务页。' : '没有可重试的标签页。'); return; }
  setHint('');

  try {
    const r = await chrome.runtime.sendMessage({
      type: 'START',
      options: { dryRun: form.dryRun, concurrency: form.concurrency },
      tabs: targets.map(t => ({ id: t.id, title: tabName(t) || '(无标题)' })),
    });
    if (r && r.ok === false) { setHint(r.error || '启动失败'); return; }
    window.close();
  } catch (e) {
    setHint('无法连接扩展后台:' + e.message);
  }
}

async function onStart() { await launch('start', (await getTargets(readForm())).picked); }

async function onRetry() { await launch('retry', await retryTargets()); }

async function onStop() {
  try { await chrome.runtime.sendMessage({ type: 'STOP' }); }
  catch (e) { setHint('无法连接扩展后台:' + e.message); }
}

/* ---------- 显示进度 ---------- */

function render(run) {
  lastRun = run || null;
  const running = !!run && run.state === 'running';
  el.stop.hidden = !running;
  el.start.disabled = running;
  el.clear.disabled = running;
  for (const k of FORM_FIELDS) el[k].disabled = running;

  const retryable = !running && !!run && run.items.some(it => it.status === 'error' && !it.afterFinal);
  el.retry.hidden = !retryable;

  el.bar.hidden = !run || !run.total;
  if (!run || !run.total) {
    el.summary.textContent = '暂无执行记录';
    el.list.replaceChildren();
    return;
  }

  const c = run.counts || {};
  const parts = [`进度 ${run.done}/${run.total}`];
  if (run.dryRun) parts.push('试运行模式');
  if (c.success) parts.push(`成功 ${c.success}`);
  if (c.ready) parts.push(`预检通过 ${c.ready}`);
  if (c.error) parts.push(`失败 ${c.error}`);
  if (c.unknown) parts.push(`待确认 ${c.unknown}`);
  if (c.skipped) parts.push(`已跳过 ${c.skipped}`);
  if (run.state === 'stopped') parts.push(run.note || '已停止');
  el.summary.textContent = parts.join(' · ');
  el.bar.max = run.total;
  el.bar.value = run.done;

  const items = run.items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (STATUS[a.it.status]?.[1] ?? 9) - (STATUS[b.it.status]?.[1] ?? 9) || a.i - b.i);

  // 标签页标题和报错文字都来自网页,是不可信内容,所以全部用 textContent,绝不拼进 innerHTML
  el.list.replaceChildren(...items.map(({ it }) => {
    const li = document.createElement('li');
    li.className = it.status;
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = STATUS[it.status]?.[0] ?? it.status;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = it.title;
    li.append(s, t);
    if (it.message) {
      const m = document.createElement('small');
      m.textContent = it.message;
      li.append(m);
    }
    li.addEventListener('click', () => focusTab(it.tabId));
    return li;
  }));
}

// 点一条记录,跳到对应的标签页(失败的页面会被保留着,方便你去处理)
async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) { setHint('该标签页已关闭。'); return; }
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/* ---------- 事件绑定 ---------- */

async function onFormChange() {
  setHint('');
  const { host, limit, concurrency } = readForm();
  await chrome.storage.local.set({ prefs: { host, limit, concurrency } });
  refreshCount();
}
for (const k of FORM_FIELDS) el[k].addEventListener(k === 'host' ? 'input' : 'change', onFormChange);

el.start.addEventListener('click', onStart);
el.retry.addEventListener('click', onRetry);
el.stop.addEventListener('click', onStop);
el.clear.addEventListener('click', () => chrome.storage.session.remove('run'));

// 后台每更新一次进度,这里就跟着重画(popup 开着或重新打开都一样)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.run) render(changes.run.newValue);
});

(async function init() {
  applyForm(await loadPrefs());
  const { run } = await chrome.storage.session.get('run');
  render(run);
  await refreshCount();
})();
