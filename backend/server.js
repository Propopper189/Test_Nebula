const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const AUTO_DELETE_MS = 3 * 24 * 60 * 60 * 1000;
const uploadDir = path.join(__dirname, '..', 'uploads');
const dbPath = path.join(__dirname, 'data.json');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\- ]+/g, '_');
      cb(null, `${Date.now()}-${crypto.randomUUID()}-${safe}`);
    },
  }),
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function loadDb() {
  if (!fs.existsSync(dbPath)) return { users: {}, filesByUser: {}, blobs: {} };
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch {
    return { users: {}, filesByUser: {}, blobs: {} };
  }
}

let db = loadDb();
const sessions = new Map(); // token -> email

function saveDb() {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function ensureUserFiles(email) {
  if (!db.filesByUser[email]) db.filesByUser[email] = [];
  return db.filesByUser[email];
}

function getUsedBytes(email) {
  purgeExpired(email);
  return ensureUserFiles(email)
    .filter((item) => !item.trashedAt)
    .reduce((acc, item) => acc + (item.size || 0), 0);
}

function removeBinary(fileId) {
  const blob = db.blobs[fileId];
  if (blob?.filePath && fs.existsSync(blob.filePath)) {
    fs.unlinkSync(blob.filePath);
  }
  delete db.blobs[fileId];
}

function purgeExpired(email) {
  const now = Date.now();
  const files = ensureUserFiles(email);
  const kept = [];
  let changed = false;
  for (const item of files) {
    if (item.createdAt && now - new Date(item.createdAt).getTime() > AUTO_DELETE_MS) {
      removeBinary(item.id);
      changed = true;
      continue;
    }
    kept.push(item);
  }
  if (changed) {
    db.filesByUser[email] = kept;
    saveDb();
  }
  return db.filesByUser[email];
}

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) return res.status(401).json({ message: 'Unauthorized' });
  req.userEmail = sessions.get(token);
  next();
}

app.post('/api/auth/signup', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ message: 'Email and password (6+ chars) are required.' });
  }
  const normalized = email.trim().toLowerCase();
  if (db.users[normalized]) return res.status(409).json({ message: 'Account already exists.' });

  db.users[normalized] = { password };
  ensureUserFiles(normalized);
  saveDb();

  const token = crypto.randomUUID();
  sessions.set(token, normalized);
  res.json({ token, email: normalized });
});

app.post('/api/auth/signin', (req, res) => {
  const { email, password } = req.body || {};
  const normalized = (email || '').trim().toLowerCase();
  const user = db.users[normalized];
  if (!user || user.password !== password) return res.status(401).json({ message: 'Invalid credentials.' });

  const token = crypto.randomUUID();
  sessions.set(token, normalized);
  res.json({ token, email: normalized });
});

app.post('/api/auth/signout', auth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ email: req.userEmail });
});

app.delete('/api/account', auth, (req, res) => {
  const email = req.userEmail;
  const password = req.body?.password;
  if (!password || db.users[email]?.password !== password) {
    return res.status(401).json({ message: 'Password verification failed.' });
  }

  for (const item of ensureUserFiles(email)) removeBinary(item.id);
  delete db.filesByUser[email];
  delete db.users[email];

  for (const owner of Object.keys(db.filesByUser)) {
    db.filesByUser[owner].forEach((file) => {
      file.sharedWith = (file.sharedWith || []).filter((sharedEmail) => sharedEmail !== email);
    });
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  sessions.delete(token);
  saveDb();
  res.json({ ok: true });
});

app.get('/api/files', auth, (req, res) => {
  const files = purgeExpired(req.userEmail);
  res.json({ files });
});

app.get('/api/files/shared', auth, (req, res) => {
  const shared = [];
  purgeExpired(req.userEmail);
  for (const [owner] of Object.entries(db.filesByUser)) {
    const records = purgeExpired(owner);
    if (owner === req.userEmail) continue;
    records.forEach((item) => {
      if (!item.trashedAt && (item.sharedWith || []).includes(req.userEmail)) {
        shared.push({ ...item, owner });
      }
    });
  }
  res.json({ files: shared });
});

app.post('/api/files', auth, (req, res) => {
  const { name, type, size = 0, parentPath = '' } = req.body || {};
  if (!name || !type) return res.status(400).json({ message: 'name and type are required.' });
  const parsedSize = Number(size || 0);

  if (getUsedBytes(req.userEmail) + parsedSize > STORAGE_LIMIT_BYTES) {
    return res.status(413).json({ message: 'Storage limit exceeded. Upload would exceed 10 GB.' });
  }

  const item = {
    id: crypto.randomUUID(),
    name: parentPath ? `${parentPath}/${name}` : name,
    type,
    size: parsedSize,
    modified: new Date().toISOString().slice(0, 10),
    sharedWith: [],
    trashedAt: null,
    createdAt: new Date().toISOString(),
    starred: false,
    teamSpace: false,
    archived: false,
  };
  ensureUserFiles(req.userEmail).unshift(item);
  saveDb();
  res.status(201).json(item);
});

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'file is required.' });
  const parentPath = req.body?.parentPath || '';

  if (getUsedBytes(req.userEmail) + req.file.size > STORAGE_LIMIT_BYTES) {
    fs.unlinkSync(req.file.path);
    return res.status(413).json({ message: 'Storage limit exceeded. Upload would exceed 10 GB.' });
  }

  const item = {
    id: crypto.randomUUID(),
    name: parentPath ? `${parentPath}/${req.file.originalname}` : req.file.originalname,
    type: 'file',
    size: req.file.size,
    modified: new Date().toISOString().slice(0, 10),
    sharedWith: [],
    trashedAt: null,
    createdAt: new Date().toISOString(),
    starred: false,
    teamSpace: false,
    archived: false,
    mimeType: req.file.mimetype || 'application/octet-stream',
  };

  ensureUserFiles(req.userEmail).unshift(item);
  db.blobs[item.id] = {
    filePath: req.file.path,
    mimeType: item.mimeType,
    originalName: req.file.originalname,
  };
  saveDb();
  res.status(201).json(item);
});

