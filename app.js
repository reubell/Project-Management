'use strict';

// ---------- Storage (IndexedDB: works offline, handles large files) ----------

const DB_NAME = 'project-tasks';
const DB_VERSION = 1;
let db;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('tasks', { keyPath: 'id' });
      d.createObjectStore('files', { keyPath: 'id' });
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

function getAll(store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const put = (store, value) => tx(store, 'readwrite', t => t.objectStore(store).put(value));
const del = (store, id) => tx(store, 'readwrite', t => t.objectStore(store).delete(id));

// ---------- State ----------

const state = {
  projects: [],
  tasks: [],
  files: [],
  currentId: localStorage.getItem('currentProject'),
  expanded: new Set(),
  showCompleted: localStorage.getItem('showCompleted') === '1',
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const $ = sel => document.querySelector(sel);

function currentProject() {
  return state.projects.find(p => p.id === state.currentId);
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
  await put('projects', p);
  state.projects.push(p);
  setCurrent(p.id);
}

async function renameProject(p) {
  const name = prompt('Project name', p.name);
  if (!name || !name.trim()) return;
  p.name = name.trim();
  await put('projects', p);
  render();
}

async function deleteProject(p) {
  const tasks = state.tasks.filter(t => t.projectId === p.id);
  if (!confirm(`Delete "${p.name}" and its ${tasks.length} task(s)? This cannot be undone.`)) return;
  const taskIds = new Set(tasks.map(t => t.id));
  const files = state.files.filter(f => taskIds.has(f.taskId));
  await tx(['projects', 'tasks', 'files'], 'readwrite', t => {
    t.objectStore('projects').delete(p.id);
    tasks.forEach(x => t.objectStore('tasks').delete(x.id));
    files.forEach(x => t.objectStore('files').delete(x.id));
  });
  state.projects = state.projects.filter(x => x.id !== p.id);
  state.tasks = state.tasks.filter(x => !taskIds.has(x.id));
  state.files = state.files.filter(x => !taskIds.has(x.taskId));
  setCurrent(state.projects[0]?.id || null);
}

// ---------- Tasks ----------

async function addTask(title) {
  const t = { id: uid(), projectId: state.currentId, title, notes: '', done: false, created: Date.now() };
  await put('tasks', t);
  state.tasks.push(t);
  render();
}

async function toggleTask(t) {
  t.done = !t.done;
  t.completedAt = t.done ? Date.now() : null;
  await put('tasks', t);
  render();
}

async function saveTask(t) {
  await put('tasks', t);
}

async function deleteTask(t) {
  const files = state.files.filter(f => f.taskId === t.id);
  const label = files.length ? ` and its ${files.length} file(s)` : '';
  if (!confirm(`Delete "${t.title}"${label}?`)) return;
  await tx(['tasks', 'files'], 'readwrite', s => {
    s.objectStore('tasks').delete(t.id);
    files.forEach(f => s.objectStore('files').delete(f.id));
  });
  state.tasks = state.tasks.filter(x => x.id !== t.id);
  state.files = state.files.filter(f => f.taskId !== t.id);
  state.expanded.delete(t.id);
  render();
}

async function moveTask(taskId, projectId) {
  const t = state.tasks.find(x => x.id === taskId);
  if (!t || t.projectId === projectId) return;
  t.projectId = projectId;
  await put('tasks', t);
  render();
}

// ---------- Files ----------

async function attachFiles(task, fileList) {
  for (const file of fileList) {
    const f = {
      id: uid(),
      taskId: task.id,
      name: file.name,
      type: file.type,
      size: file.size,
      blob: file,
      added: Date.now(),
    };
    await put('files', f);
    state.files.push(f);
  }
  state.expanded.add(task.id);
  render();
}

async function removeFile(f) {
  if (!confirm(`Remove "${f.name}"?`)) return;
  await del('files', f.id);
  state.files = state.files.filter(x => x.id !== f.id);
  render();
}

function openFile(f) {
  const url = URL.createObjectURL(f.blob);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  // Types the browser can preview open in a tab; anything else downloads.
  if (!/^(image\/|application\/pdf|text\/|video\/|audio\/)/.test(f.type)) a.download = f.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
const TASK_MIME = 'application/x-task-id';

// ---------- Rendering ----------

function render() {
  if (!currentProject() && state.projects.length) state.currentId = state.projects[0].id;
  renderProjects();
  renderTasks();
}

function renderProjects() {
  const list = $('#projectList');
  list.innerHTML = '';
  for (const p of state.projects) {
    const open = state.tasks.filter(t => t.projectId === p.id && !t.done).length;
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

  const tasks = state.tasks.filter(t => t.projectId === p.id);
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
  const files = state.files.filter(f => f.taskId === t.id).sort((a, b) => a.added - b.added);
  const expanded = state.expanded.has(t.id);

  li.classList.toggle('done', t.done);
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
    notes.onchange = () => render();

    const fileList = li.querySelector('.files');
    for (const f of files) {
      const item = document.createElement('li');
      item.innerHTML = '<a href="#"></a><span class="size"></span><button type="button" class="remove" aria-label="Remove file">×</button>';
      const link = item.querySelector('a');
      link.textContent = f.name;
      link.title = f.name;
      link.onclick = e => { e.preventDefault(); openFile(f); };
      item.querySelector('.size').textContent = formatSize(f.size);
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

// ---------- Backup / restore ----------

function blobToDataUrl(blob) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

async function exportBackup() {
  const files = await Promise.all(state.files.map(async f => ({ ...f, blob: await blobToDataUrl(f.blob) })));
  const data = { app: 'project-tasks', version: 1, exported: new Date().toISOString(),
    projects: state.projects, tasks: state.tasks, files };
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
  if (!confirm('Restoring replaces everything currently in the app with the backup. Continue?')) return;
  const files = await Promise.all(data.files.map(async f => ({ ...f, blob: await (await fetch(f.blob)).blob() })));
  await tx(['projects', 'tasks', 'files'], 'readwrite', t => {
    for (const s of ['projects', 'tasks', 'files']) t.objectStore(s).clear();
    data.projects.forEach(p => t.objectStore('projects').put(p));
    data.tasks.forEach(x => t.objectStore('tasks').put(x));
    files.forEach(f => t.objectStore('files').put(f));
  });
  await load();
  setCurrent(state.projects[0]?.id || null);
}

// ---------- Wiring ----------

async function load() {
  [state.projects, state.tasks, state.files] = await Promise.all([getAll('projects'), getAll('tasks'), getAll('files')]);
  state.projects.sort((a, b) => a.created - b.created);
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

  // Stop the browser from opening a file that misses a drop target.
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });
}

(async function init() {
  db = await openDb();
  await load();
  if (navigator.storage?.persist) navigator.storage.persist();
  wire();
  if (!state.projects.length) await addProject('My first project');
  render();
})();
