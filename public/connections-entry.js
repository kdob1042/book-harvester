// The app replaces its header on navigation. Keep this additive menu extension
// independent of app.js, so it does not interfere with capture/edit/AI workflows.
export function installConnectionsEntry(root, open) {
  let queued = false;
  const attach = () => {
    queued = false;
    const panel = root.querySelector('.menu-panel');
    if (!panel || panel.querySelector('[data-connections-entry]')) return;
    const button = document.createElement('button'); button.type = 'button';
    button.dataset.connectionsEntry = ''; button.textContent = 'つながりを見る';
    panel.prepend(button);
  };
  const onClick = async event => {
    const button = event.target.closest?.('[data-connections-entry]');
    if (!button || !root.contains(button) || button.disabled) return;
    button.disabled = true;
    try { await open(button); }
    catch {
      const notice = document.querySelector('#notice');
      if (notice) notice.textContent = 'ビューワーを読み込めませんでした。接続を確認して再試行してください。';
    } finally { button.disabled = false; }
  };
  root.addEventListener('click', onClick);
  const observer = new MutationObserver(() => {
    if (!queued) { queued = true; queueMicrotask(attach); }
  });
  observer.observe(root, { childList: true, subtree: true }); attach();
  return () => { observer.disconnect(); root.removeEventListener('click', onClick); };
}
const root = document.querySelector('#app');
if (root) installConnectionsEntry(root, async opener => (await import('./connections-viewer.js')).openConnections(opener));
