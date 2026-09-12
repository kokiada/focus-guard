const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function required(value, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw Error(`1〜${max}文字で入力してください。`);
  return value.trim();
}
const TAG_COLORS = ['#5b8def','#d978a8','#e3a23b','#58a889','#936bd6','#db6f5f','#4f9ca8','#8d9b68'];
function links(value = []) { if (!Array.isArray(value)) return []; return value.map(x => ({id:x.id || randomUUID(), title:String(x.title||'').trim().slice(0,100), url:String(x.url||'').trim()})).filter(x=>x.url).map(x=>{ let u; try {u=new URL(x.url)} catch {throw Error('リンクURLが正しくありません。')} if(!['http:','https:'].includes(u.protocol)) throw Error('リンクはhttpまたはhttpsで入力してください。'); return x; }); }
function tags(value = []) {
  const values = Array.isArray(value) ? value : String(value).split(/[,、\n]+/);
  const result = [...new Set(values.map(v => String(v).trim()).filter(Boolean))];
  if (result.length > 10 || result.some(v => v.length > 24)) throw Error('タグは10個まで、1個24文字以内で入力してください。');
  return result;
}

class Store {
  constructor(directory, clock = () => Date.now()) {
    this.clock = clock;
    this.file = path.join(directory, 'data.json');
    fs.mkdirSync(directory, { recursive: true });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, tasks: [], sessions: [], events: [], active: null, pending: null, settings: { overlay: true } };
    if (this.data.version !== 1 || !Array.isArray(this.data.tasks) || !Array.isArray(this.data.events)) throw Error('保存データの形式を読み取れません。');
    this.data.suspended ??= []; this.data.quick_notes ??= []; this.data.tags ??= {}; for (const t of this.data.tasks) { t.tags ??= []; t.links ??= []; t.priority ??= {important:false,urgent:false}; t.first_step ??= ''; t.next_action ??= 'later'; }
    // Retain old logs, but settle any pending detection once when upgrading.
    if (this.data.pending) this.transaction(() => this.finishDistraction({ action: 'monitoring_removed' }, this.data.active?.heartbeat || this.clock()));
    if (this.data.active?.status === 'running') {
      // A crash never counts the time during which the application was closed.
      this.transaction(() => this.pause('recovered', this.data.active.heartbeat || this.clock()));
    }
  }
  iso(at = this.clock()) { return new Date(at).toISOString(); }
  save() {
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
  transaction(fn) {
    const previous = structuredClone(this.data);
    try { const result = fn(); this.save(); return result; } catch (error) { this.data = previous; throw error; }
  }
  event(type, details = {}, at = this.clock()) {
    const s = this.data.active;
    this.data.events.push({ event_id: randomUUID(), event_type: type, timestamp: this.iso(at), session_id: s?.id || null, task_id: s?.task_id || null, ...details });
  }
  elapsed(s = this.data.active, at = this.clock()) {
    return s ? Math.max(0, Math.floor((s.elapsed_ms + (s.status === 'running' ? Math.max(0, at - s.running_since) : 0)) / 1000)) : 0;
  }
  view() { return { ...structuredClone(this.data), elapsed_seconds: this.elapsed() }; }
  task(id) { const t = this.data.tasks.find(t => t.id === id); if (!t) throw Error('タスクが見つかりません。'); return t; }
  active() { if (!this.data.active) throw Error('作業は開始されていません。'); return this.data.active; }
  createTask(input) {
    const t = { id: randomUUID(), name: required(input.name), memo: String(input.memo || '').slice(0, 4000), completed: false, created_at: this.iso(), updated_at: this.iso(), completed_at: null };
    t.tags = tags(input.tags); t.links = links(input.links); t.priority={important:Boolean(input.important),urgent:Boolean(input.urgent)}; t.first_step=String(input.first_step||'').trim().slice(0,500); t.next_action=['now','next','later'].includes(input.next_action)?input.next_action:'later'; t.tags.forEach((n,i)=>{this.data.tags[n]??=TAG_COLORS[i%TAG_COLORS.length]});
    this.data.tasks.unshift(t); return t;
  }
  editTask(input) {
    const t = this.task(input.id);
    t.tags = tags(input.tags ?? t.tags); t.links=links(input.links ?? t.links); t.priority={important:Boolean(input.important ?? t.priority?.important),urgent:Boolean(input.urgent ?? t.priority?.urgent)}; t.first_step=String(input.first_step ?? t.first_step ?? '').trim().slice(0,500); t.next_action=['now','next','later'].includes(input.next_action)?input.next_action:(t.next_action||'later'); t.tags.forEach((n,i)=>{this.data.tags[n]??=TAG_COLORS[i%TAG_COLORS.length]});
    t.name = required(input.name); t.memo = String(input.memo || '').slice(0, 4000); t.updated_at = this.iso();
    if (this.data.active?.task_id === t.id) this.data.active.task_name = t.name;
    for (const s of this.data.suspended) if (s.task_id === t.id) s.task_name = t.name;
  }
  completeTask(id) {
    const t = this.task(id);
    if (this.data.active?.task_id === id || this.data.suspended.some(s => s.task_id === id)) throw Error('作業を終了してからタスクを完了してください。');
    t.completed = !t.completed; t.completed_at = t.completed ? this.iso() : null; t.updated_at = this.iso();
    if (t.completed) this.event('task_completed', { task_id: id, task_name: t.name });
  }
  deleteTask(id) {
    this.task(id);
    if (this.data.active?.task_id === id || this.data.suspended.some(s => s.task_id === id)) throw Error('作業中・中断中のタスクは削除できません。');
    this.data.tasks = this.data.tasks.filter(t => t.id !== id);
  }
  start(input) {
    if (this.data.active) throw Error('すでに作業中です。');
    if (this.data.suspended.some(s => s.task_id === input.task_id)) throw Error('中断中の作業を再開してください。');
    const t = this.task(input.task_id);
    if (t.completed) throw Error('未完了のタスクを選んでください。');
    this.data.active = { id: randomUUID(), task_id: t.id, task_name: t.name, first_step:t.first_step||'', status: 'running', started_at: this.iso(), ended_at: null, elapsed_ms: 0, running_since: this.clock(), heartbeat: this.clock() };
    this.event('session_started', { task_name: t.name });
  }
  suspend(action = 'user') {
    const s = this.active();
    this.pause(action);
    this.event('session_suspended', { action, duration_seconds: this.elapsed() });
    this.data.suspended.unshift(s);
    this.data.active = null;
  }
  switchTask(taskId) {
    const task = this.task(taskId);
    if (task.completed) throw Error('未完了のタスクを選んでください。');
    if (this.data.active?.task_id === taskId) { this.resume(); return; }
    if (this.data.active) this.suspend('task_switched');
    const index = this.data.suspended.findIndex(s => s.task_id === taskId);
    if (index >= 0) {
      this.data.active = this.data.suspended.splice(index, 1)[0];
      this.resume();
    } else this.start({ task_id: taskId });
  }
  endSuspended(sessionId) {
    const index = this.data.suspended.findIndex(s => s.id === sessionId);
    if (index < 0) throw Error('中断中の作業が見つかりません。');
    const current = this.data.active;
    this.data.active = this.data.suspended.splice(index, 1)[0];
    this.end('suspended_ended');
    this.data.active = current;
  }
  finishDistraction(input = {}, at = this.clock()) {
    const p = this.data.pending;
    if (!p) return;
    this.event('distraction', { timestamp: p.timestamp, opened_app: p.opened_app, reason_category: String(input.reason_category || '未記入').slice(0, 100), reason_text: String(input.reason_text || '').slice(0, 4000), duration_seconds: Math.max(0, Math.floor(((p.ended_ms ?? at) - p.started_ms) / 1000)), action: input.action || 'recorded' });
    this.data.pending = null;
  }
  pause(action = 'user', at = this.clock()) {
    const s = this.active(); if (s.status !== 'running') return;
    this.finishDistraction({ action: 'paused' }, at);
    s.elapsed_ms += Math.max(0, at - s.running_since); s.running_since = null; s.status = 'paused'; s.heartbeat = at;
    this.event('session_paused', { action, duration_seconds: this.elapsed(s, at) }, at);
  }
  resume() {
    const s = this.active(); if (s.status !== 'paused') return;
    s.status = 'running'; s.running_since = this.clock(); s.heartbeat = this.clock();
    this.event('session_resumed');
  }
  end(action = 'user') {
    const s = this.active(); this.finishDistraction({ action: 'session_ended' });
    const duration = this.elapsed();
    s.elapsed_ms = duration * 1000; s.running_since = null; s.status = 'completed'; s.ended_at = this.iso();
    this.event('session_completed', { duration_seconds: duration, action });
    this.data.sessions.unshift(s); this.data.active = null;
  }
  setPriority(id,important,urgent){const t=this.task(id);t.priority={important:Boolean(important),urgent:Boolean(urgent)};t.updated_at=this.iso();}
  setNextAction(id,v){const t=this.task(id);if(!['now','next','later'].includes(v))throw Error('着手区分が不正です。');if(v==='now'&&this.data.tasks.some(x=>x.next_action==='now'&&x.id!==id))throw Error('「今やる」は1件だけ選べます。');if(v==='next'&&this.data.tasks.filter(x=>x.next_action==='next'&&x.id!==id).length>=3)throw Error('「次にやる」は3件までです。');t.next_action=v;t.updated_at=this.iso();}
  addQuickNote(text){const n={id:randomUUID(),text:required(text,500),created_at:this.iso(),status:'inbox'};this.data.quick_notes.unshift(n);this.event('quick_note_added',{note_id:n.id});return n;}
  updateQuickNote(id,a){const n=this.data.quick_notes.find(x=>x.id===id);if(!n)throw Error('クイックメモが見つかりません。');if(a==='delete')this.data.quick_notes=this.data.quick_notes.filter(x=>x.id!==id);else if(['inbox','later'].includes(a))n.status=a;else throw Error('操作が不正です。');}
  exportJSONL() { return this.data.events.map(e => JSON.stringify(e)).join('\n') + (this.data.events.length ? '\n' : ''); }
}
module.exports = { Store };

