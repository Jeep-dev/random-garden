// 在每个 LabelWise 页面里静默运行：一旦「任务基本信息」弹窗出现过，就把该 data_id 的总帧数记下来。
// 这样弹窗关掉/标签页休眠之后，弹出窗口里仍然能拿到总帧数。
(function () {
  let saved = '';
  function scan() {
    const t = document.body ? document.body.innerText : '';
    const frames = (t.match(/总帧数\D{0,8}?(\d+)/) || [])[1];
    const dataId = (t.match(/data_id\s*[:：]?\s*([0-9a-f]{16,})/i) || [])[1]
      || new URLSearchParams(location.search).get('data_id');
    if (!frames || !dataId || saved === dataId + frames) return;
    saved = dataId + frames;
    try { chrome.storage.local.set({ ['f_' + dataId]: frames }); } catch (e) { /* 扩展被重载后旧页面会报错，忽略 */ }
  }
  scan();
  setInterval(scan, 1500);
})();

// 扩展自动打开过的「任务基本信息」：切到这个标签页时再点一次 ✕，确保关掉
(function () {
  const fire = (el) => {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true, view: window }));
  };
  const openModal = () => [...document.querySelectorAll('.ant-modal-wrap')]
    .find((w) => getComputedStyle(w).display !== 'none' && w.textContent.includes('总帧数'));
  async function closeIfFlagged() {
    if (document.visibilityState !== 'visible' || document.documentElement.dataset.lwClose !== '1') return;
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const w = openModal();
      if (!w) { delete document.documentElement.dataset.lwClose; return; }
      const x = w.querySelector('button.ant-modal-close, .ant-modal-close');
      if (x) fire(x);
    }
  }
  // 信息栏已经关上就清掉标记，之后你自己打开的不会被关
  setInterval(() => { if (document.documentElement.dataset.lwClose === '1' && !openModal()) delete document.documentElement.dataset.lwClose; }, 1000);
  document.addEventListener('visibilitychange', closeIfFlagged);
  window.addEventListener('focus', closeIfFlagged);
})();