app.patch('/api/files/trash-batch', auth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ message: 'ids are required.' });

  const set = new Set(ids);
  const files = ensureUserFiles(req.userEmail);
  files.forEach((item) => {
    if (set.has(item.id) && !item.trashedAt) item.trashedAt = new Date().toISOString();
  });
  saveDb();
  res.json({ ok: true });
});

app.patch('/api/files/:id/share', auth, (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ message: 'Share email is required.' });
  if (!db.users[email]) return res.status(404).json({ message: 'Target user does not exist.' });
  if (email === req.userEmail) return res.status(400).json({ message: 'You already own this item.' });

  const file = ensureUserFiles(req.userEmail).find((f) => f.id === req.params.id);
  if (!file) return res.status(404).json({ message: 'File not found.' });
  if (!file.sharedWith.includes(email)) file.sharedWith.push(email);
  saveDb();
  res.json(file);
});

app.patch('/api/files/:id/star', auth, (req, res) => {
  const files = ensureUserFiles(req.userEmail);
  const file = files.find((f) => f.id === req.params.id);
  if (!file) return res.status(404).json({ message: 'File not found.' });
  if (file.trashedAt) return res.status(400).json({ message: 'Cannot star items in trash.' });

  const next = typeof req.body?.starred === 'boolean' ? req.body.starred : !file.starred;
  file.starred = next;
  saveDb();
  res.json(file);
});

app.patch('/api/files/:id/team-space', auth, (req, res) => {
  const files = ensureUserFiles(req.userEmail);
  const file = files.find((f) => f.id === req.params.id);
  if (!file) return res.status(404).json({ message: 'File not found.' });
  if (file.trashedAt) return res.status(400).json({ message: 'Cannot add trash items to Team Space.' });

  const next = typeof req.body?.teamSpace === 'boolean' ? req.body.teamSpace : !file.teamSpace;
  file.teamSpace = next;
  saveDb();
  res.json(file);
});

app.patch('/api/files/:id/archive', auth, (req, res) => {
  const files = ensureUserFiles(req.userEmail);
  const file = files.find((f) => f.id === req.params.id);
  if (!file) return res.status(404).json({ message: 'File not found.' });
  if (file.trashedAt) return res.status(400).json({ message: 'Cannot archive items in trash.' });

  const next = typeof req.body?.archived === 'boolean' ? req.body.archived : !file.archived;
  file.archived = next;
  saveDb();
  res.json(file);
});

app.delete('/api/files/delete-batch', auth, (req, res) => {
  const ids = new Set(Array.isArray(req.body?.ids) ? req.body.ids : []);
  if (!ids.size) return res.status(400).json({ message: 'ids are required.' });

  const files = ensureUserFiles(req.userEmail);
  db.filesByUser[req.userEmail] = files.filter((item) => {
    if (!ids.has(item.id)) return true;
    if (!item.trashedAt) return true;
    removeBinary(item.id);
    return false;
  });
  saveDb();
  res.json({ ok: true });
});

app.delete('/api/files/trash/clear', auth, (req, res) => {
  const files = ensureUserFiles(req.userEmail);
  db.filesByUser[req.userEmail] = files.filter((item) => {
    if (!item.trashedAt) return true;
    removeBinary(item.id);
    return false;
  });
  saveDb();
  res.json({ ok: true });
});

app.get('/api/files/:id/download', auth, (req, res) => {
  purgeExpired(req.userEmail);
  let file = ensureUserFiles(req.userEmail).find((f) => f.id === req.params.id);
  if (!file) {
    for (const [owner, records] of Object.entries(db.filesByUser)) {
      if (owner === req.userEmail) continue;
      const ownerRecords = purgeExpired(owner);
      const shared = ownerRecords.find((f) => f.id === req.params.id && !f.trashedAt && (f.sharedWith || []).includes(req.userEmail));
      if (shared) {
        file = shared;
        break;
      }
    }
  }

  if (!file) return res.status(404).json({ message: 'File not found.' });
  if (file.type === 'folder') return res.status(400).json({ message: 'Folders cannot be downloaded.' });

  const blob = db.blobs[file.id];
  if (!blob || !fs.existsSync(blob.filePath)) {
    return res.status(404).json({ message: 'Binary content not available for this file.' });
  }
  res.download(blob.filePath, blob.originalName);
});

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`NebulaCloud server running on http://localhost:${PORT}`);
});
