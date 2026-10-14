/* Capture the browser's install invitation before React starts. No account data. */
(() => {
  const display = matchMedia('(display-mode: standalone)');
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let invitation = null;
  let state = Object.freeze({ installed: display.matches || navigator.standalone === true, available: false, busy: false, error: '', ios });
  const listeners = new Set();
  const update = patch => { state = Object.freeze({ ...state, ...patch }); listeners.forEach(listener => listener()); };
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); invitation = event;
    update({ available: true, error: '' });
  });
  window.addEventListener('appinstalled', () => {
    invitation = null; update({ installed: true, available: false, busy: false, error: '' });
  });
  const changed = () => update({ installed: display.matches || navigator.standalone === true });
  display.addEventListener('change', changed);
  window.ontimePwa = {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    install: async () => {
      if (!invitation || state.busy) return;
      const event = invitation;
      invitation = null;
      update({ busy: true, available: false, error: '' });
      try {
        // Must invoke prompt directly in the user's click, before awaiting anything.
        await event.prompt();
        const choice = await event.userChoice;
        if (!state.installed) update({ error: choice.outcome === 'accepted' ? '已確認安裝，完成後可從主畫面開啟。' : '已取消安裝；你仍可正常使用網頁，或稍後從瀏覽器選單安裝。' });
      } catch {
        update({ error: '請從瀏覽器選單選擇安裝，或加入主畫面。' });
      } finally { update({ busy: false }); }
    }
  };
})();
