// 标注页休眠：点图标立刻休眠所有标注页（每个窗口当前显示的那页除外），右键图标设置自动休眠。
// 没有弹出窗口，点图标直接执行，内存再满也不用等窗口加载。
//
// 用的是 chrome.tabs.discard：把页面从内存里卸掉，标签还留在标签栏上，点它会重新加载。
// Edge 自带的「睡眠标签页」会跳过它认为还在忙的页面（点云标注页一直在后台加载），这里不受那套规则限制。
// 采集扩展和批量提交助手只用标签页的网址，休眠的页面照样能采集、能提交。

'use strict';

const AUTO_CHOICES = [0, 1, 3, 10];   // 自动休眠：0 = 关，其余是「多少分钟没看过就休眠」

// 标注页：网址带 data_id，或者是带 task 参数的 /editor 页
function isTaskPage(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    return u.searchParams.has('data_id') || (u.pathname.startsWith('/editor') && u.searchParams.has('task'));
  } catch { return false; }
}

// 休眠符合条件的标注页,返回休眠了几个。idleMs 有值时只休眠这么久没看过的
async function sleepTabs(idleMs) {
  const now = Date.now();
  const tabs = (await chrome.tabs.query({})).filter(t =>
    !t.active && !t.discarded && isTaskPage(t.url) &&
    (!idleMs || (t.lastAccessed && now - t.lastAccessed >= idleMs)));
  let n = 0;
  for (const t of tabs) {
    try { if (await chrome.tabs.discard(t.id)) n++; } catch { /* 标签页刚关掉等情况,跳过 */ }
  }
  return n;
}

// 图标角标显示这次休眠了几个,5 秒后消失
function showCount(n) {
  chrome.action.setBadgeBackgroundColor({ color: '#15803d' });
  chrome.action.setBadgeText({ text: String(n) });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
}

async function sleepNow() { showCount(await sleepTabs()); }

/* ---------- 自动休眠 ---------- */

async function getAuto() {
  const { autoMinutes } = await chrome.storage.local.get('autoMinutes');
  return AUTO_CHOICES.includes(autoMinutes) ? autoMinutes : 0;
}

async function applyAuto(minutes) {
  await chrome.storage.local.set({ autoMinutes: minutes });
  await chrome.alarms.clear('auto-sleep');
  if (minutes) chrome.alarms.create('auto-sleep', { periodInMinutes: 0.5 });
  chrome.action.setTitle({ title: '点击：休眠所有标注页（当前页除外）｜自动休眠：' + (minutes ? minutes + ' 分钟没看过的' : '关') });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'auto-sleep') return;
  const minutes = await getAuto();
  if (minutes) await sleepTabs(minutes * 60 * 1000);
});

/* ---------- 菜单 ---------- */

async function buildMenus() {
  const cur = await getAuto();
  await new Promise((r) => chrome.contextMenus.removeAll(r));
  chrome.contextMenus.create({ id: 'sleep-now', title: '立即休眠所有标注页（当前页除外）', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'sep', type: 'separator', contexts: ['action'] });
  for (const m of AUTO_CHOICES) {
    chrome.contextMenus.create({
      id: 'auto-' + m, type: 'radio', checked: m === cur, contexts: ['action'],
      title: m ? '自动休眠：' + m + ' 分钟没看过的标注页' : '自动休眠：关',
    });
  }
  await applyAuto(cur);
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'sleep-now') sleepNow();
  else if (String(info.menuItemId).startsWith('auto-')) applyAuto(Number(String(info.menuItemId).slice(5)));
});

chrome.action.onClicked.addListener(sleepNow);
