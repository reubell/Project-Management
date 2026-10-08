'use strict';

// ---------- Storage (IndexedDB: works offline, handles large files) ----------
//
// Records are never removed outright: deleting sets `deleted: true` so the
// deletion can sync to other devices. Every change stamps `updated`, and when
// two devices disagree the newer stamp wins.

const DB_NAME = 'project-tasks';
const DB_VERSION = 2;
const RECORD_STORES = ['projects', 'tasks', 'files'];
let db;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = req.result;
      const t = req.transaction;
      if (e.oldVersion < 1) RECORD_STORES.forEach(s => d.createObjectStore(s, { keyPath: 'id' }));
      if (e.oldVersion < 2) {
        // v1 kept file contents inside the file records and had no `updated` stamps.
        d.createObjectStore('blobs', { keyPath: 'id' });
        for (const s of RECORD_STORES) {
          t.objectStore(s).openCursor().onsuccess = ev => {
            const c = ev.target.result;
            if (!c) return;
            const r = c.value;
            r.updated = r.updated || r.created || r.added || Date.now();
            if (r.blob) {
              t.objectStore('blobs').put({ id: r.id, blob: r.blob });
              delete r.blob;
            }
            c.update(r);
            c.continue();
          };
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = fn(t);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function request(store, method, ...args) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store)[method](...args);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Stamp and store records in one transaction, then let sync know.
async function save(entries, { sync = true } = {}) {
  const now = Date.now();
  await tx(RECORD_STORES, 'readwrite', t => {
    for (const [store, rec] of entries) {
      rec.updated = now;
      t.objectStore(store).put(rec);
    }
  });
  if (sync) scheduleSync();
}

async function getBlob(id) {
  return (await request('blobs', 'get', id))?.blob || null;
}

async function putBlob(id, blob) {
  await tx('blobs', 'readwrite', t => t.objectStore('blobs').put({ id, blob }));
  state.localBlobs.add(id);
}

async function deleteBlobs(ids) {
  if (!ids.length) return;
  await tx('blobs', 'readwrite', t => ids.forEach(id => t.objectStore('blobs').delete(id)));
  ids.forEach(id => state.localBlobs.delete(id));
}

// ---------- State ----------

const state = {
  projects: [],
  tasks: [],
  files: [],
  localBlobs: new Set(),
  downloading: new Set(),
  currentId: 'all', // the app always opens on All tasks
  expanded: new Set(),  // tasks opened inline (phones, narrow windows)
  selectedId: null,     // task shown in the side panel (wide screens)
  showCompleted: localStorage.getItem('showCompleted') === '1',
  dueFilter: localStorage.getItem('dueFilter') || '',
};

const ALL = 'all';
const wide = matchMedia('(min-width: 1100px)');
const isAll = () => state.currentId === ALL;
const live = r => !r.deleted;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const $ = sel => document.querySelector(sel);

function currentProject() {
  return state.projects.find(p => p.id === state.currentId && live(p));
}

function setCurrent(id) {
  state.currentId = id;
  state.expanded.clear();
  state.selectedId = null;
  setSidebar(false);
  render();
}

// On phones the sidebar slides over the page; tapping outside it closes it.
function setSidebar(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#scrim').hidden = !open;
}

// ---------- Due dates (stored as local 'YYYY-MM-DD', or null for none) ----------

function dayStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dueLabel(due) {
  const date = parseDay(due);
  const diff = Math.round((date - parseDay(dayStr())) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return date.toLocaleDateString([], { weekday: 'long' });
  const opts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString([], opts);
}

function matchesDueFilter(t) {
  const today = dayStr();
  switch (state.dueFilter) {
    case 'overdue': return !!t.due && t.due < today;
    case 'today': return !!t.due && t.due <= today;
    case 'week': return !!t.due && t.due <= dayStr(7);
    case 'dated': return !!t.due;
    case 'none': return !t.due;
    default: return true;
  }
}

// Dated tasks first, soonest at the top; then undated tasks, oldest first.
function byDue(a, b) {
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (!!a.due !== !!b.due) return a.due ? -1 : 1;
  return a.created - b.created;
}

// ---------- Projects ----------

async function addProject(name) {
  const p = { id: uid(), name, created: Date.now() };
  state.projects.push(p);
  setCurrent(p.id);
  await save([['projects', p]]);
}

async function renameProject(p) {
  const name = prompt('Project name', p.name);
  if (!name || !name.trim()) return;
  p.name = name.trim();
  await save([['projects', p]]);
  render();
}

async function deleteProject(p) {
  const tasks = state.tasks.filter(t => t.projectId === p.id && live(t));
  if (!confirm(`Delete "${p.name}" and its ${tasks.length} task(s)? This cannot be undone.`)) return;
  const taskIds = new Set(tasks.map(t => t.id));
  const files = state.files.filter(f => taskIds.has(f.taskId) && live(f));
  [p, ...tasks, ...files].forEach(r => { r.deleted = true; });
  await save([['projects', p], ...tasks.map(t => ['tasks', t]), ...files.map(f => ['files', f])]);
  await deleteBlobs(files.map(f => f.id));
  setCurrent(ALL);
}

// ---------- Tasks ----------

async function addTask(title) {
  const projectId = isAll() ? $('#newTaskProject').value : state.currentId;
  if (!projectId) return;
  const t = { id: uid(), projectId, title, notes: '', done: false, due: null, created: Date.now() };
  state.tasks.push(t);
  render();
  await save([['tasks', t]]);
}

async function toggleTask(t) {
  t.done = !t.done;
  t.completedAt = t.done ? Date.now() : null;
  render();
  await save([['tasks', t]]);
}

function saveTask(t) {
  return save([['tasks', t]]);
}

async function deleteTask(t) {
  const files = state.files.filter(f => f.taskId === t.id && live(f));
  const label = files.length ? ` and its ${files.length} file(s)` : '';
  if (!confirm(`Delete "${t.title}"${label}?`)) return;
  [t, ...files].forEach(r => { r.deleted = true; });
  state.expanded.delete(t.id);
  if (state.selectedId === t.id) state.selectedId = null;
  render();
  await save([['tasks', t], ...files.map(f => ['files', f])]);
  await deleteBlobs(files.map(f => f.id));
}

async function moveTask(taskId, projectId) {
  const t = state.tasks.find(x => x.id === taskId);
  if (!t || t.projectId === projectId) return;
  t.projectId = projectId;
  render();
  await save([['tasks', t]]);
}

// ---------- Files ----------

async function attachFiles(task, fileList) {
  const added = [];
  for (const file of fileList) {
    const f = { id: uid(), taskId: task.id, name: file.name, type: file.type, size: file.size, added: Date.now() };
    await putBlob(f.id, file);
    state.files.push(f);
    added.push(['files', f]);
  }
  if (wide.matches) state.selectedId = task.id;
  else state.expanded.add(task.id);
  render();
  await save(added);
}

async function removeFile(f) {
  if (!confirm(`Remove "${f.name}"?`)) return;
  f.deleted = true;
  render();
  await save([['files', f]]);
  await deleteBlobs([f.id]);
}

// The file's contents: from this device, or downloaded from Drive and kept.
async function fileBlob(f) {
  const local = await getBlob(f.id);
  if (local) return local;
  if (!f.driveId) throw new Error('This file has not finished uploading from the device it was added on.');
  if (!Drive.tokenValid()) throw new Error('Reconnect Google Drive to open this file.');
  state.downloading.add(f.id);
  requestRender();
  try {
    const blob = await Drive.download(f.driveId);
    await putBlob(f.id, blob);
    return blob;
  } finally {
    state.downloading.delete(f.id);
    requestRender();
  }
}

async function openFile(f) {
  // Types the browser can preview open in a tab; anything else downloads.
  // The tab is opened right away so popup blockers allow it.
  const preview = /^(image\/|application\/pdf|text\/|video\/|audio\/)/.test(f.type);
  const win = preview ? window.open('', '_blank') : null;
  try {
    const url = URL.createObjectURL(await fileBlob(f));
    if (win) {
      win.location.href = url;
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    win?.close();
    alert(err.message);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
const TASK_MIME = 'application/x-task-id';

// ---------- Google Drive sync ----------

const sync = {
  status: Drive.enabled ? 'idle' : 'off',
  detail: '',
  last: Number(localStorage.getItem('lastSync')) || 0,
  running: false,
  again: false,
  timer: null,
};

function scheduleSync(delay = 1500) {
  if (!Drive.enabled) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(runSync, delay);
}

function setSync(status, detail = '') {
  sync.status = status;
  sync.detail = detail;
  renderSync();
}

async function runSync() {
  if (!Drive.enabled) return;
  if (sync.running) { sync.again = true; return; }
  if (!Drive.isConnected()) return setSync('disconnected');
  if (!Drive.tokenValid()) return setSync('reconnect');
  if (!navigator.onLine) return setSync('offline');

  sync.running = true;
  setSync('syncing');
  try {
    await Drive.ensureAccount();
    await Drive.ensureFolders();
    await uploadPendingFiles();
    await trashDeletedFiles();
    const remoteText = await Drive.readData();
    if (remoteText) await mergeRemote(JSON.parse(remoteText));
    const text = JSON.stringify(syncPayload());
    if (text !== remoteText) await Drive.writeData(text);
    sync.last = Date.now();
    localStorage.setItem('lastSync', sync.last);
    setSync('synced');
  } catch (err) {
    console.error(err);
    if (err instanceof Drive.AuthError) setSync('reconnect');
    else if (!navigator.onLine) setSync('offline');
    else setSync('error', err.message);
  } finally {
    sync.running = false;
    if (sync.again) { sync.again = false; scheduleSync(300); }
  }
}

async function uploadPendingFiles() {
  for (const f of state.files) {
    if (!live(f) || f.driveId || !state.localBlobs.has(f.id)) continue;
    const blob = await getBlob(f.id);
    if (!blob) continue;
    f.driveId = await Drive.uploadFile(blob, f.name, f.id);
    await save([['files', f]], { sync: false });
    requestRender();
  }
}

async function trashDeletedFiles() {
  for (const f of state.files) {
    if (live(f) || !f.driveId || f.trashed) continue;
    await Drive.trash(f.driveId);
    f.trashed = true;
    await save([['files', f]], { sync: false });
  }
}

// Take whichever copy of each record was changed most recently.
async function mergeRemote(remote) {
  const changed = [];
  for (const store of RECORD_STORES) {
    const local = new Map(state[store].map(r => [r.id, r]));
    for (const r of remote[store] || []) {
      const mine = local.get(r.id);
      if (mine && mine.updated >= r.updated) continue;
      if (mine) {
        Object.keys(mine).forEach(k => { if (!(k in r)) delete mine[k]; });
        Object.assign(mine, r);
      } else {
        state[store].push(r);
      }
      changed.push([store, mine || r]);
    }
  }
  if (!changed.length) return;
  await tx(RECORD_STORES, 'readwrite', t => changed.forEach(([s, r]) => t.objectStore(s).put(r)));
  await deleteBlobs(changed.filter(([s, r]) => s === 'files' && r.deleted && state.localBlobs.has(r.id)).map(([, r]) => r.id));
  requestRender();
}

function syncPayload() {
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  return {
    app: 'project-tasks',
    version: 2,
    projects: [...state.projects].sort(byId),
    tasks: [...state.tasks].sort(byId),
    files: [...state.files].sort(byId),
  };
}

function pendingUploads() {
  return state.files.filter(f => live(f) && !f.driveId && state.localBlobs.has(f.id)).length;
}

function renderSync() {
  const el = $('#syncStatus');
  const banner = $('#syncBanner');
  el.hidden = sync.status === 'off';
  banner.hidden = true;
  if (sync.status === 'off') return;

  const time = sync.last ? new Date(sync.last).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const waiting = pendingUploads();
  const text = {
    idle: 'Google Drive',
    disconnected: 'Not syncing',
    reconnect: 'Sync paused: sign in again',
    offline: 'Offline. Will sync when back online',
    syncing: 'Syncing…',
    synced: `Synced ${time}` + (waiting ? ` · ${waiting} file(s) to upload` : ''),
    error: 'Sync problem: tap to retry',
  }[sync.status];
  el.querySelector('.label').textContent = text;
  el.dataset.status = sync.status;
  el.title = [Drive.email(), sync.detail].filter(Boolean).join('\n');

  const msg = {
    disconnected: ['Connect Google Drive to back up your tasks and files and see them on all your devices.', 'Connect Google Drive'],
    reconnect: ['Your Google sign-in expired. Changes are safe on this device and will sync after you reconnect.', 'Reconnect'],
    error: [`Couldn't sync with Google Drive: ${sync.detail}`, 'Try again'],
  }[sync.status];
  if (msg) {
    banner.hidden = false;
    banner.querySelector('.text').textContent = msg[0];
    banner.querySelector('button').textContent = msg[1];
  }
}

function syncAction() {
  if (sync.status === 'disconnected' || sync.status === 'reconnect') Drive.authorize(false);
  else runSync();
}

// ---------- Rendering ----------

// Re-rendering replaces the task details, so wait while the user is typing there.
let renderPending = false;
// The side panel stays put while the list around it updates.
function requestRender() {
  if (document.activeElement?.matches?.('.task-title')) { renderPending = true; return; }
  const typingIn = document.activeElement?.closest?.('.task-details');
  if (!typingIn) return render();
  if (typingIn.closest('#detailPanel')) {
    renderProjects();
    renderTasks();
    renderSync();
  } else {
    renderPending = true;
  }
}

function render() {
  renderPending = false;
  if (!isAll() && !currentProject()) state.currentId = ALL;
  renderProjects();
  renderTasks();
  renderPanel();
  renderSync();
}

function renderProjects() {
  const projectIds = new Set(state.projects.filter(live).map(p => p.id));
  const allOpen = state.tasks.filter(t => live(t) && !t.done && projectIds.has(t.projectId)).length;
  const allNav = $('#allNav');
  allNav.className = isAll() ? 'active' : '';
  allNav.querySelector('.count').textContent = allOpen || '';

  const list = $('#projectList');
  list.innerHTML = '';
  for (const p of state.projects.filter(live).sort((a, b) => a.created - b.created)) {
    const open = state.tasks.filter(t => t.projectId === p.id && live(t) && !t.done).length;
    const li = document.createElement('li');
    li.className = p.id === state.currentId ? 'active' : '';
    li.innerHTML = '<span class="dot"></span><span class="name"></span><span class="count"></span>';
    li.querySelector('.name').textContent = p.name;
    li.querySelector('.count').textContent = open || '';
    li.onclick = () => setCurrent(p.id);

    // Drop a task onto a project to move it there.
    li.ondragover = e => {
      if (![...e.dataTransfer.types].includes(TASK_MIME)) return;
      e.preventDefault();
      li.classList.add('drop-target');
    };
    li.ondragleave = () => li.classList.remove('drop-target');
    li.ondrop = e => {
      li.classList.remove('drop-target');
      const id = e.dataTransfer.getData(TASK_MIME);
      if (id) { e.preventDefault(); moveTask(id, p.id); }
    };
    list.appendChild(li);
  }
}

function renderTasks() {
  const all = isAll();
  const p = currentProject();
  const projects = state.projects.filter(live).sort((a, b) => a.created - b.created);
  const projectIds = new Set(projects.map(x => x.id));
  const title = all ? 'All tasks' : p.name;

  $('#emptyState').hidden = projects.length > 0;
  $('#projectView').hidden = projects.length === 0;
  $('#projectTitle').textContent = title;
  $('#projectTitle').title = all ? '' : 'Double-click to rename';
  $('#projectMenuBtn').hidden = all;
  $('#dueFilter').value = state.dueFilter;
  $('#dueFilter').classList.toggle('active', !!state.dueFilter);
  document.title = `${title} · Project Tasks`;
  if (!projects.length) return;

  // In All tasks, new tasks need a project picked.
  const picker = $('#newTaskProject');
  picker.hidden = !all;
  if (all) {
    const chosen = picker.value || localStorage.getItem('newTaskProject');
    picker.innerHTML = '';
    projects.forEach(x => picker.add(new Option(x.name, x.id)));
    picker.value = projectIds.has(chosen) ? chosen : projects[0].id;
  }

  const tasks = state.tasks.filter(t => live(t) && (all ? projectIds.has(t.projectId) : t.projectId === p.id) && matchesDueFilter(t));
  const open = tasks.filter(t => !t.done).sort(byDue);
  const done = tasks.filter(t => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  fillList($('#openList'), open);
  fillList($('#completedList'), done);
  $('#openEmpty').hidden = open.length > 0;
  $('#openEmpty').textContent = state.dueFilter ? 'No open tasks match this due date filter.' : 'No open tasks. Nice work.';
  $('#completedCount').textContent = done.length;
  $('#completedToggle').hidden = done.length === 0;
  $('#completedToggle').setAttribute('aria-expanded', state.showCompleted);
  $('#completedList').hidden = !state.showCompleted;
}

function renderPanel() {
  const panel = $('#detailPanel');
  panel.hidden = !wide.matches;
  panel.innerHTML = '';
  if (!wide.matches) return;

  const t = state.tasks.find(x => x.id === state.selectedId && live(x));
  if (!t) {
    panel.innerHTML = '<p class="panel-empty">Click a task to see its notes, due date and files.</p>';
    return;
  }

  const head = document.createElement('div');
  head.className = 'panel-head';
  head.innerHTML = '<button type="button" class="link-btn project-link"></button><button type="button" class="icon-btn close" aria-label="Close">×</button>';
  const projectLink = head.querySelector('.project-link');
  projectLink.textContent = state.projects.find(x => x.id === t.projectId)?.name || '';
  projectLink.onclick = () => { const id = t.id; setCurrent(t.projectId); state.selectedId = id; render(); };
  head.querySelector('.close').onclick = () => { state.selectedId = null; render(); };
  panel.append(head, detailsEl(t));
  acceptFileDrops(panel, t);
}

function fillList(ul, tasks) {
  ul.innerHTML = '';
  tasks.forEach(t => ul.appendChild(taskEl(t)));
}

function taskEl(t) {
  const li = $('#taskTemplate').content.firstElementChild.cloneNode(true);
  const files = filesOf(t);
  const open = wide.matches ? state.selectedId === t.id : state.expanded.has(t.id);

  li.dataset.id = t.id;
  li.classList.toggle('done', !!t.done);
  li.classList.toggle('selected', open && wide.matches);
  const titleEl = li.querySelector('.task-title');
  titleEl.textContent = t.title;
  titleEl.title = 'Click to rename';
  titleEl.onclick = e => {
    e.stopPropagation();
    if (titleEl.isContentEditable) return;
    if (wide.matches) state.selectedId = t.id;
    else state.expanded.add(t.id);
    render();
    const fresh = document.querySelector(`.task[data-id="${t.id}"] .task-title`);
    if (fresh) editTitle(fresh, t, e.clientX, e.clientY);
  };
  const badge = li.querySelector('.file-badge');
  badge.hidden = files.length === 0 && !t.notes;
  badge.textContent = [t.notes ? '✎' : '', files.length ? `📎 ${files.length}` : ''].filter(Boolean).join('  ');

  const due = li.querySelector('.due');
  if (t.due) {
    due.hidden = false;
    due.textContent = dueLabel(t.due);
    due.title = parseDay(t.due).toLocaleDateString([], { dateStyle: 'full' });
    if (!t.done) due.classList.toggle('overdue', t.due < dayStr());
    if (!t.done) due.classList.toggle('today', t.due === dayStr());
  }

  if (isAll()) {
    const tag = li.querySelector('.project-tag');
    tag.hidden = false;
    tag.textContent = state.projects.find(x => x.id === t.projectId)?.name || '';
    tag.title = 'Open project';
    tag.onclick = e => { e.stopPropagation(); setCurrent(t.projectId); };
  }

  li.querySelector('.check').onclick = e => { e.stopPropagation(); toggleTask(t); };
  li.querySelector('.task-row').onclick = () => {
    if (wide.matches) state.selectedId = state.selectedId === t.id ? null : t.id;
    else state.expanded.has(t.id) ? state.expanded.delete(t.id) : state.expanded.add(t.id);
    render();
  };

  // Drag the row onto a project in the sidebar to move it.
  const row = li.querySelector('.task-row');
  row.draggable = true;
  row.ondragstart = e => {
    e.dataTransfer.setData(TASK_MIME, t.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  acceptFileDrops(li, t);
  if (open && !wide.matches) li.appendChild(detailsEl(t));
  return li;
}

// Rename a task right on its row. Enter or clicking away saves; Escape cancels.
function editTitle(el, t, x, y) {
  const row = el.closest('.task-row');
  row.draggable = false;
  try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
  el.focus();
  const sel = getSelection();
  const range = document.caretRangeFromPoint?.(x, y);
  if (range && el.contains(range.startContainer)) {
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    sel.selectAllChildren(el);
    sel.collapseToEnd();
  }

  let cancelled = false;
  el.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { e.stopPropagation(); cancelled = true; el.blur(); }
  };
  el.onblur = () => {
    el.removeAttribute('contenteditable');
    row.draggable = true;
    const v = el.textContent.replace(/\s+/g, ' ').trim();
    if (!cancelled && v && v !== t.title) {
      t.title = v;
      saveTask(t);
    }
    el.textContent = t.title;
    requestRender();
  };
}

function filesOf(t) {
  return state.files.filter(f => f.taskId === t.id && live(f)).sort((a, b) => a.added - b.added);
}

// Files dropped anywhere on the element attach to the task.
function acceptFileDrops(el, t) {
  let depth = 0;
  el.ondragenter = e => { if (hasFiles(e)) { depth++; el.classList.add('drop-target'); } };
  el.ondragleave = e => { if (hasFiles(e) && --depth <= 0) { depth = 0; el.classList.remove('drop-target'); } };
  el.ondragover = e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
  el.ondrop = e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    el.classList.remove('drop-target');
    if (e.dataTransfer.files.length) attachFiles(t, e.dataTransfer.files);
  };
}

// Title, due date, notes, files and delete: shown under the task or in the side panel.
function detailsEl(t) {
  const el = $('#detailsTemplate').content.firstElementChild.cloneNode(true);

  const title = el.querySelector('.edit-title');
  title.value = t.title;
  title.onchange = () => {
    const v = title.value.trim();
    if (!v) { title.value = t.title; return; }
    t.title = v;
    saveTask(t);
    requestRender();
  };
  title.onkeydown = e => { if (e.key === 'Enter') title.blur(); };

  const dueInput = el.querySelector('.edit-due');
  const clearDue = el.querySelector('.clear-due');
  dueInput.value = t.due || '';
  clearDue.hidden = !t.due;
  dueInput.onchange = () => {
    t.due = dueInput.value || null;
    clearDue.hidden = !t.due;
    saveTask(t);
    requestRender();
  };
  clearDue.onclick = () => {
    t.due = null;
    saveTask(t);
    render();
  };

  const notes = el.querySelector('.edit-notes');
  notes.value = t.notes || '';
  notes.oninput = () => { t.notes = notes.value; saveTask(t); };

  const fileList = el.querySelector('.files');
  for (const f of filesOf(t)) {
    const item = document.createElement('li');
    item.innerHTML = '<a href="#"></a><span class="size"></span><button type="button" class="remove" aria-label="Remove file">×</button>';
    const link = item.querySelector('a');
    link.textContent = f.name;
    link.title = f.name;
    link.onclick = e => { e.preventDefault(); openFile(f); };
    let note = formatSize(f.size);
    if (state.downloading.has(f.id)) note = 'downloading…';
    else if (Drive.enabled && !f.driveId) note += ' · not backed up yet';
    item.querySelector('.size').textContent = note;
    item.querySelector('.remove').onclick = () => removeFile(f);
    fileList.appendChild(item);
  }

  const input = el.querySelector('.attach-input');
  el.querySelector('.attach-btn').onclick = () => input.click();
  input.onchange = () => { if (input.files.length) attachFiles(t, input.files); };

  el.querySelector('.delete-task').onclick = () => deleteTask(t);
  return el;
}

// ---------- Backup / restore (a file you keep yourself) ----------

function blobToDataUrl(blob) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

async function exportBackup() {
  const files = await Promise.all(state.files.filter(live).map(async f => {
    const blob = await getBlob(f.id);
    return { ...f, blob: blob ? await blobToDataUrl(blob) : null };
  }));
  const data = { app: 'project-tasks', version: 2, exported: new Date().toISOString(),
    projects: state.projects.filter(live), tasks: state.tasks.filter(live), files };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `project-tasks-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.app !== 'project-tasks') throw new Error();
  } catch {
    alert('That file is not a Project Tasks backup.');
    return;
  }
  if (!confirm('Restore everything in this backup? Anything that is both here and in the backup is replaced by the backup copy.')) return;
  const blobs = [];
  for (const f of data.files) {
    if (f.blob) blobs.push([f.id, await (await fetch(f.blob)).blob()]);
    delete f.blob;
  }
  for (const [id, blob] of blobs) await putBlob(id, blob);
  await save([
    ...data.projects.map(r => ['projects', r]),
    ...data.tasks.map(r => ['tasks', r]),
    ...data.files.map(r => ['files', r]),
  ]);
  await load();
  setCurrent(ALL);
}

// ---------- Wiring ----------

async function load() {
  const all = await Promise.all([...RECORD_STORES.map(s => request(s, 'getAll')), request('blobs', 'getAllKeys')]);
  [state.projects, state.tasks, state.files] = all;
  state.localBlobs = new Set(all[3]);
}

function wire() {
  $('#addProjectForm').onsubmit = e => {
    e.preventDefault();
    const input = $('#newProjectName');
    const name = input.value.trim();
    if (name) addProject(name);
    input.value = '';
  };

  $('#addTaskForm').onsubmit = e => {
    e.preventDefault();
    const input = $('#newTaskTitle');
    const title = input.value.trim();
    if (title) addTask(title);
    input.value = '';
  };

  $('#completedToggle').onclick = () => {
    state.showCompleted = !state.showCompleted;
    localStorage.setItem('showCompleted', state.showCompleted ? '1' : '0');
    render();
  };

  const menu = $('#projectMenu');
  $('#projectMenuBtn').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.onclick = e => {
    const action = e.target.dataset.action;
    const p = currentProject();
    if (!p) return;
    if (action === 'rename') renameProject(p);
    if (action === 'delete') deleteProject(p);
  };
  $('#projectTitle').ondblclick = () => currentProject() && renameProject(currentProject());

  $('#allNav').onclick = () => setCurrent(ALL);
  $('#newTaskProject').onchange = e => localStorage.setItem('newTaskProject', e.target.value);
  $('#dueFilter').onchange = e => {
    state.dueFilter = e.target.value;
    localStorage.setItem('dueFilter', state.dueFilter);
    render();
  };

  $('#menuBtn').onclick = () => setSidebar(!$('#sidebar').classList.contains('open'));
  $('#scrim').onclick = () => setSidebar(false);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    setSidebar(false);
    if (state.selectedId && !document.activeElement?.closest?.('.task-details')) { state.selectedId = null; render(); }
  });

  // Moving between side panel and inline details as the window is resized.
  wide.addEventListener('change', () => {
    if (wide.matches) state.selectedId = state.selectedId || [...state.expanded].pop() || null;
    else if (state.selectedId) state.expanded.add(state.selectedId);
    render();
  });

  $('#exportBtn').onclick = exportBackup;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importBackup(f);
  };

  $('#syncStatus').onclick = syncAction;
  $('#syncBanner button').onclick = syncAction;

  // Catch up on a render that waited for the user to finish typing.
  document.addEventListener('focusout', () => setTimeout(() => { if (renderPending) requestRender(); }));

  // Pull changes from other devices while the app is open or brought back.
  setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !Drive.silentReauth()) runSync();
  });
  window.addEventListener('online', () => runSync());

  // Stop the browser from opening a file that misses a drop target.
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });
}

(async function init() {
  Drive.handleRedirect();
  if (Drive.silentReauth()) return; // on the way to Google for a fresh sign-in
  db = await openDb();
  await load();
  if (navigator.storage?.persist) navigator.storage.persist();
  wire();
  render();
  runSync();
})();
