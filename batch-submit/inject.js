// inject.js —— 被后台注入到每个标签页里,在页面内执行点击流程。
// 流程:顶栏「提交」→ 弹窗里确认下拉是「质检通过」→ 弹窗「提交」→ 出现「提交任务成功」→ 点「返回主页领取新任务」
//
// 返回 { status, message, afterFinal }
//   ready    试运行走通了(没有真提交)
//   success  提交成功
//   error    出错,留给人处理(afterFinal=true 表示已经点过最终提交,服务端报了错)
//   skipped  前置条件不满足 / 被停止,没有动任何东西
//   unknown  点了最终提交但没等到结果,不知道成没成 —— 必须人工确认,不要重试
//
// 页面文案如果和你们平台不一致,只改下面的 CFG,其余不用动。
(() => {
  if (window.__bs && window.__bs.running) return; // 正在跑就不要覆盖

  const CFG = {
    TARGET: '质检通过',              // 要选的下拉选项
    READY_TEXT: '任务有效',          // 页面上必须出现的状态文字,没有就跳过;填 '' 关闭这个检查
    TOP_BTN: '提交',                 // 顶栏按钮
    CONFIRM_HINT: '是否提交',        // 确认弹窗里的文字,用来认出它
    OK_BTN: '提交',                  // 确认弹窗里的按钮
    CANCEL_BTN: '取消',              // 试运行时用它关掉弹窗
    SUCCESS_TEXT: '提交任务成功',    // 成功弹窗里的文字
    HOME_BTN: '返回主页领取新任务',  // 成功弹窗里的按钮
    // 各步骤最长等待(毫秒)。你们网络慢,所以给得很宽
    T: { page: 30000, tag: 8000, dialog: 30000, option: 4000, value: 8000, final: 30000 },
  };

  const bs = (window.__bs = { running: false, abort: false, locked: false, run });

  /* ---------------- 小工具 ---------------- */

  // antd 会在两个汉字的按钮里自动插空格("提 交"),所以比较前先去掉所有空白
  const norm = s => (s || '').replace(/\s+/g, '');

  // 真正看得见:有宽高、没被 display:none / visibility:hidden。
  // (antd 的无障碍隐藏列表高度为 0,弹窗关闭后是 display:none,都会被判为不可见)
  const isVisible = el => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };

  const isDisabled = el =>
    !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('ant-btn-disabled'));

  // 等条件成立。用 MutationObserver 触发检查(后台标签页的定时器会被浏览器降频,
  // 但 DOM 变化的回调不受影响),定时器只做兜底。
  function waitFor(check, { timeout, label }) {
    return new Promise((resolve, reject) => {
      let done = false;
      let last = 0;
      let mo, poll, deadline;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        mo.disconnect(); clearInterval(poll); clearTimeout(deadline);
        fn(v);
      };
      const tick = () => {
        if (done) return;
        last = Date.now();
        try {
          if (bs.abort && !bs.locked) return finish(reject, new Error('__abort'));
          const v = check();
          if (v) finish(resolve, v);
        } catch (e) { finish(reject, e); }
      };
      mo = new MutationObserver(() => { if (Date.now() - last >= 100) tick(); });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      poll = setInterval(tick, 400);
      deadline = setTimeout(() => finish(reject, new Error('等待超时:' + label)), timeout);
      tick();
    });
  }

  // 模拟一次完整的鼠标点击。antd 的下拉框监听的是 mousedown,只发 click 打不开
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const P = window.PointerEvent || MouseEvent;
    const fire = (Type, type, extra) => el.dispatchEvent(new Type(type, { ...base, ...extra }));
    fire(P, 'pointerdown', { buttons: 1, pointerType: 'mouse', isPrimary: true });
    fire(MouseEvent, 'mousedown', { buttons: 1 });
    fire(P, 'pointerup', { buttons: 0, pointerType: 'mouse', isPrimary: true });
    fire(MouseEvent, 'mouseup', { buttons: 0 });
    fire(MouseEvent, 'click', { buttons: 0 });
  }

  const findButton = (text, { scope = document, outside = null } = {}) =>
    [...scope.querySelectorAll('button, [role="button"], .ant-btn')].find(
      b => norm(b.textContent) === norm(text) && isVisible(b) && !(outside && b.closest(outside))
    ) || null;

  const visibleDialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
  const findDialog = text => visibleDialogs().find(d => norm(d.textContent).includes(norm(text))) || null;

  /* ---------------- 下拉框 ---------------- */

  const selectRoot = dialog => dialog.querySelector('.ant-select') || dialog.querySelector('[role="combobox"]');
  const selectValue = root => {
    const item = root.querySelector('.ant-select-selection-item');
    return norm(item ? item.textContent : root.textContent);
  };
  // 只认「可见下拉层」里的选项,不会点到高度为 0 的无障碍隐藏列表;文字必须完全相等,不会误选别的
  const findOption = text => {
    const antd = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')];
    const pool = antd.length ? antd : [...document.querySelectorAll('[role="option"]')];
    return pool.find(o => norm(o.textContent) === norm(text) && isVisible(o)) || null;
  };

  /* ---------------- 和后台通信 ---------------- */

  const send = msg => {
    try { return chrome.runtime.sendMessage(msg).catch(() => null); }
    catch { return Promise.resolve(null); }
  };
  const step = text => { send({ type: 'PHASE', text }); };

  /* ---------------- 提交之后的判断 ---------------- */

  const clip = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  // 弹窗文字:优先取「标题:内容」,取不到再退回整段文字
  const dialogText = d => {
    const t = d.querySelector('.ant-modal-confirm-title, .ant-modal-title');
    const b = d.querySelector('.ant-modal-confirm-content, .ant-modal-body');
    return t && b ? clip(t.textContent) + ':' + clip(b.textContent) : clip(d.textContent);
  };

  // 成功的标志:出现「提交任务成功」弹窗,或带「返回主页领取新任务」按钮的弹窗
  const findSuccess = () => findDialog(CFG.SUCCESS_TEXT) || findDialog(CFG.HOME_BTN);

  // 找提交后的报错,没有返回 null。
  // before = 点最终提交前就开着的弹窗(比如「任务基本信息」),它们不是提交的结果,不算
  const ERROR_WORDS = /失败|错误|异常|无法|不能|缺少|未通过|请先|超时|不允许|没有权限/;
  function scanError(confirmDialog, before) {
    // 1. 新出现了别的弹窗(比如二次确认、错误弹窗):不替人做决定,当作需要人处理
    const other = visibleDialogs().find(d => !before.includes(d) &&
      d !== confirmDialog && !d.contains(confirmDialog) && !confirmDialog.contains(d));
    if (other) return '出现非预期弹窗:' + dialogText(other);

    // 2. 顶部提示 / 通知
    for (const t of document.querySelectorAll('.ant-message-notice, .ant-notification-notice')) {
      if (!isVisible(t)) continue;
      const text = clip(t.textContent);
      if (!text) continue;
      const iconErr = t.querySelector(
        '.anticon-close-circle, .anticon-exclamation-circle, .anticon-warning, [class*="-error"], [class*="-warning"]');
      if (iconErr || ERROR_WORDS.test(text)) return text;
    }

    // 3. 确认弹窗里的校验提示
    for (const a of confirmDialog.querySelectorAll('[role="alert"], .ant-form-item-explain-error, .ant-alert-error')) {
      if (isVisible(a) && clip(a.textContent)) return clip(a.textContent);
    }
    return null;
  }

  // 成功:先把结果报给后台,再点「返回主页领取新任务」(点完页面会跳走,脚本随之消失)
  async function goHome(message) {
    const done = { status: 'success', afterFinal: true, message };
    await Promise.race([send({ type: 'RESULT', result: done }), new Promise(r => setTimeout(r, 3000))]);
    const home = findButton(CFG.HOME_BTN, { scope: findSuccess() || document });
    if (home) realClick(home);
    return home ? done : { ...done, message: message + '(未找到「' + CFG.HOME_BTN + '」按钮,请手动关闭弹窗)' };
  }

  /* ---------------- 主流程 ---------------- */

  async function flow({ dryRun = true }) {
    const T = CFG.T;

    // 0. 前置检查:找不到顶栏提交按钮 / 不是「任务有效」状态,就什么都不动
    step('等待页面加载');
    let topBtn;
    try {
      topBtn = await waitFor(() => findButton(CFG.TOP_BTN, { outside: '[role="dialog"]' }),
        { timeout: T.page, label: '顶栏「' + CFG.TOP_BTN + '」按钮' });
    } catch (e) {
      if (e.message === '__abort') throw e;
      return { status: 'skipped', message: '未检测到顶栏「' + CFG.TOP_BTN + '」按钮(非任务页或页面未加载完成)' };
    }

    // 页面上还开着成功弹窗 = 之前已经提交成功了(比如上次被误判成失败),绝不能再提交一次
    if (findSuccess()) {
      if (dryRun) return { status: 'skipped', message: '此前已提交成功(试运行,未执行任何操作)' };
      return goHome('此前已提交成功,本次仅执行「' + CFG.HOME_BTN + '」');
    }

    if (CFG.READY_TEXT) {
      try {
        await waitFor(() => document.body && document.body.textContent.includes(CFG.READY_TEXT),
          { timeout: T.tag, label: CFG.READY_TEXT });
      } catch (e) {
        if (e.message === '__abort') throw e;
        return { status: 'skipped', message: '任务状态不是「' + CFG.READY_TEXT + '」,未执行操作' };
      }
    }

    // 1. 点顶栏「提交」(如果上次失败留下了打开的确认弹窗,就直接用它)
    let dialog = findDialog(CFG.CONFIRM_HINT);
    if (!dialog) {
      if (isDisabled(topBtn)) return { status: 'skipped', message: '顶栏「' + CFG.TOP_BTN + '」按钮不可用' };
      step('步骤 1/3:点击顶栏「' + CFG.TOP_BTN + '」');
      realClick(topBtn);
      dialog = await waitFor(() => findDialog(CFG.CONFIRM_HINT),
        { timeout: T.dialog, label: '确认弹窗' });
    }

    // 2. 弹窗里的下拉框必须是「质检通过」(默认值可能已经是,不是才去改)
    const root = selectRoot(dialog);
    if (!root) throw new Error('确认弹窗中未找到下拉框');
    if (selectValue(root) !== norm(CFG.TARGET)) {
      step('步骤 2/3:选择「' + CFG.TARGET + '」');
      const trigger = root.querySelector('.ant-select-selector') || root;
      const combo = root.querySelector('[role="combobox"]');
      let option = null;
      for (let i = 0; i < 3 && !option; i++) {
        if (!combo || combo.getAttribute('aria-expanded') !== 'true') realClick(trigger);
        try {
          option = await waitFor(() => findOption(CFG.TARGET), { timeout: T.option, label: '「' + CFG.TARGET + '」选项' });
        } catch (e) { if (e.message === '__abort') throw e; }
      }
      if (!option) throw new Error('下拉框中未找到「' + CFG.TARGET + '」选项');
      realClick(option);
      await waitFor(() => selectValue(root) === norm(CFG.TARGET), { timeout: T.value, label: '选中后的值' });
    }
    if (selectValue(root) !== norm(CFG.TARGET)) throw new Error('下拉框取值不是「' + CFG.TARGET + '」,已中止');

    // 3. 试运行:不点最终提交,点取消把弹窗关掉
    if (dryRun) {
      const cancel = findButton(CFG.CANCEL_BTN, { scope: dialog });
      if (cancel) realClick(cancel);
      try { await waitFor(() => !isVisible(dialog), { timeout: 3000, label: '弹窗关闭' }); } catch { /* 关得慢不影响结论 */ }
      return { status: 'ready', message: '预检通过(试运行,未提交)' };
    }

    // 4. 点弹窗里的「提交」。从这一刻起不再响应「停止」,也不会重试
    const okBtn = findButton(CFG.OK_BTN, { scope: dialog });
    if (!okBtn || isDisabled(okBtn)) throw new Error('确认弹窗中的「' + CFG.OK_BTN + '」按钮不可用');
    step('步骤 3/3:确认提交');
    await send({ type: 'PHASE', phase: 'final-clicked', text: '已执行最终提交,等待结果' }); // 先告诉后台,再点
    const before = visibleDialogs();
    // 点之前最后再核对一次下拉框,确保提交的一定是「质检通过」
    if (selectValue(root) !== norm(CFG.TARGET)) throw new Error('下拉框取值不是「' + CFG.TARGET + '」,已中止');
    bs.locked = true;
    realClick(okBtn);

    // 5. 等结果:只要成功弹窗出来就是成功。网络慢时它会晚到,所以看到报错也只先记下,继续等满 T.final
    let error = null;
    const ok = await waitFor(() => {
      if (findSuccess()) return true;
      error = scanError(dialog, before) || error;
      return false;
    }, { timeout: T.final, label: '提交结果' }).catch(() => false);
    if (!ok && error) return { status: 'error', afterFinal: true, message: '提交后出现异常:' + error + '。请人工核实,切勿重复提交' };
    if (!ok) {
      return { status: 'unknown', afterFinal: true,
        message: '已执行最终提交,' + T.final / 1000 + ' 秒内未收到结果。请人工核实提交状态,切勿重复提交' };
    }

    // 6. 成功
    return goHome('提交成功');
  }

  async function run(opts) {
    if (bs.running) return { status: 'skipped', message: '该标签页正在处理中' };
    bs.running = true; bs.abort = false; bs.locked = false;
    try {
      return await flow(opts || {});
    } catch (e) {
      if (e.message === '__abort') return { status: 'skipped', message: '已停止,未提交' };
      if (bs.locked) return { status: 'unknown', afterFinal: true, message: e.message + '(已执行最终提交,请人工核实,切勿重复提交)' };
      return { status: 'error', message: e.message };
    } finally {
      bs.running = false;
    }
  }
})();
