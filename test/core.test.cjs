const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/core.cjs');
function fixture(t) {
  const base = path.resolve('.test-data'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'core-'));
  let now = Date.parse('2026-09-08T10:00:00Z');
  const store = new Store(directory, () => now);
  const task = store.transaction(() => store.createTask({ name: '企画書を書く', memo: 'まず構成から' }));
  return { store, task, directory, advance: ms => { now += ms; }, clock: () => now, start: () => store.transaction(() => store.start({ task_id: task.id })) };
}
test('task CRUD persists and preserves historic event references', t => {
  const { store, task, directory } = fixture(t);
  store.transaction(() => store.editTask({ id: task.id, name: '構成を書く', memo: '3つの見出し' }));
  store.transaction(() => store.completeTask(task.id));
  assert.ok(store.task(task.id).completed_at);
  store.transaction(() => store.deleteTask(task.id));
  const reloaded = new Store(directory);
  assert.equal(reloaded.data.tasks.length, 0);
  assert.equal(reloaded.data.events[0].task_id, task.id);
});
test('pause excludes breaks and single-session restrictions are enforced', t => {
  const { store, task, advance, start } = fixture(t); start();
  assert.equal(store.active().allowed_apps, undefined);
  assert.throws(start, /すでに/);
  assert.throws(() => store.transaction(() => store.deleteTask(task.id)), /作業中/);
  advance(12500); store.transaction(() => store.pause());
  advance(90000); assert.equal(store.elapsed(), 12);
  store.transaction(() => store.resume()); advance(2500);
  store.transaction(() => store.end());
  assert.equal(store.data.sessions[0].elapsed_ms, 15000);
  assert.equal(store.data.active, null);
  assert.deepEqual(store.data.events.map(e => e.event_type), ['session_started', 'session_paused', 'session_resumed', 'session_completed']);
});
test('crash recovery pauses at last heartbeat without counting closed time', t => {
  const { store, advance, start, directory, clock } = fixture(t); start();
  advance(9000); store.transaction(() => { store.data.active.heartbeat = clock(); });
  advance(3600000);
  const recovered = new Store(directory, clock);
  assert.equal(recovered.active().status, 'paused'); assert.equal(recovered.elapsed(), 9);
  assert.equal(recovered.data.events.at(-1).action, 'recovered');
});
test('invalid input and failed save roll back all in-memory changes', t => {
  const { store } = fixture(t);
  assert.throws(() => store.transaction(() => store.createTask({ name: '  ' })));
  assert.equal(store.data.tasks.length, 1);
  const save = store.save; store.save = () => { throw Error('disk full'); };
  assert.throws(() => store.transaction(() => store.createTask({ name: 'new' })), /disk full/);
  assert.equal(store.data.tasks.length, 1); store.save = save;
});
test('corrupt local data is never silently replaced', t => {
  const { directory } = fixture(t), file = path.join(directory, 'data.json');
  fs.writeFileSync(file, '{broken'); assert.throws(() => new Store(directory));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('switch tasks preserves session IDs and counts only the foreground task time', t => {
  const { store, task, start, advance, directory, clock } = fixture(t);
  const other = store.transaction(() => store.createTask({ name: '割り込み作業' }));
  start(); const originalId = store.active().id;
  advance(10000); store.transaction(() => store.switchTask(other.id));
  assert.equal(store.data.suspended[0].id, originalId);
  assert.equal(store.data.suspended[0].elapsed_ms, 10000);
  const otherId = store.active().id;
  advance(20000); store.transaction(() => store.switchTask(task.id));
  assert.equal(store.active().id, originalId);
  assert.equal(store.elapsed(), 10);
  advance(5000); store.transaction(() => store.suspend());
  assert.equal(store.data.active, null);
  assert.equal(store.data.suspended.length, 2);
  advance(60000);
  const restored = new Store(directory, clock);
  restored.transaction(() => restored.switchTask(task.id));
  assert.equal(restored.elapsed(), 15);
  assert.equal(restored.active().id, originalId);
  assert.throws(() => restored.transaction(() => restored.deleteTask(other.id)));
  assert.throws(() => restored.transaction(() => restored.completeTask(other.id)));
  restored.transaction(() => restored.endSuspended(otherId));
  assert.equal(restored.active().id, originalId);
  assert.equal(restored.data.sessions[0].elapsed_ms, 20000);
  assert.equal(restored.data.events.at(-1).session_id, otherId);
  assert.equal(restored.data.suspended.length, 0);
});
test('invalid task switch leaves current work running and suspended task names follow edits', t => {
  const { store, start, task } = fixture(t); start();
  const id = store.active().id;
  assert.throws(() => store.transaction(() => store.switchTask('missing')));
  assert.equal(store.active().id, id);
  assert.equal(store.active().status, 'running');
  store.transaction(() => store.suspend());
  store.transaction(() => store.editTask({ id: task.id, name: '変更した名前' }));
  assert.equal(store.data.suspended[0].task_name, '変更した名前');
});
test('tags normalize, edit, clear, and persist with legacy tasks supported', t => {
  const { store, task, directory } = fixture(t);
  store.transaction(() => store.editTask({ id: task.id, name: task.name, tags: '仕事, 企画、仕事' }));
  assert.deepEqual(new Store(directory).task(task.id).tags, ['仕事', '企画']);
  assert.throws(() => store.transaction(() => store.editTask({ id: task.id, name: task.name, tags: 'x'.repeat(25) })));
  assert.deepEqual(store.task(task.id).tags, ['仕事', '企画']);
  store.transaction(() => store.editTask({ id: task.id, name: task.name, tags: '' }));
  assert.deepEqual(store.task(task.id).tags, []);
});
test('upgrade preserves old logs and settles a pending detection without requiring apps', t => {
  const { store, start, directory, clock, advance } = fixture(t); start();
  advance(5000);
  store.transaction(() => {
    store.data.active.heartbeat = clock();
    store.data.active.allowed_apps = ['chrome'];
    store.data.pending = { opened_app: 'powershell', timestamp: store.iso(clock() - 3000), started_ms: clock() - 3000, ended_ms: null };
  });
  const recovered = new Store(directory, clock);
  assert.equal(recovered.data.pending, null);
  assert.equal(recovered.data.events.find(e => e.action === 'monitoring_removed').duration_seconds, 3);
  assert.equal(recovered.active().status, 'paused');
  recovered.transaction(() => recovered.end());
  recovered.transaction(() => recovered.start({ task_id: store.data.tasks[0].id }));
  assert.equal(recovered.active().allowed_apps, undefined);
});
