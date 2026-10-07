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
  currentId: localStorage.getItem('currentProject'),
  expanded: new Set(),
  showCompleted: localStorage.getItem('showCompleted') === '1',
};

const live = r => !r.deleted;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const $ = sel => document.querySelector(sel);

function currentProject() {
  return state.projects.find(p => p.id === state.currentId && live(p));
}

function setCurrent(id) {
  state.currentId = id;
  localStorage.setItem('currentProject', id || '');
  state.expanded.clear();
  $('#sidebar').classList.remove('open');
  render();
}

// ---------- Projects ----------

async function addProject(name) {
  const p = { id: uid(), name, created: Date.now() };
  state.projects.push(p);
  await save([['projects', p]]);
  setCurrent(p.id);
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
  setCurrent(state.projects.find(live)?.id || null);
}

// ---------- Tasks ----------

async function addTask(title) {
  const t = { id: uid(), projectId: state.currentId, title, notes: '', done: false, created: Date.now() };
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
  state.expanded.add(task.id);
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
function requestRender() {
  if (document.activeElement?.closest?.('.task-details')) renderPending = true;
  else render();
}

function render() {
  renderPending = false;
  if (!currentProject()) state.currentId = state.projects.find(live)?.id || null;
  renderProjects();
  renderTasks();
  renderSync();
}

function renderProjects() {
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
  const p = currentProject();
  $('#emptyState').hidden = !!p;
  $('#projectView').hidden = !p;
  $('#projectTitle').textContent = p ? p.name : '';
  $('#projectMenuBtn').hidden = !p;
  document.title = p ? `${p.name} · Project Tasks` : 'Project Tasks';
  if (!p) return;

  const tasks = state.tasks.filter(t => t.projectId === p.id && live(t));
  const open = tasks.filter(t => !t.done).sort((a, b) => a.created - b.created);
  const done = tasks.filter(t => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  fillList($('#openList'), open);
  fillList($('#completedList'), done);
  $('#openEmpty').hidden = open.length > 0;
  $('#completedCount').textContent = done.length;
  $('#completedToggle').hidden = done.length === 0;
  $('#completedToggle').setAttribute('aria-expanded', state.showCompleted);
  $('#completedList').hidden = !state.showCompleted;
}

function fillList(ul, tasks) {
  ul.innerHTML = '';
  tasks.forEach(t => ul.appendChild(taskEl(t)));
}

function taskEl(t) {
  const li = $('#taskTemplate').content.firstElementChild.cloneNode(true);
  const files = state.files.filter(f => f.taskId === t.id && live(f)).sort((a, b) => a.added - b.added);
  const expanded = state.expanded.has(t.id);

  li.classList.toggle('done', !!t.done);
  li.querySelector('.task-title').textContent = t.title;
  const badge = li.querySelector('.file-badge');
  badge.hidden = files.length === 0 && !t.notes;
  badge.textContent = [t.notes ? '✎' : '', files.length ? `📎 ${files.length}` : ''].filter(Boolean).join('  ');

  li.querySelector('.check').onclick = e => { e.stopPropagation(); toggleTask(t); };
  li.querySelector('.task-row').onclick = () => {
    state.expanded.has(t.id) ? state.expanded.delete(t.id) : state.expanded.add(t.id);
    render();
  };

  // Drag the row onto a project in the sidebar to move it.
  const row = li.querySelector('.task-row');
  row.draggable = true;
  row.ondragstart = e => {
    e.dataTransfer.setData(TASK_MIME, t.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  // Drop files anywhere on the task.
  let depth = 0;
  li.ondragenter = e => { if (hasFiles(e)) { depth++; li.classList.add('drop-target'); } };
  li.ondragleave = e => { if (hasFiles(e) && --depth <= 0) { depth = 0; li.classList.remove('drop-target'); } };
  li.ondragover = e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
  li.ondrop = e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    li.classList.remove('drop-target');
    if (e.dataTransfer.files.length) attachFiles(t, e.dataTransfer.files);
  };

  const details = li.querySelector('.task-details');
  details.hidden = !expanded;
  if (expanded) {
    const title = li.querySelector('.edit-title');
    title.value = t.title;
    title.onchange = () => {
      const v = title.value.trim();
      if (!v) { title.value = t.title; return; }
      t.title = v;
      li.querySelector('.task-title').textContent = v;
      saveTask(t);
    };
    title.onkeydown = e => { if (e.key === 'Enter') title.blur(); };

    const notes = li.querySelector('.edit-notes');
    notes.value = t.notes || '';
    notes.oninput = () => { t.notes = notes.value; saveTask(t); };

    const fileList = li.querySelector('.files');
    for (const f of files) {
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

    const input = li.querySelector('.attach-input');
    li.querySelector('.attach-btn').onclick = () => input.click();
    input.onchange = () => { if (input.files.length) attachFiles(t, input.files); };

    li.querySelector('.delete-task').onclick = () => deleteTask(t);
  }
  return li;
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
  setCurrent(data.projects[0]?.id || state.currentId);
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

  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');

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
