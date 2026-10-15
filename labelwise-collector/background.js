// 不依赖工具栏小窗口的入口：右键扩展图标的菜单 + 快捷键。
// 右键菜单由浏览器自己绘制，小窗口弹不出来时也能用。

const isLW = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && x.searchParams.has('data_id'); } catch (e) { return false; } };
const RESULT_URL = chrome.runtime.getURL('popup.html?tab=1');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open-tab', title: '在新标签页打开采集结果（Alt+Shift+L）', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'discard', title: '休眠所有标注页（释放内存）', contexts: ['action'] });
  });
});

// 在标签页里打开采集结果（和小窗口是同一个页面）；已经开着就切过去并重新读取
async function openResultTab() {
  const [old] = await chrome.tabs.query({ url: chrome.runtime.getURL('popup.html') + '*' });
  if (old) {
    await chrome.tabs.update(old.id, { active: true });
    await chrome.windows.update(old.windowId, { focused: true });
    await chrome.tabs.reload(old.id);
  } else {
    await chrome.tabs.create({ url: RESULT_URL });
  }
}

// 休眠除当前标签页以外的所有标注页。休眠的页面还留在标签栏上，点一下会重新加载；
// 采集只用网址，休眠的页面照样能读
async function discardAll() {
  const tabs = (await chrome.tabs.query({})).filter((t) => isLW(t.url) && !t.active && !t.discarded);
  let n = 0;
  for (const t of tabs) { try { await chrome.tabs.discard(t.id); n++; } catch (e) { /* 正在播放声音等情况会拒绝，跳过 */ } }
  chrome.action.setBadgeBackgroundColor({ color: '#15803d' });
  chrome.action.setBadgeText({ text: String(n) });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
  return n;
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-tab') openResultTab();
  if (info.menuItemId === 'discard') discardAll();
});
chrome.commands.onCommand.addListener((cmd) => { if (cmd === 'open-tab') openResultTab(); });
