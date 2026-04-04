const API = '/api';
const LIMIT = 10 * 1024 * 1024 * 1024;
const AUTO_DELETE_MS = 3 * 24 * 60 * 60 * 1000;
const IS_FILE_MODE = location.protocol === 'file:';
const DEV_API_ORIGIN = localStorage.getItem('nebula_api_origin') || 'http://localhost:3000';
const IS_LOCALHOST = ['localhost', '127.0.0.1'].includes(location.hostname);

const state = {
  mode: 'signin',
  token: localStorage.getItem('nebula_token') || '',
  user: localStorage.getItem('nebula_user') || '',
  files: [],
  sharedFiles: [],
  teamFiles: [],
  section: 'drive',
  currentFolder: '',
  selectedIds: new Set(),
  view: 'grid',
  uploadProgress: { active: false, percent: 0, uploadedBytes: 0, totalBytes: 0, uploadedFiles: 0, totalFiles: 0 },
  deleteProgress: { active: false, percent: 0, deletedBytes: 0, totalBytes: 0, deletedItems: 0, totalItems: 0 },
  recents: [],
};

const localBlobMap = new Map();

const localKey = {
  users: 'nebula_local_users',
  session: 'nebula_local_session',
  files: (email) => `nebula_local_files_${email}`,
};

function recentsKey() {
  return `nebula:recents:${(state.user || 'anon').toLowerCase()}`;
}

function loadRecents() {
  try {
    const parsed = JSON.parse(localStorage.getItem(recentsKey()) || '[]');
    state.recents = Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    state.recents = [];
  }
}

function saveRecents() {
  localStorage.setItem(recentsKey(), JSON.stringify(state.recents.slice(0, 200)));
}

function recordRecent(id) {
  if (!id) return;
  state.recents = [id, ...state.recents.filter((itemId) => itemId !== id)].slice(0, 200);
  saveRecents();
}

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(2)} MB`);
const toMB = (n) => `${(Number(n || 0) / (1024 ** 2)).toFixed(2)} MB`;
const initials = (email) => (email || 'U').split('@')[0].slice(0, 2).toUpperCase();

const fileTypeColor = {
  folder: '#f7c948',
  pdf: '#ff5a62',
  doc: '#7b6ef6',
  file: '#7b6ef6',
  image: '#3ecfcf',
  video: '#7b6ef6',
  sheet: '#3ecfcf',
  zip: '#888888',
};

const iconSVG = {
  pdf: `<svg viewBox="0 0 16 16" fill="none" stroke-width="1.5" style="width:28px;height:28px"><rect x="3" y="1" width="10" height="14" rx="1.5" stroke="{c}"/><path d="M5 5h6M5 7.5h6M5 10h4" stroke="{c}" stroke-linecap="round"/></svg>`,
  doc: `<svg viewBox="0 0 16 16" fill="none" stroke-width="1.5" style="width:28px;height:28px"><rect x="3" y="1" width="10" height="14" rx="1.5" stroke="{c}"/><path d="M5 5h6M5 7.5h6M5 10h4" stroke="{c}" stroke-linecap="round"/></svg>`,
  sheet: `<svg viewBox="0 0 16 16" fill="none" stroke-width="1.5" style="width:28px;height:28px"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="{c}"/><path d="M2 6h12M6 2v12" stroke="{c}"/></svg>`,
  image: `<svg viewBox="0 0 16 16" fill="none" stroke-width="1.5" style="width:28px;height:28px"><rect x="2" y="2" width="12" height="12" rx="2" stroke="{c}"/><circle cx="6" cy="6" r="1.5" stroke="{c}"/><path d="M2 11l3-3 2 2 2-2 4 4" stroke="{c}" stroke-linecap="round"/></svg>`,
  video: `<svg viewBox="0 0 16 16" fill="none" stroke-width="1.5" style="width:28px;height:28px"><rect x="2" y="3" width="10" height="10" rx="1.5" stroke="{c}"/><path d="M12 6l2.5-2v8L12 10" stroke="{c}" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  folder: `<svg viewBox="0 0 16 16" fill="none" stroke-width="1.5" style="width:28px;height:28px"><path d="M1 5a2 2 0 012-2h2.5l2 2H13a2 2 0 012 2v5a2 2 0 01-2 2H3a2 2 0 01-2-2V5z" stroke="{c}"/></svg>`,
  zip: `<svg viewBox="0 0 16 16" fill="none" stroke-width="1.5" style="width:28px;height:28px"><rect x="3" y="1" width="10" height="14" rx="1.5" stroke="{c}"/><path d="M7 1v6M9 1v6M6 7h4v2H6z" stroke="{c}" stroke-linecap="round"/></svg>`,
};

