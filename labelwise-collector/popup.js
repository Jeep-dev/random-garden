// 不限域名：只要是 http(s) 页面且网址里带 data_id 参数就算标注页
const isLW = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && x.searchParams.has('data_id'); } catch (e) { return false; } };
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 以下函数会被注入页面执行，必须自包含 =================

// 读取「任务基本信息」：没打开就点开（doOpen=true 时），读到后点 ✕ 关掉
async function grabAuto(doOpen) {
  const scan = () => {
    const t = document.body ? document.body.innerText : '';
    const m = (re) => { const r = t.match(re); return r ? r[1].trim() : ''; };
    return { frames: m(/总帧数\D{0,8}?(\d+)/), dataId: m(/data_id\s*[:：]?\s*([0-9a-f]{16,})/i), task: m(/任务名称\s*[:：]?\s*(\S+)/) };
  };
  const fire = (el, types) => {
    for (const t of types || ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const C = t.startsWith('pointer') ? PointerEvent : t.startsWith('key') ? KeyboardEvent : MouseEvent;
      el.dispatchEvent(new C(t, { bubbles: true, cancelable: true, view: window, key: 'Escape', code: 'Escape', keyCode: 27 }));
    }
  };
  // 后台标签页的计时器会被 Edge 限速到每秒一次，所以用 MutationObserver 等页面变化，不靠轮询
  const waitFor = (cond, ms) => new Promise((res) => {
    if (cond()) return res(true);
    const mo = new MutationObserver(() => { if (cond()) { mo.disconnect(); clearTimeout(t); res(true); } });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const t = setTimeout(() => { mo.disconnect(); res(cond()); }, ms);
  });

  const btn = document.querySelector('button[aria-label="任务基本信息"]');
  let p = scan();
  let opened = false;
  if (!p.frames && doOpen) {
    if (!btn) return { ...p, err: '找不到「任务基本信息」按钮（页面可能还没加载完，稍后点「重新读取」）' };
    fire(btn, ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    opened = true;
    await waitFor(() => !!scan().frames, 6000);
    p = scan();
    if (!p.frames) {
      const t = document.body.innerText, i = t.indexOf('总帧数');
      return { ...p, err: '点开了但没读到总帧数；「总帧数」附近文字=' + (i < 0 ? '(页面上没有)' : JSON.stringify(t.slice(i, i + 30))) };
    }
  }
  if (!p.frames) return p;

  // 关闭：信息栏是 antd Modal，✕ 是其中的 button.ant-modal-close（只会关、不会开，点多次也安全）。
  // 后台标签页里关闭动画会暂停，所以同时打标记，切到该标签页时 content.js 会再点一次 ✕。
  const modal = [...document.querySelectorAll('.ant-modal')].find((m) => m.textContent.includes('总帧数'));
  const x = modal && modal.querySelector('button.ant-modal-close, .ant-modal-close');
  let closed = '';
  if (x) { fire(x); closed = 'x'; document.documentElement.dataset.lwClose = '1'; }
  else if (btn && opened) { fire(btn); closed = 'toggle'; }
  return { ...p, closed };
}

// 从页面的 localStorage / sessionStorage / cookie 里找登录令牌（JWT），取过期时间最晚的那个
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

// ============================ 弹窗逻辑 ============================

let rows = [];

// 令牌只存在浏览器会话里（关掉浏览器即清空），有效期内所有标签页共用，标签页休眠也不影响
async function getToken(tabs) {
  const now = Date.now() / 1000;
  const { lwToken } = await chrome.storage.session.get('lwToken');
  if (lwToken && (!lwToken.exp || lwToken.exp > now + 60)) return lwToken.token;
  // 先试没休眠的标签页
  for (const tab of [...tabs].sort((a, b) => (a.discarded ? 1 : 0) - (b.discarded ? 1 : 0))) {
    try {
      const [g] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findToken });
      const t = g && g.result;
      if (t && (!t.exp || t.exp > now + 60)) { await chrome.storage.session.set({ lwToken: t }); return t.token; }
    } catch (e) { /* 换下一个标签页 */ }
  }
  return '';
}

// 直接请求任务详情接口：GET /api/v1/task/{task}，返回里的 total_frame_count 就是总帧数
async function fetchTask(origin, task, token) {
  const r = await fetch(`${origin}/api/v1/task/${encodeURIComponent(task)}`, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
  });
  if (r.status === 401 || r.status === 403) { await chrome.storage.session.remove('lwToken'); throw new Error('登录令牌失效'); }
  if (!r.ok) throw new Error('接口返回 ' + r.status);
  const j = await r.json();
  const o = j && j.data && typeof j.data === 'object' ? j.data : j;
  if (o.total_frame_count == null) throw new Error('接口返回里没有 total_frame_count');
  return { frames: String(o.total_frame_count), task: o.task_name || o.name || '' };
}

