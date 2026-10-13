// popup.js —— 只负责界面:读设置、挑出要处理的标签页、发指令、显示进度。
// 真正干活的是 background.js。popup 一失去焦点就会被浏览器销毁,所以进度不放在这里,
// 而是由后台写进 chrome.storage.session,popup 每次打开都从那里读。
//
// 域名不写死:打开时取「你当前所在的标签页」的域名填进输入框,按它来筛标签页。

// 默认值偏保守:先试运行、一次只处理 1 个
const DEFAULTS = { dryRun: true, concurrency: 5, scope: 'window', limit: 1, host: '', hostEdited: false, anyHost: false };

// 状态显示文字 + 排序权重(问题项排在最前面)
const STATUS = {
  error:   ['失败', 0],
  unknown: ['未知', 1],
  skipped: ['跳过', 2],
  running: ['进行中', 3],
  pending: ['等待', 4],
  ready:   ['可提交', 5],
  success: ['成功', 6],
};

const $ = id => document.getElementById(id);
const el = {
  dry: $('dry'), scope: $('scope'), limit: $('limit'), concurrency: $('concurrency'),
  host: $('host'), fillHost: $('fillHost'), anyHost: $('anyHost'),
  count: $('count'), start: $('start'), retry: $('retry'), stop: $('stop'), clear: $('clear'),
  hint: $('hint'), summary: $('summary'), bar: $('bar'), list: $('list'),
};
const FORM_FIELDS = ['dry', 'scope', 'limit', 'concurrency', 'host', 'anyHost'];

let lastRun = null;   // 最近一次收到的运行状态,用来判断要不要显示「重跑失败项」
let armedKey = null;  // 「真实提交」需要点两次:这里记录哪个按钮已经点过第一次('start' | 'retry')
let armTimer = null;

/* ---------- 域名 ---------- */

// www.a.b.example.com → example.com;IP 和 localhost 原样返回
function baseDomain(hostname) {
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(':') || !hostname.includes('.')) return hostname;
  const parts = hostname.split('.');
  const shortSecond = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
  const keep = parts.at(-1).length === 2 && shortSecond.has(parts.at(-2)) ? 3 : 2; // 处理 xx.com.cn 这类
  return parts.slice(-keep).join('.');
}

async function activeTabDomain() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab.url);
    return /^https?:$/.test(u.protocol) ? baseDomain(u.hostname) : '';
  } catch { return ''; }
}

/* ---------- 设置 ---------- */

function readForm() {
  const num = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    dryRun: el.dry.checked,
    scope: el.scope.value,
    limit: num(el.limit.value, 0, 500, DEFAULTS.limit),
    concurrency: num(el.concurrency.value, 1, 10, DEFAULTS.concurrency),
    host: el.host.value.trim().toLowerCase(),
    anyHost: el.anyHost.checked,
    hostEdited: el.host.dataset.edited === '1',
  };
}