function iconFor(item, size = 28) {
  const type = item.type === 'folder' ? 'folder' : (item.name.split('.').pop() || item.type || 'doc').toLowerCase();
  const normalized = (type === 'jpg' || type === 'jpeg' || type === 'png' || type === 'gif') ? 'image' : (type === 'mp4' ? 'video' : (type === 'xlsx' || type === 'csv' ? 'sheet' : type));
  const key = iconSVG[normalized] ? normalized : (item.type === 'folder' ? 'folder' : 'doc');
  const color = fileTypeColor[key] || '#7b6ef6';
  return iconSVG[key].replace(/{c}/g, color).replace(/28px/g, `${size}px`);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function apiBase(path) {
  if (IS_FILE_MODE) return `${DEV_API_ORIGIN}${API}${path}`;
  if (IS_LOCALHOST && location.port && location.port !== '3000') return `${DEV_API_ORIGIN}${API}${path}`;
  return `${API}${path}`;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  try {
    const res = await fetch(apiBase(path), { ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || 'Request failed');
    return body;
  } catch (error) {
    if (IS_FILE_MODE) {
      const networkIssue = error instanceof TypeError || /fetch/i.test(error.message);
      if (networkIssue) {
        throw new Error('Cannot reach backend API from file mode. Start the server with `npm start` and retry.');
      }
    }
    throw error;
  }
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}

function currentEmail() {
  const session = readJson(localKey.session, null);
  return state.user || session?.email || '';
}

function localApi(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body instanceof FormData ? options.body : (options.body ? JSON.parse(options.body) : {});
  const users = readJson(localKey.users, []);
  const sessionEmail = currentEmail();
  const files = sessionEmail ? readJson(localKey.files(sessionEmail), []) : [];
  const saveUsers = (value) => localStorage.setItem(localKey.users, JSON.stringify(value));
  const saveFiles = (value) => sessionEmail && localStorage.setItem(localKey.files(sessionEmail), JSON.stringify(value));

  if (path === '/auth/signup' && method === 'POST') {
    if (users.some((u) => u.email === body.email)) throw new Error('Account already exists.');
    users.push({ email: body.email, password: body.password });
    saveUsers(users);
    const token = crypto.randomUUID();
    localStorage.setItem(localKey.session, JSON.stringify({ email: body.email, token }));
    return { email: body.email, token };
  }

  if (path === '/auth/signin' && method === 'POST') {
    const user = users.find((u) => u.email === body.email && u.password === body.password);
    if (!user) throw new Error('Invalid credentials.');
    const token = crypto.randomUUID();
    localStorage.setItem(localKey.session, JSON.stringify({ email: body.email, token }));
    return { email: body.email, token };
  }

  if (path === '/auth/signout' && method === 'POST') {
    localStorage.removeItem(localKey.session);
    return { ok: true };
  }

  if (path === '/account' && method === 'DELETE') {
    const allUsers = users.filter((u) => u.email !== sessionEmail);
    saveUsers(allUsers);
    localStorage.removeItem(localKey.files(sessionEmail));
    users.forEach((u) => {
      if (u.email === sessionEmail) return;
      const ownerFiles = readJson(localKey.files(u.email), []);
      ownerFiles.forEach((f) => { f.sharedWith = (f.sharedWith || []).filter((x) => x !== sessionEmail); });
      localStorage.setItem(localKey.files(u.email), JSON.stringify(ownerFiles));
    });
    localStorage.removeItem(localKey.session);
    return { ok: true };
  }

  if (path === '/files' && method === 'GET') {
    const now = Date.now();
    const clean = files.filter((item) => !(item.createdAt && now - new Date(item.createdAt).getTime() > AUTO_DELETE_MS));
    saveFiles(clean);
    return { files: clean };
  }

  if (path === '/files/shared' && method === 'GET') {
    const shared = [];
    users.forEach((user) => {
      if (user.email === sessionEmail) return;
      readJson(localKey.files(user.email), []).forEach((item) => {
        if (!item.trashedAt && (item.sharedWith || []).includes(sessionEmail)) shared.push({ ...item, owner: user.email });
      });
    });
    return { files: shared };
  }

  if (path === '/files/team-space' && method === 'GET') {
    const team = [];
    users.forEach((user) => {
      readJson(localKey.files(user.email), []).forEach((item) => {
        if (!item.trashedAt && item.teamSpace) team.push({ ...item, owner: user.email });
      });
    });
    return { files: team };
  }

  if (path === '/files' && method === 'POST') {
    const used = files.filter((f) => !f.trashedAt).reduce((a, b) => a + (b.size || 0), 0);
    if (used + Number(body.size || 0) > LIMIT) throw new Error('Storage limit exceeded. Upload would exceed 10 GB.');
    const item = {
      id: crypto.randomUUID(),
      name: body.parentPath ? `${body.parentPath}/${body.name}` : body.name,
      type: body.type,
      size: Number(body.size || 0),
      modified: new Date().toISOString().slice(0, 10),
      sharedWith: [],
      trashedAt: null,
      createdAt: new Date().toISOString(),
      starred: false,
      teamSpace: !!body.teamSpace,
      archived: false,
    };
    files.unshift(item);
    saveFiles(files);
    return item;
  }

  if (path === '/files/trash-batch' && method === 'PATCH') {
    const ids = new Set(body.ids || []);
    const folderPrefixes = files.filter((f) => ids.has(f.id) && f.type === 'folder').map((f) => `${f.name}/`);
    files.forEach((f) => {
      const nestedUnderSelectedFolder = folderPrefixes.some((prefix) => f.name.startsWith(prefix));
      if ((ids.has(f.id) || nestedUnderSelectedFolder) && !f.trashedAt) f.trashedAt = new Date().toISOString();
    });
    saveFiles(files);
    return { ok: true };
  }

  if (path.startsWith('/files/') && path.endsWith('/share') && method === 'PATCH') {
    const id = path.split('/')[2];
    const item = files.find((f) => f.id === id);
    if (!item) throw new Error('File not found.');
    if (!users.some((u) => u.email === body.email)) throw new Error('Target user does not exist.');
    if (body.email === sessionEmail) throw new Error('You already own this item.');
    if (!item.sharedWith.includes(body.email)) item.sharedWith.push(body.email);
    saveFiles(files);
    return item;
  }

  if (path.startsWith('/files/') && path.endsWith('/star') && method === 'PATCH') {
    const id = path.split('/')[2];
    const item = files.find((f) => f.id === id);
    if (!item) throw new Error('File not found.');
    if (item.trashedAt) throw new Error('Cannot star items in trash.');
    item.starred = typeof body.starred === 'boolean' ? body.starred : !item.starred;
    saveFiles(files);
    return item;
  }

  if (path.startsWith('/files/') && path.endsWith('/team-space') && method === 'PATCH') {
    const id = path.split('/')[2];
    const item = files.find((f) => f.id === id);
    if (!item) throw new Error('File not found.');
    if (item.trashedAt) throw new Error('Cannot add trash items to Team Space.');
    item.teamSpace = typeof body.teamSpace === 'boolean' ? body.teamSpace : !item.teamSpace;
    saveFiles(files);
    return item;
  }

  if (path.startsWith('/files/') && path.endsWith('/archive') && method === 'PATCH') {
    const id = path.split('/')[2];
    const item = files.find((f) => f.id === id);
    if (!item) throw new Error('File not found.');
    if (item.trashedAt) throw new Error('Cannot archive items in trash.');
    item.archived = typeof body.archived === 'boolean' ? body.archived : !item.archived;
    saveFiles(files);
    return item;
  }

  if (path === '/files/delete-batch' && method === 'DELETE') {
    const ids = new Set(body.ids || []);
    const folderPrefixes = files.filter((f) => ids.has(f.id) && f.type === 'folder').map((f) => `${f.name}/`);
    const kept = files.filter((f) => {
      const nestedUnderSelectedFolder = folderPrefixes.some((prefix) => f.name.startsWith(prefix));
      return !((ids.has(f.id) || nestedUnderSelectedFolder) && f.trashedAt);
    });
    saveFiles(kept);
    [...ids].forEach((id) => localBlobMap.delete(id));
    files.filter((f) => folderPrefixes.some((prefix) => f.name.startsWith(prefix))).forEach((f) => localBlobMap.delete(f.id));
    return { ok: true };
  }

  if (path === '/files/trash/clear' && method === 'DELETE') {
    const kept = files.filter((f) => !f.trashedAt);
    const deleted = files.filter((f) => f.trashedAt);
    deleted.forEach((f) => localBlobMap.delete(f.id));
    saveFiles(kept);
    return { ok: true };
  }

  if (path === '/upload' && method === 'POST' && body instanceof FormData) {
    const file = body.get('file');
    const parentPath = body.get('parentPath') || '';
    const teamSpace = body.get('teamSpace') === 'true';
    if (!(file instanceof File)) throw new Error('file is required.');
    const used = files.filter((f) => !f.trashedAt).reduce((a, b) => a + (b.size || 0), 0);
    if (used + file.size > LIMIT) throw new Error('Storage limit exceeded. Upload would exceed 10 GB.');
    const item = {
      id: crypto.randomUUID(),
      name: parentPath ? `${parentPath}/${file.name}` : file.name,
      type: 'file',
      size: file.size,
      modified: new Date().toISOString().slice(0, 10),
      sharedWith: [],
      trashedAt: null,
      createdAt: new Date().toISOString(),
      starred: false,
      teamSpace,
      archived: false,
    };
    files.unshift(item);
    saveFiles(files);
    localBlobMap.set(item.id, file);
    return item;
  }

  throw new Error('Operation not available in local mode.');
}

function showAuth(mode = 'signin') {
  state.mode = mode;
  $('tabSignin').classList.toggle('active', mode === 'signin');
  $('tabSignup').classList.toggle('active', mode === 'signup');
  $('authSubmit').textContent = mode === 'signin' ? 'Sign In' : 'Create Account';
}

async function submitAuth() {
  const email = $('authEmail').value.trim().toLowerCase();
  const password = $('authPassword').value;
  if (!email || password.length < 6) {
    $('authMessage').textContent = 'Please use a valid email and a 6+ character password.';
    return;
  }
  try {
    const route = state.mode === 'signin' ? '/auth/signin' : '/auth/signup';
    const result = await api(route, { method: 'POST', body: JSON.stringify({ email, password }) });
    state.token = result.token;
    state.user = result.email;
    localStorage.setItem('nebula_token', result.token);
    localStorage.setItem('nebula_user', result.email);
    $('authMessage').textContent = '';
    await loadDrive();
  } catch (err) {
    state.token = '';
    state.user = '';
    localStorage.removeItem('nebula_token');
    localStorage.removeItem('nebula_user');
    $('authMessage').textContent = err.message;
  }
}

async function signOut() {
  try { await api('/auth/signout', { method: 'POST' }); } catch {}
  state.token = '';
  state.user = '';
  state.files = [];
  state.sharedFiles = [];
  state.teamFiles = [];
  state.selectedIds = new Set();
  localStorage.removeItem('nebula_token');
  localStorage.removeItem('nebula_user');
  $('accountMenu').classList.add('hidden');
  $('accountModal').classList.add('hidden');
  $('drivePage').classList.add('hidden');
  $('authPage').classList.remove('hidden');
  showAuth('signin');
}


function normalizePath(value = '') {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function currentFolderPrefix() {
  return state.currentFolder ? `${state.currentFolder}/` : '';
}

function basename(path) {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const parts = normalized.split('/');
  return parts[parts.length - 1];
}

function currentList() {
  let source;
  if (state.section === 'shared') source = state.sharedFiles;
  else if (state.section === 'archive') source = state.files.filter((f) => !f.trashedAt && !!f.archived);
  else if (state.section === 'trash') source = state.files.filter((f) => !!f.trashedAt);
  else source = state.files.filter((f) => !f.trashedAt && !f.archived);

  let scoped = source;
  if (state.section === 'drive') {
    const prefix = currentFolderPrefix();
    scoped = source.filter((f) => {
      const name = normalizePath(f.name);
      if (!prefix) return !name.includes('/');
      if (!name.startsWith(prefix)) return false;
      return !name.slice(prefix.length).includes('/');
    });
  } else if (state.section === 'recents') {
    const allItems = [...state.files.filter((f) => !f.trashedAt && !f.archived), ...state.sharedFiles.filter((f) => !f.trashedAt)];
    const byId = new Map(allItems.map((item) => [item.id, item]));
    scoped = state.recents.map((id) => byId.get(id)).filter(Boolean);
  } else if (state.section === 'team') {
    scoped = state.teamFiles.filter((f) => !f.trashedAt && !f.archived);
  } else if (state.section === 'starred') {
    scoped = source.filter((f) => !!f.starred);
  }

  const q = $('searchInput').value.trim().toLowerCase();
  return q ? scoped.filter((f) => f.name.toLowerCase().includes(q)) : scoped;
}

function selectedItems() {
  const map = new Map(currentList().map((f) => [f.id, f]));
  return [...state.selectedIds].map((id) => map.get(id)).filter(Boolean);
}

function toggleSelect(id, force) {
  if (force === true) state.selectedIds.add(id);
  else if (force === false) state.selectedIds.delete(id);
  else if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
}

function renderDetails() {
  const items = selectedItems();
  const single = items.length === 1 ? items[0] : null;
  $('detailsEmpty').classList.toggle('hidden', items.length > 0);
  $('detailsBox').classList.toggle('hidden', items.length === 0);

  $('selectionCount').textContent = items.length ? `${items.length} selected` : 'No selection';
  $('shareBtn').disabled = !(items.length === 1 && !['trash','shared'].includes(state.section));
  $('downloadBtn').disabled = !(items.length === 1 && single?.type !== 'folder' && state.section !== 'trash');
  $('trashBtn').disabled = !(items.length > 0 && state.section !== 'trash');
  $('archiveBtn').disabled = !(items.length > 0 && !['shared', 'trash', 'team'].includes(state.section));
  $('archiveBtn').textContent = state.section === 'archive' ? 'Unarchive' : 'Archive';
  $('starBtn').disabled = !(items.length > 0 && !['shared', 'trash'].includes(state.section));
  $('teamSpaceBtn').disabled = !(items.length > 0 && !['shared', 'trash', 'team'].includes(state.section));
  $('deleteForeverBtn').disabled = !(items.length > 0 && state.section === 'trash');
  $('clearBinBtn').classList.toggle('hidden', state.section !== 'trash');

  if (!items.length) return;
  if (!single) {
    $('dName').textContent = `${items.length} items selected`;
    $('dType').textContent = 'Multiple';
    $('dSize').textContent = fmt(items.reduce((acc, item) => acc + (item.size || 0), 0));
    $('dModified').textContent = '-';
    $('dShared').textContent = '-';
    return;
  }

  $('dName').textContent = single.name;
  $('dType').textContent = single.type;
  $('dSize').textContent = single.type === 'folder' ? '-' : fmt(single.size || 0);
  $('dModified').textContent = single.modified;
  $('dShared').textContent = single.sharedWith?.length ? single.sharedWith.join(', ') : 'Only you';
}

function renderStorage() {
  const used = state.files.filter((f) => !f.trashedAt).reduce((a, b) => a + (b.size || 0), 0);
  $('storageText').textContent = `${fmt(used)} / ${fmt(LIMIT)}`;
  $('storageBar').style.width = `${Math.min(100, (used / LIMIT) * 100)}%`;
  $('accountStorage').textContent = `${fmt(used)} of ${fmt(LIMIT)} used`;
}

function renderUploadProgress() {
  const box = $('uploadProgressBox');
  const bar = $('uploadProgressBar');
  const text = $('uploadProgressText');
  const p = state.uploadProgress;
  box.classList.toggle('hidden', !p.active);
  if (!p.active) return;
  bar.style.width = `${p.percent}%`;
  text.textContent = `${p.percent}% · ${toMB(p.uploadedBytes)} / ${toMB(p.totalBytes)} · ${p.uploadedFiles}/${p.totalFiles} files`;
}

function renderDeleteProgress() {
  const box = $('deleteProgressBox');
  const bar = $('deleteProgressBar');
  const text = $('deleteProgressText');
  const p = state.deleteProgress;
  box.classList.toggle('hidden', !p.active);
  if (!p.active) return;
  bar.style.width = `${p.percent}%`;
  text.textContent = `${p.percent}% · ${toMB(p.deletedBytes)} / ${toMB(p.totalBytes)} · ${p.deletedItems}/${p.totalItems} files`;
}

function renderGrid() {
  const list = currentList();
  const grid = $('grid');
  $('empty').classList.toggle('hidden', list.length > 0);

  if (state.view === 'grid') {
    grid.className = 'files-grid';
    grid.innerHTML = list.map((item) => {
      const selected = state.selectedIds.has(item.id);
      const label = basename(item.name);
      return `
        <article class="file-card${selected ? ' selected' : ''}" data-id="${item.id}">
          <div class="fc-thumb">${iconFor(item)}</div>
          <div class="fc-name">${label}</div>
          <div class="fc-meta">${item.type === 'folder' ? '--' : fmt(item.size || 0)} · ${item.modified || '-'}</div>
        </article>`;
    }).join('');
  } else {
    grid.className = 'files-list';
    grid.innerHTML = list.map((item) => {
      const selected = state.selectedIds.has(item.id);
      const owner = state.section === 'shared' ? (item.owner || 'shared') : 'you';
      return `
        <article class="list-row${selected ? ' selected' : ''}" data-id="${item.id}">
          <div class="lr-name"><input type="checkbox" class="row-check" ${selected ? 'checked' : ''}><span class="mini-icon">${iconFor(item, 15)}</span><strong>${basename(item.name)}</strong></div>
          <div class="lr-size">${owner}</div>
          <div class="lr-date">${item.modified || '-'}</div>
          <div class="lr-type">${item.type === 'folder' ? '--' : fmt(item.size || 0)}</div>
        </article>`;
    }).join('');
  }

  grid.querySelectorAll('[data-id]').forEach((row) => {
    const id = row.getAttribute('data-id');
    const item = list.find((f) => f.id === id);
    const checkbox = row.querySelector('.row-check');

    if (checkbox) {
      checkbox.onclick = (e) => {
        e.stopPropagation();
        toggleSelect(id, e.target.checked);
        renderGrid();
        renderDetails();
      };
    }

    row.ondblclick = () => {
      if (['drive', 'recents', 'starred'].includes(state.section) && item?.type === 'folder') {
        state.currentFolder = normalizePath(item.name);
        state.section = 'drive';
        document.querySelectorAll('.side-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === 'drive' && !b.dataset.folder));
        state.selectedIds = new Set();
        recordRecent(id);
        renderGrid();
        renderDetails();
      }
    };

    row.onclick = (e) => {
      recordRecent(id);
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const alreadyOnly = state.selectedIds.size === 1 && state.selectedIds.has(id);
        state.selectedIds = alreadyOnly ? new Set() : new Set([id]);
      } else {
        toggleSelect(id);
      }
      renderGrid();
      renderDetails();
    };
  });

  $('grid-btn').classList.toggle('active', state.view === 'grid');
  $('list-btn').classList.toggle('active', state.view === 'list');
  $('folderPathLabel').textContent = state.currentFolder || 'All Files';
  $('folderUpBtn').disabled = !(state.section === 'drive' && state.currentFolder);

  renderStorage();
  renderUploadProgress();
  renderDeleteProgress();
  const readonly = state.section === 'shared' || state.section === 'trash' || state.section === 'archive';
  $('uploadFileBtn').disabled = readonly;
  $('uploadFolderBtn').disabled = readonly;
  $('newFolderBtn').disabled = readonly;
}

async function loadDrive() {
  const [filesResult, sharedResult, teamResult] = await Promise.allSettled([api('/files'), api('/files/shared'), api('/files/team-space')]);
  if (filesResult.status !== 'fulfilled') throw filesResult.reason;
  if (sharedResult.status !== 'fulfilled') throw sharedResult.reason;

  const filesResp = filesResult.value || {};
  const sharedResp = sharedResult.value || {};
  const teamResp = teamResult.status === 'fulfilled' ? (teamResult.value || {}) : {};

  state.files = Array.isArray(filesResp.files) ? filesResp.files : [];
  state.sharedFiles = Array.isArray(sharedResp.files) ? sharedResp.files : [];
  state.teamFiles = Array.isArray(teamResp.files) ? teamResp.files : [];
  loadRecents();
  const validIds = new Set([...state.files, ...state.sharedFiles, ...state.teamFiles].map((item) => item.id));
  state.recents = state.recents.filter((id) => validIds.has(id));
  saveRecents();
  state.selectedIds = new Set();
  $('currentUser').textContent = state.user;
  $('accountEmail').textContent = state.user;
  $('accountAvatar').textContent = initials(state.user);
  $('authPage').classList.add('hidden');
  $('drivePage').classList.remove('hidden');
  renderGrid();
  renderDetails();
}

function uploadSingleFileWithProgress(file, parentPath, onProgress, teamSpace = false) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiBase('/upload'));
    if (state.token) xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        try {
          const body = JSON.parse(xhr.responseText || '{}');
          reject(new Error(body.message || 'Upload failed'));
        } catch {
          reject(new Error('Upload failed'));
        }
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('parentPath', parentPath);
    form.append('teamSpace', teamSpace ? 'true' : 'false');
    xhr.send(form);
  });
}

