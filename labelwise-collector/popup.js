// 不限域名：只要是 http(s) 页面且网址里带 data_id 参数就算标注页
const isLW = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && x.searchParams.has('data_id'); } catch (e) { return false; } };
const $ = (id) => document.getElementById(id);
// 在标签页里打开时（右键菜单 / 快捷键）换成宽版布局
if (location.search.includes('tab=1')) document.documentElement.className = 'tab';

// 注入页面执行（必须自包含）：从 localStorage / sessionStorage / cookie 里找登录令牌（JWT），取过期时间最晚的那个
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

let rows = [];

// 把 Edge 返回的英文报错翻译成：原因 + 怎么办
function explainErr(m) {
  if (/^Blocked$|ExtensionsSettings policy/i.test(m))
    return 'Edge 禁止扩展在此网站运行：在该标签页点地址栏右边的拼图图标，打开「允许在 … 使用扩展」，再点「重新读取」。';
  if (/Cannot access contents|must request permission/i.test(m))
    return '扩展没有此网站的访问权限：点「授权访问网站」，或在 edge://extensions → 详细信息 → 网站访问权限 选"在所有网站上"。';
  if (/读取超时/.test(m))
    return '标注页没有响应（可能还在加载）：等页面加载一会儿再点「重新读取」。';
  if (/No tab with id|Frame with ID .* was removed|discarded/i.test(m))
    return '标签页已被 Edge 休眠或刚关闭：切到任意一个标注页让它加载完，再点「重新读取」。';
  return '无法读取页面（Edge 原始报错：' + m + '）';
}

// 令牌存在本机扩展里，有效期内一直复用（浏览器重启也不用重新读），页面一个都没加载出来也能用；
// 过期或被平台拒绝（401/403）时才重新从标注页读取
async function getToken(tabs) {
  const now = Date.now() / 1000;
  const { lwToken } = await chrome.storage.local.get('lwToken');
  if (lwToken && (!lwToken.exp || lwToken.exp > now + 60)) return { token: lwToken.token };
  let err = '所有标注页里都没找到有效的登录令牌：请在任意标注页重新登录或刷新，再点「重新读取」。';
  // 所有标签页同时读，不等页面加载完（injectImmediately），每页最多等 3 秒，谁先读到有效令牌就用谁。
  // 一个个按顺序读的话，开了几十个还在加载的标注页时会卡在第一个页面上
  const read = (tab) => Promise.race([
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findToken, injectImmediately: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('读取超时')), 3000)),
  ]).then(([g]) => {
    const t = g && g.result;
    if (t && (!t.exp || t.exp > now + 60)) return t;
    throw new Error('该页没有有效令牌');
  }, (e) => { err = explainErr(e && e.message ? e.message : String(e)); throw e; });
  try {
    const t = await Promise.any(tabs.filter((t) => !t.discarded).concat(tabs.filter((t) => t.discarded)).map(read));
    await chrome.storage.local.set({ lwToken: t });
    return { token: t.token };
  } catch (e) { return { token: '', err }; }
}

// 任务详情接口：GET /api/v1/task/{task}，返回里的 total_frame_count 就是总帧数
async function fetchFrames(origin, task, token) {
  const r = await fetch(`${origin}/api/v1/task/${encodeURIComponent(task)}`, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
  });
  if (r.status === 401 || r.status === 403) { await chrome.storage.local.remove('lwToken'); throw new Error('登录令牌失效，请点「重新读取」'); }
  if (!r.ok) throw new Error('接口返回 ' + r.status);
  const j = await r.json();
  const o = j && j.data && typeof j.data === 'object' ? j.data : j;
  if (o.total_frame_count == null) throw new Error('接口返回里没有 total_frame_count');
  return String(o.total_frame_count);
}

// 总帧数来自接口，data_id / 任务名称 / 网址都直接取自标签页网址；所有标签页同时请求，结果按标签页从左到右排列
async function collect() {
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((t) => isLW(t.url)).sort((a, b) => a.index - b.index);
  const { token, err: tokenErr } = tabs.length ? await getToken(tabs) : { token: '' };
  return Promise.all(tabs.map(async (tab) => {
    const u = new URL(tab.url), q = u.searchParams;
    const row = { frames: '', dataId: q.get('data_id'), task: q.get('task_name') || '', url: tab.url, err: '' };
    if (!q.get('task')) row.err = '网址里没有 task 参数，无法请求接口';
    else if (!token) row.err = tokenErr;
    else {
      try { row.frames = await fetchFrames(u.origin, q.get('task'), token); } catch (e) { row.err = '接口读取失败：' + e.message; }
    }
    return row;
  }));
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

async function refresh() {
  $('sum').textContent = '读取中…';
  rows = await collect();
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
  $('err').textContent = miss.length ? miss.map((r) => `#${rows.indexOf(r) + 1} ${r.err}`).join('\n') : '';
}

$('copyA').onclick = () => copy(tsvA(), '已复制 A 列：请粘贴到 A 列起始格');
$('copyF').onclick = () => copy(tsvF(), '已复制 F 列：请粘贴到 F 列起始格');
$('grant').onclick = async () => {
  try {
    const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
    flash(ok ? '已授权，正在重新读取…' : '未授权（请在弹出的提示里点允许）');
    if (ok) refresh();
  } catch (e) { flash('授权失败：' + e.message); }
};
$('reload').onclick = () => refresh();
refresh();