// 把 Edge 返回的英文报错翻译成：原因 + 怎么办
function explainErr(m) {
  if (/^Blocked$|ExtensionsSettings policy/i.test(m))
    return 'Edge 禁止扩展在此网站运行：在该标签页点地址栏右边的拼图图标，打开「允许在 … 使用扩展」，再点「重新读取」。';
  if (/Cannot access contents|must request permission/i.test(m))
    return '扩展没有此网站的访问权限：点「授权访问网站」，或在 edge://extensions → 详细信息 → 网站访问权限 选"在所有网站上"。';
  if (/No tab with id|Frame with ID .* was removed|discarded/i.test(m))
    return '标签页已被 Edge 休眠或刚关闭：切到该标签页让它加载完，再点「重新读取」。';
  if (/cannot be scripted|chrome:\/\/|edge:\/\//i.test(m))
    return '这是浏览器内置页面，扩展不能读取。';
  return '无法读取页面（Edge 原始报错：' + m + '）';
}

async function lwTabs() {
  return (await chrome.tabs.query({ currentWindow: true })).filter((t) => isLW(t.url)).sort((a, b) => a.index - b.index);
}

async function collect(auto) {
  const cache = await chrome.storage.local.get(null);
  // 所有标签页同时读取，结果仍按标签页从左到右排列
  const tabs = await lwTabs();
  const token = await getToken(tabs);
  const res = await Promise.all(tabs.map(async (tab) => {
    const u = new URL(tab.url), q = u.searchParams;
    const cached = cache['f_' + q.get('data_id')];
    let live = null, err = '';
    // 优先走接口：不点页面、不等弹窗，休眠的标签页也能读
    if (token && q.get('task')) {
      try {
        const a = await fetchTask(u.origin, q.get('task'), token);
        chrome.storage.local.set({ ['f_' + q.get('data_id')]: a.frames });
        return { frames: a.frames, dataId: q.get('data_id'), task: q.get('task_name') || a.task, url: tab.url, err: '' };
      } catch (e) { err = '接口读取失败（' + e.message + '），改用页面读取'; }
    }
    // 接口不可用时退回原来的点开弹窗读取
    try {
      const [g] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabAuto, args: [auto && !cached] });
      live = g && g.result;
      if (live && live.err) err = live.err;
    } catch (e) { err = explainErr(e && e.message ? e.message : String(e)); }
    const dataId = q.get('data_id') || (live && live.dataId) || '';
    if (!dataId) return null;
    const frames = (live && live.frames) || cached || '';
    if (frames && !cached) chrome.storage.local.set({ ['f_' + dataId]: frames });
    return { frames, dataId, task: (live && live.task) || q.get('task_name') || '', url: tab.url, err };
  }));
  return res.filter(Boolean);
}

const cell = (s) => (/[\t\n"]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : s);
// B 列（帧数）在表里是公式自动取 A，C-E 是手填，所以分两次粘贴：A 列一次、F 列一次，互不覆盖
const tsvA = () => rows.map((r) => cell(`总帧数\n${r.frames}\ndata_id\n${r.dataId}\n任务名称\n${r.task}`)).join('\n');
const tsvF = () => rows.map((r) => cell(r.url)).join('\n');

function flash(t) { $('msg').textContent = t; setTimeout(() => { $('msg').textContent = ''; }, 3000); }

async function copy(text, tip) {
  if (!rows.length) return flash('没有可复制的数据');
  await navigator.clipboard.writeText(text);
  flash(tip);
}

async function refresh(auto) {
  $('sum').textContent = auto ? '正在读取所有标签页，请稍候…' : '读取中…';
  rows = await collect(auto);
  const miss = rows.filter((r) => !r.frames);
  $('sum').innerHTML = `共 ${rows.length} 个标签页` + (miss.length
    ? `，<span class="warn">${miss.length} 个缺总帧数（红色）</span>` : '，<span class="ok">全部齐全</span>');
  $('tb').innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    if (!r.frames) tr.className = 'miss';
    [i + 1, r.frames || '—', r.dataId, r.task].forEach((v) => {
      const td = document.createElement('td'); td.textContent = v; td.title = (!r.frames && r.err) ? r.err : v; tr.appendChild(td);
    });
    $('tb').appendChild(tr);
  });
  $('grant').style.display = miss.some((r) => /没有此网站的访问权限/.test(r.err)) ? '' : 'none';
  $('err').textContent = miss.length ? miss.map((r) => `#${rows.indexOf(r) + 1} ${r.err || '未读到，请点「重新读取」'}`).join('\n') : '';
}

$('copyA').onclick = () => copy(tsvA(), '已复制 A 列：请粘贴到 A 列起始格');
$('copyF').onclick = () => copy(tsvF(), '已复制 F 列：请粘贴到 F 列起始格');
$('grant').onclick = async () => {
  try {
    const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
    flash(ok ? '已授权，正在重新读取…' : '未授权（请在弹出的提示里点允许）');
    if (ok) refresh(true);
  } catch (e) { flash('授权失败：' + e.message); }
};
$('reload').onclick = () => refresh(true);
refresh(true);