async function uploadRecords(fileList, isFolder = false) {
  if (!fileList?.length) return;
  const files = [...fileList];
  let used = state.files.filter((f) => !f.trashedAt).reduce((a, b) => a + (b.size || 0), 0);
  const existingFolders = new Set(state.files.filter((f) => f.type === 'folder').map((f) => normalizePath(f.name)));

  if (isFolder) {
    for (const file of files) {
      const normalizedRel = normalizePath(file.webkitRelativePath || '');
      const relDirs = normalizedRel.split('/').slice(0, -1);
      let cursor = normalizePath(state.currentFolder);
      for (const segment of relDirs) {
        cursor = normalizePath(cursor ? `${cursor}/${segment}` : segment);
        if (!cursor || existingFolders.has(cursor)) continue;
        await api('/files', { method: 'POST', body: JSON.stringify({ name: basename(cursor), type: 'folder', size: 0, parentPath: normalizePath(cursor.split('/').slice(0, -1).join('/')), teamSpace: state.section === 'team' }) });
        existingFolders.add(cursor);
      }
    }
  }

  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
  state.uploadProgress = { active: true, percent: 0, uploadedBytes: 0, totalBytes, uploadedFiles: 0, totalFiles: files.length };
  renderUploadProgress();

  let uploaded = 0;
  for (const file of files) {
    if (used + file.size > LIMIT) {
      toast(`Upload blocked: ${file.name} exceeds your 10 GB storage limit.`);
      continue;
    }

    const relParent = isFolder ? normalizePath((file.webkitRelativePath || '').split('/').slice(0, -1).join('/')) : '';
    const parentPath = normalizePath(state.currentFolder ? `${state.currentFolder}/${relParent}` : relParent || state.currentFolder);

    const alreadyUploaded = state.uploadProgress.uploadedBytes;
    if (IS_FILE_MODE) {
      const created = await api('/files', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, type: 'file', size: file.size, parentPath, teamSpace: state.section === 'team' }),
      });
      localBlobMap.set(created.id, file);
      state.uploadProgress.uploadedBytes = alreadyUploaded + file.size;
    } else {
      await uploadSingleFileWithProgress(file, parentPath, (loadedBytes) => {
        state.uploadProgress.uploadedBytes = alreadyUploaded + loadedBytes;
        state.uploadProgress.percent = totalBytes ? Math.min(100, Math.round((state.uploadProgress.uploadedBytes / totalBytes) * 100)) : 100;
        renderUploadProgress();
      }, state.section === 'team');
      state.uploadProgress.uploadedBytes = alreadyUploaded + file.size;
    }

    state.uploadProgress.uploadedFiles += 1;
    state.uploadProgress.percent = totalBytes ? Math.min(100, Math.round((state.uploadProgress.uploadedBytes / totalBytes) * 100)) : 100;
    renderUploadProgress();
    used += file.size;
    uploaded += 1;
  }

  await loadDrive();
  state.uploadProgress.percent = 100;
  renderUploadProgress();
  setTimeout(() => {
    state.uploadProgress.active = false;
    renderUploadProgress();
  }, 1200);
  toast(uploaded ? `Uploaded ${uploaded} item(s).` : 'Nothing uploaded.');
}

