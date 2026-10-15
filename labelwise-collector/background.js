// 不依赖工具栏小窗口的入口：右键扩展图标的菜单 + 快捷键。
// 右键菜单由浏览器自己绘制，小窗口弹不出来时也能用。
// （休眠标注页的功能已移到单独的「标注页休眠」扩展 tab-sleeper）

const RESULT_URL = chrome.runtime.getURL('popup.html?tab=1');

// 让扩展进程一直在：每 30 秒唤醒一次后台。点图标时就不用再临时开进程，直接加载小窗口，
// 开着很多重页面、内存紧张时，临时开进程是最慢的一步
const keepWarm = () => chrome.alarms.create('keep-warm', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { /* 唤醒本身就够了 */ });
chrome.runtime.onStartup.addListener(keepWarm);

chrome.runtime.onInstalled.addListener(() => {
  keepWarm();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open-tab', title: '在新标签页打开采集结果（Alt+Shift+L）', contexts: ['action'] });
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

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-tab') openResultTab();
});
chrome.commands.onCommand.addListener((cmd) => { if (cmd === 'open-tab') openResultTab(); });