function applyForm(s) {
  el.dry.checked = s.dryRun;
  el.scope.value = s.scope;
  el.limit.value = s.limit;
  el.concurrency.value = s.concurrency;
  el.host.value = s.host;
  el.host.dataset.edited = s.hostEdited ? '1' : '';
  el.anyHost.checked = s.anyHost;
  el.host.disabled = s.anyHost;
  el.fillHost.disabled = s.anyHost;
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

/* ---------- 找出要处理的标签页 ---------- */

function tabQuery(scope) {
  const q = {};
  if (scope === 'window') q.currentWindow = true;
  if (scope === 'selected') { q.currentWindow = true; q.highlighted = true; }
  return q; // 'all' 不加限制 = 所有窗口
}

function matches(tab, form) {
  let u;
  try { u = new URL(tab.url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false; // edge:// 之类的页面注入不了
  if (form.anyHost) return true;
  return !!form.host && u.hostname.toLowerCase().includes(form.host);
}

// 目标标签页在 popup 里确定,再把 id 发给后台。
// 这样「你看到的数量」和「实际处理的」一定一致(后台没有「当前窗口」的概念)
async function getTargets(form) {
  const all = (await chrome.tabs.query(tabQuery(form.scope))).filter(t => matches(t, form));
  all.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
  const picked = form.limit > 0 ? all.slice(0, form.limit) : all;
  return { all, picked };
}

async function refreshCount() {
  const form = readForm();
  if (!form.anyHost && !form.host) { el.count.textContent = '先填域名,或勾选「所有网站」'; return; }
  const { all, picked } = await getTargets(form);
  el.count.textContent = `匹配到 ${all.length} 个标签页,本次处理 ${picked.length} 个`;
}

// 上一次运行里「提交之前就出错」的标签页(提交之后出错 / 结果未知的不能重跑)
async function retryTargets() {
  const items = (lastRun?.items || []).filter(it => it.status === 'error' && !it.afterFinal);
  const out = [];
  for (const it of items) {
    const tab = await chrome.tabs.get(it.tabId).catch(() => null);
    if (tab) out.push({ id: tab.id, title: tab.title || it.title });
  }
  return out;
}

/* ---------- 开始 / 重跑 / 停止 ---------- */

function setHint(text) { el.hint.textContent = text || ''; }

function arm(key, n) {
  armedKey = key;
  const btn = el[key];
  btn.textContent = `再点一次:真实提交 ${n} 个`;
  btn.classList.remove('primary');
  btn.classList.add('danger');
  clearTimeout(armTimer);
  armTimer = setTimeout(disarm, 5000); // 5 秒内不点第二次就自动取消
  setHint('真实提交不可撤销,提交后你将无法再访问这些任务。');
}

function disarm() {
  armedKey = null;
  clearTimeout(armTimer);
  el.start.textContent = '开始';
  el.retry.textContent = '重跑失败项';
  for (const b of [el.start, el.retry]) b.classList.remove('danger');
  el.start.classList.add('primary');
}

async function launch(key, targets) {
  const form = readForm();
  if (!targets.length) { disarm(); setHint(key === 'start' ? '没有找到匹配的标签页。' : '没有可重跑的标签页。'); return; }

  if (!form.dryRun && armedKey !== key) { disarm(); arm(key, targets.length); return; } // 第一次点击只是「上膛」
  disarm();
  setHint('');

  try {
    const r = await chrome.runtime.sendMessage({
      type: 'START',
      options: { dryRun: form.dryRun, concurrency: form.concurrency },
      tabs: targets.map(t => ({ id: t.id, title: t.title || '(无标题)' })),
    });
    if (r && r.ok === false) setHint(r.error || '启动失败');
  } catch (e) {
    setHint('无法联系后台脚本:' + e.message);
  }
}

async function onStart() {
  const form = readForm();
  if (!form.anyHost && !form.host) { disarm(); setHint('先填域名,或勾选「所有网站」。'); return; }
  const { picked } = await getTargets(form);
  await launch('start', picked);
}

async function onRetry() { await launch('retry', await retryTargets()); }

async function onStop() {
  try { await chrome.runtime.sendMessage({ type: 'STOP' }); }
  catch (e) { setHint('无法联系后台脚本:' + e.message); }
}

/* ---------- 显示进度 ---------- */

function render(run) {
  lastRun = run || null;
  const running = !!run && run.state === 'running';
  el.stop.hidden = !running;
  el.start.disabled = running;
  el.clear.disabled = running;
  for (const k of FORM_FIELDS) el[k].disabled = running;
  if (!running) { el.host.disabled = el.anyHost.checked; el.fillHost.disabled = el.anyHost.checked; }
  el.fillHost.disabled = running || el.anyHost.checked;

  const retryable = !running && !!run && run.items.some(it => it.status === 'error' && !it.afterFinal);
  el.retry.hidden = !retryable;

  if (!run || !run.total) {
    el.summary.textContent = '还没有运行记录';
    el.bar.max = 1; el.bar.value = 0;
    el.list.replaceChildren();
    return;
  }

  const c = run.counts || {};
  const parts = [`${run.done}/${run.total}`];
  if (run.dryRun) parts.push('试运行');
  if (c.success) parts.push(`成功 ${c.success}`);
  if (c.ready) parts.push(`可提交 ${c.ready}`);
  if (c.error) parts.push(`失败 ${c.error}`);
  if (c.unknown) parts.push(`未知 ${c.unknown}`);
  if (c.skipped) parts.push(`跳过 ${c.skipped}`);
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
  if (!tab) { setHint('这个标签页已经关闭了。'); return; }
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/* ---------- 事件绑定 ---------- */

async function onFormChange(e) {
  disarm();
  setHint('');
  if (e && e.target === el.host) el.host.dataset.edited = '1'; // 手动改过域名,下次打开不再自动覆盖
  el.host.disabled = el.anyHost.checked;
  el.fillHost.disabled = el.anyHost.checked;
  await chrome.storage.local.set({ settings: readForm() });
  refreshCount();
}
for (const k of FORM_FIELDS) el[k].addEventListener(k === 'host' ? 'input' : 'change', onFormChange);

el.fillHost.addEventListener('click', async () => {
  const d = await activeTabDomain();
  if (!d) { setHint('当前标签页不是普通网页,取不到域名。'); return; }
  el.host.value = d;
  el.host.dataset.edited = '';
  await onFormChange();
});

el.start.addEventListener('click', onStart);
el.retry.addEventListener('click', onRetry);
el.stop.addEventListener('click', onStop);
el.clear.addEventListener('click', () => chrome.storage.session.remove('run'));

// 后台每更新一次进度,这里就跟着重画(popup 开着或重新打开都一样)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.run) render(changes.run.newValue);
});

(async function init() {
  const s = await loadSettings();
  // 没手动改过域名 → 每次都以「当前所在标签页」为准
  if (!s.hostEdited || !s.host) {
    const d = await activeTabDomain();
    if (d) { s.host = d; s.hostEdited = false; }
  }
  applyForm(s);
  const { run } = await chrome.storage.session.get('run');
  render(run);
  await refreshCount();
})();
