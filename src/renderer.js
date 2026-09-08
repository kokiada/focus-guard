const $ = id => document.getElementById(id);
let state, selected = null, completed = false, editing = null, toastTimer, tagFilter = null, search = '';
const icon = window.uiIcon;
const allTags = () => [...new Set(state.tasks.flatMap(t => t.tags || []))].sort((a, b) => a.localeCompare(b, 'ja'));
const tagMarkup = tag => `<span class="task-tag">${escapeHTML(tag)}</span>`;
function visibleTasks() { return state.tasks.filter(t => t.completed === completed && (tagFilter === null || (tagFilter === '' ? !(t.tags || []).length : (t.tags || []).includes(tagFilter))) && [t.name, t.memo, ...(t.tags || [])].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase())); }
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const duration = seconds => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(v => String(v).padStart(2, '0')).join(':');
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500); }
async function call(action, input = {}) {
  try {
    const result = await window.focusGuard.call(action, input);
    if (!result.ok) throw Error(result.error);
    $('error').hidden = true;
    if (result.data) { state = result.data; render(); }
    return result;
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; toast(error.message); return null; }
}
function renderTasks() {
  const tasks = visibleTasks();
  $('tag-filters').innerHTML = [{name: 'すべて', value: null}, {name: 'タグなし', value: ''}, ...allTags().map(name => ({name, value: name}))].map((t, index) => '<button class="filter-chip ' + (tagFilter === t.value ? 'active' : '') + '" data-filter-index="' + index + '" aria-pressed="' + (tagFilter === t.value) + '">' + escapeHTML(t.name) + '</button>').join('');
  $('task-count').textContent = tasks.length;
  $('tasks').innerHTML = tasks.length ? tasks.map(t => `<div class="task-row ${t.id === selected ? 'selected' : ''} ${t.completed ? 'done' : ''}"><button class="task-check ${t.completed ? 'checked' : ''}" data-action="complete" data-id="${t.id}" aria-label="${t.completed ? '未完了に戻す' : 'タスクを完了'}" ${state.active?.task_id === t.id || state.suspended.some(s => s.task_id === t.id) ? 'disabled' : ''}>${t.completed ? '✓' : ''}</button><button class="task-content" data-action="select" data-id="${t.id}"><strong>${escapeHTML(t.name)}</strong>${t.memo ? `<small>${escapeHTML(t.memo)}</small>` : ''}</button><div class="row-tags">${(t.tags || []).map(tagMarkup).join('')}</div><div class="task-tools"><button data-action="edit" data-id="${t.id}" aria-label="タスクを編集" title="編集">${icon('edit')}</button><button data-action="delete" data-id="${t.id}" title="削除" aria-label="タスクを削除" ${state.active?.task_id === t.id || state.suspended.some(s => s.task_id === t.id) ? 'disabled' : ''}>${icon('trash')}</button></div></div>`).join('') : `<div class="empty"><div class="empty-symbol">${completed ? '✓' : '＋'}</div>${search || tagFilter !== null ? '該当するタスクはありません' : completed ? '完了したタスクはありません' : 'タスクを追加してください'}</div>`;
}
const eventLabels = { session_started: '作業を開始', session_paused: '一時停止', session_resumed: '作業を再開', session_suspended: '作業を中断', session_completed: '作業を終了', distraction: '寄り道の記録', app_added: 'アプリを追加', task_completed: 'タスクを完了' };
function renderHistory() {
  const seconds = state.sessions.reduce((sum, s) => sum + Math.floor(s.elapsed_ms / 1000), 0);
  $('total-time').textContent = `${Math.floor(seconds / 3600)}時間 ${Math.floor(seconds / 60) % 60}分`;
  $('total-sessions').textContent = state.sessions.length;
  $('total-tasks').textContent = state.tasks.filter(t => t.completed).length;
  $('history').innerHTML = state.events.length ? state.events.slice(-100).reverse().map(e => {
    const task = state.tasks.find(t => t.id === e.task_id)?.name || state.sessions.find(s => s.id === e.session_id)?.task_name || e.task_name || '削除済みタスク';
    const detail = [task, e.opened_app || e.app, e.reason_category, e.reason_text, e.duration_seconds != null ? duration(e.duration_seconds) : null].filter(Boolean).join(' · ');
    return `<div class="history-row"><span class="history-icon">${e.event_type === 'distraction' ? '↗' : '◷'}</span><div class="history-text"><strong>${eventLabels[e.event_type] || escapeHTML(e.event_type)}</strong><p>${escapeHTML(detail)}</p></div><time>${new Date(e.timestamp).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>`;
  }).join('') : '<div class="empty">履歴はありません</div>';
}
let taskSignature = '', historySignature = '';
function render() {
  if (!state) return;
  if (tagFilter && !allTags().includes(tagFilter)) tagFilter = null;
  if (!visibleTasks().some(t => t.id === selected && !t.completed)) selected = visibleTasks().find(t => !t.completed)?.id || null;
  const taskKey = JSON.stringify([state.tasks, selected, completed, state.active?.task_id, state.suspended, tagFilter, search]);
  if (taskKey !== taskSignature) { taskSignature = taskKey; renderTasks(); }
  const historyKey = `${state.events.length}:${state.sessions.length}:${state.tasks.map(t => t.updated_at).join()}`;
  if (historyKey !== historySignature) { historySignature = historyKey; renderHistory(); }
  $('selected-task').textContent = state.tasks.find(t => t.id === selected)?.name || 'タスクを選択';
  $('selected-tags').innerHTML = (state.tasks.find(t => t.id === selected)?.tags || []).map(tagMarkup).join('');
  $('start').disabled = !selected || state.active?.task_id === selected;
  $('setup').hidden = !!state.active && state.active.task_id === selected;
  $('start').title = state.active ? 'この作業に切り替える' : state.suspended.some(s => s.task_id === selected) ? '中断した作業を再開' : '作業を開始';
  $('start').setAttribute('aria-label', $('start').title);
  $('start').innerHTML = icon(state.active ? 'switch' : 'play');
  $('suspended-panel').hidden = !state.suspended.length;
  const suspendedMarkup = state.suspended.map(s => '<div class="suspended-row"><span>' + escapeHTML(s.task_name) + '</span><time>' + duration(Math.floor(s.elapsed_ms / 1000)) + '</time><button class="icon-button" data-resume="' + s.task_id + '" title="再開" aria-label="再開">' + icon('play') + '</button><button class="icon-button" data-finish="' + s.id + '" title="この作業を終了" aria-label="この作業を終了">' + icon('stop') + '</button></div>').join('');
  if ($('suspended-list').innerHTML !== suspendedMarkup) $('suspended-list').innerHTML = suspendedMarkup;
  $('session-panel').hidden = !state.active;
  $('focus-page').classList.toggle('has-session', !!state.active);
  if (state.active) {
    $('session-name').textContent = state.active.task_name;
    $('timer').textContent = duration(state.elapsed_seconds);
    $('pause').innerHTML = icon(state.active.status === 'running' ? 'pause' : 'play');
    $('pause').title = state.active.status === 'running' ? '一時停止' : '作業を再開';
    $('pause').setAttribute('aria-label', $('pause').title);
    $('session-status').textContent = state.active.status === 'running' ? '作業中' : '一時停止中';
    $('overlay-toggle').checked = state.settings.overlay;
  }
  $('storage-error').hidden = !state.storage_error;
  $('storage-error').textContent = state.storage_error;

}
function openTask(task = null) {
  editing = task?.id || null;
  $('task-dialog-title').textContent = task ? 'タスクを編集' : 'タスクを追加';
  $('task-name').value = task?.name || ''; $('task-memo').value = task?.memo || '';
  $('task-tags').value = (task?.tags || []).join(', ');
  $('tag-suggestions').innerHTML = allTags().map((tag, index) => `<button type="button" data-tag-index="${index}" class="filter-chip">${escapeHTML(tag)}</button>`).join('');
  $('task-dialog').showModal(); $('task-name').focus();
}
$('date').textContent = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'long' });
$('new-task').onclick = () => openTask();
$('cancel-task').onclick = () => { $('task-dialog').close(); render(); };
$('task-form').onsubmit = async event => {
  event.preventDefault();
  const result = await call(editing ? 'task:edit' : 'task:create', { id: editing, name: $('task-name').value, memo: $('task-memo').value, tags: $('task-tags').value });
  if (result) { $('task-dialog').close(); if (!editing) { selected = state.tasks[0].id; tagFilter = null; search = ''; $('task-search').value = ''; completed = false; $('open-tasks').classList.add('active'); $('done-tasks').classList.remove('active'); } render(); }
};
$('tasks').onclick = async event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const id = button.dataset.id, t = state.tasks.find(t => t.id === id);
  if (button.dataset.action === 'select') { if (!t.completed) { selected = id; render(); } }
  if (button.dataset.action === 'edit') openTask(t);
  if (button.dataset.action === 'complete') await call('task:complete', { id });
  if (button.dataset.action === 'delete' && confirm(`「${t.name}」を削除しますか？ 作業ログは残ります。`)) await call('task:delete', { id });
};
for (const [id, value] of [['open-tasks', false], ['done-tasks', true]]) $(id).onclick = () => { completed = value; $('open-tasks').classList.toggle('active', !value); $('done-tasks').classList.toggle('active', value); render(); };
$('start').onclick = () => call('session:switch', { task_id: selected });
$('suspend').onclick = () => call('session:suspend');
$('suspended-list').onclick = event => { const resume = event.target.closest('[data-resume]'), finish = event.target.closest('[data-finish]'); if (resume) call('session:switch', { task_id: resume.dataset.resume }); if (finish) call('session:end-suspended', { session_id: finish.dataset.finish }); };
$('pause').onclick = () => call(state.active.status === 'running' ? 'session:pause' : 'session:resume');
$('end').onclick = async () => { if (await call('session:end')) toast('作業を保存しました'); };
$('overlay-toggle').onchange = () => call('settings:overlay', { visible: $('overlay-toggle').checked });
$('export').onclick = async () => { const result = await call('export'); if (result && !result.canceled) toast('JSONLファイルを書き出しました。'); };
document.querySelectorAll('[data-page]').forEach(button => { button.onclick = () => {
  const history = button.dataset.page === 'history';
  $('focus-page').hidden = history; $('history-page').hidden = !history;
  $('page-title').textContent = history ? '履歴' : 'タスク';
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active', b === button));
}; });
window.focusGuard.subscribe(value => { state = value; render(); });
call('state');

$('task-search').addEventListener('input', event => { search = event.target.value; render(); });
$('tag-filters').onclick = event => { const b = event.target.closest('[data-filter-index]'); if (b) { tagFilter = [null, '', ...allTags()][Number(b.dataset.filterIndex)]; render(); } };
$('tag-suggestions').onclick = event => { const b = event.target.closest('[data-tag-index]'); if (!b) return; const values = $('task-tags').value.split(/[,、\n]+/).map(t => t.trim()).filter(Boolean); const tag = allTags()[Number(b.dataset.tagIndex)]; if (tag && !values.includes(tag)) values.push(tag); $('task-tags').value = values.join(', '); };
document.querySelectorAll('[data-window]').forEach(button => button.onclick = () => window.focusGuard.call('window:' + button.dataset.window));