async function createFolder() {
  const name = prompt('Folder name', 'New Folder');
  if (!name) return;
  await api('/files', { method: 'POST', body: JSON.stringify({ name, type: 'folder', size: 0, parentPath: state.currentFolder, teamSpace: state.section === 'team' }) });
  await loadDrive();
  toast('Folder created.');
}

async function moveToTrash() {
  if (!state.selectedIds.size) return;
  await api('/files/trash-batch', { method: 'PATCH', body: JSON.stringify({ ids: [...state.selectedIds] }) });
  await loadDrive();
  toast('Moved selected items to Trash.');
}

async function toggleStarSelected() {
  const items = selectedItems();
  if (!items.length) return;
  const shouldStar = items.some((item) => !item.starred);
  await Promise.all(items.map((item) => api(`/files/${item.id}/star`, { method: 'PATCH', body: JSON.stringify({ starred: shouldStar }) })));
  await loadDrive();
  toast(shouldStar ? 'Starred.' : 'Unstarred.');
}

async function toggleArchiveSelected() {
  const items = selectedItems();
  if (!items.length) return;
  const shouldArchive = state.section === 'archive' ? false : items.some((item) => !item.archived);
  await Promise.all(items.map((item) => api(`/files/${item.id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: shouldArchive }) })));
  await loadDrive();
  toast(shouldArchive ? 'Archived.' : 'Unarchived.');
}

async function toggleTeamSpaceSelected() {
  const items = selectedItems();
  if (!items.length) return;
  const shouldAdd = items.some((item) => !item.teamSpace);
  await Promise.all(items.map((item) => api(`/files/${item.id}/team-space`, { method: 'PATCH', body: JSON.stringify({ teamSpace: shouldAdd }) })));
  await loadDrive();
  toast(shouldAdd ? 'Added to Team Space.' : 'Removed from Team Space.');
}

async function deleteWithProgress(ids) {
  const validIds = ids.filter(Boolean);
  if (!validIds.length) return 0;
  const byId = new Map(state.files.map((item) => [item.id, item]));
  const totalBytes = validIds.reduce((sum, id) => sum + (byId.get(id)?.size || 0), 0);
  state.deleteProgress = { active: true, percent: 0, deletedBytes: 0, totalBytes, deletedItems: 0, totalItems: validIds.length };
  renderDeleteProgress();

  let deleted = 0;
  for (const id of validIds) {
    await api('/files/delete-batch', { method: 'DELETE', body: JSON.stringify({ ids: [id] }) });
    deleted += 1;
    state.deleteProgress.deletedItems = deleted;
    state.deleteProgress.deletedBytes += byId.get(id)?.size || 0;
    state.deleteProgress.percent = Math.round((deleted / validIds.length) * 100);
    renderDeleteProgress();
  }

  await loadDrive();
  state.deleteProgress.percent = 100;
  renderDeleteProgress();
  setTimeout(() => {
    state.deleteProgress.active = false;
    renderDeleteProgress();
  }, 1200);
  return deleted;
}

async function deleteForever() {
  if (!state.selectedIds.size || state.section !== 'trash') return;
  const deleted = await deleteWithProgress([...state.selectedIds]);
  toast(deleted ? 'Deleted selected items permanently.' : 'Nothing deleted.');
}

async function clearBin() {
  if (state.section !== 'trash') return;
  const ids = state.files.filter((item) => !!item.trashedAt).map((item) => item.id);
  const deleted = await deleteWithProgress(ids);
  toast(deleted ? 'Trash cleared.' : 'Trash is already empty.');
}

function downloadSelected() {
  const item = selectedItems()[0];
  if (!item || item.type === 'folder' || state.section === 'trash') return;

  if (IS_FILE_MODE) {
    const blob = localBlobMap.get(item.id);
    if (!blob) return toast('Local mode cannot download this file after refresh.');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name.split('/').pop();
    a.click();
    URL.revokeObjectURL(url);
    return toast('Download started.');
  }

  fetch(apiBase(`/files/${item.id}/download`), { headers: { Authorization: `Bearer ${state.token}` } })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || 'Download failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.name.split('/').pop();
      a.click();
      URL.revokeObjectURL(url);
      toast('Download started.');
    })
    .catch((error) => toast(error.message));
}

function openShare() {
  if (selectedItems().length !== 1) return;
  $('shareEmail').value = '';
  $('shareModal').classList.remove('hidden');
}

async function confirmShare() {
  const item = selectedItems()[0];
  const email = $('shareEmail').value.trim().toLowerCase();
  if (!item || !email) return;
  try {
    await api(`/files/${item.id}/share`, { method: 'PATCH', body: JSON.stringify({ email }) });
    $('shareModal').classList.add('hidden');
    await loadDrive();
    toast('Shared successfully.');
  } catch (error) {
    toast(error.message);
  }
}

async function deleteAccount() {
  const msg = $('accountDeleteMsg');
  const password = $('accountPassword').value;
  if (!password) {
    msg.textContent = 'Please enter your password to delete this account.';
    msg.classList.remove('hidden');
    return;
  }
  msg.classList.add('hidden');

  const sure = confirm('Delete your account and all files permanently? This cannot be undone.');
  if (!sure) return;

  try {
    await api('/account', { method: 'DELETE', body: JSON.stringify({ password }) });
    $('accountPassword').value = '';
    $('accountModal').classList.add('hidden');
    toast('Account deleted.');
    await signOut();
  } catch (error) {
    msg.textContent = error.message || 'Wrong password. Account deletion denied.';
    msg.classList.remove('hidden');
  }
}

function wire() {
  $('tabSignin').onclick = () => showAuth('signin');
  $('tabSignup').onclick = () => showAuth('signup');
  $('authSubmit').onclick = submitAuth;
  $('signOutBtn').onclick = signOut;
  $('searchInput').oninput = renderGrid;
  $('grid-btn').onclick = () => { state.view = 'grid'; renderGrid(); };
  $('list-btn').onclick = () => { state.view = 'list'; renderGrid(); };

  $('uploadFileBtn').onclick = () => $('fileInput').click();
  $('newQuickBtn').onclick = () => $('fileInput').click();
  $('uploadFolderBtn').onclick = () => $('folderInput').click();
  $('fileInput').onchange = async (e) => { await uploadRecords(e.target.files, false); e.target.value = ''; };
  $('folderInput').onchange = async (e) => { await uploadRecords(e.target.files, true); e.target.value = ''; };

  $('newFolderBtn').onclick = createFolder;
  $('shareBtn').onclick = openShare;
  $('downloadBtn').onclick = downloadSelected;
  $('trashBtn').onclick = moveToTrash;
  $('archiveBtn').onclick = toggleArchiveSelected;
  $('starBtn').onclick = toggleStarSelected;
  $('teamSpaceBtn').onclick = toggleTeamSpaceSelected;
  $('deleteForeverBtn').onclick = deleteForever;
  $('clearBinBtn').onclick = clearBin;

  $('cancelShare').onclick = () => $('shareModal').classList.add('hidden');
  $('confirmShare').onclick = confirmShare;

  $('accountMenuBtn').onclick = () => $('accountMenu').classList.toggle('hidden');
  $('openAccountBtn').onclick = () => {
    $('accountMenu').classList.add('hidden');
    $('accountPassword').value = '';
    $('accountDeleteMsg').classList.add('hidden');
    $('accountDeleteMsg').textContent = '';
    $('accountModal').classList.remove('hidden');
  };
  $('closeAccountModal').onclick = () => { $('accountPassword').value = ''; $('accountDeleteMsg').classList.add('hidden'); $('accountDeleteMsg').textContent = ''; $('accountModal').classList.add('hidden'); };
  $('deleteAccountBtn').onclick = deleteAccount;
  $('folderUpBtn').onclick = () => {
    if (!state.currentFolder) return;
    const parts = normalizePath(state.currentFolder).split('/');
    parts.pop();
    state.currentFolder = parts.join('/');
    state.selectedIds = new Set();
    renderGrid();
    renderDetails();
  };

  document.querySelectorAll('.side-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.side-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.section = btn.dataset.section;
      state.currentFolder = btn.dataset.folder || '';
      state.selectedIds = new Set();
      renderGrid();
      renderDetails();
    };
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.account-wrap')) $('accountMenu').classList.add('hidden');
  });
}

wire();

async function bootstrap() {
  if (state.token && state.user) {
    try {
      await api('/auth/me');
      await loadDrive();
      return;
    } catch {
      await signOut();
      return;
    }
  }
  showAuth('signin');
}

bootstrap();
