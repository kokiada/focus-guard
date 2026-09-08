function update(state) {
  document.getElementById('task').textContent = state.active?.task_name || '';
  const s = state.elapsed_seconds || 0;
  document.getElementById('time').textContent = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, '0')).join(':');
}
window.focusGuard.subscribe(update);
window.focusGuard.call('state').then(result => { if (result.ok) update(result.data); });

document.getElementById('show-main').addEventListener('click', () => window.focusGuard.call('window:show'));
