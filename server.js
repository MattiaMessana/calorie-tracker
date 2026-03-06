const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

const VALID_MEALS = ['colazione', 'pranzo', 'cena', 'spuntino'];

// --- Database helpers ---

function getDefaultDb() {
  return {
    goalKcal: 2200,
    entries: [],
  };
}

function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readDb() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) {
    const data = getDefaultDb();
    writeDbSync(data);
    return data;
  }
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDbSync(data) {
  ensureDataDir();
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, DB_PATH);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTodayEntries(db) {
  const today = todayStr();
  return db.entries.filter((e) => e.date === today);
}

// --- Request helpers ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

// --- API handlers ---

function handleGetState(req, res) {
  const db = readDb();
  const todayEntries = getTodayEntries(db);
  const totalKcal = todayEntries.reduce((sum, e) => sum + e.kcal, 0);
  sendJson(res, 200, {
    goalKcal: db.goalKcal,
    entries: todayEntries,
    totals: {
      consumed: totalKcal,
      remaining: db.goalKcal - totalKcal,
    },
  });
}

function handlePostGoal(req, res) {
  return parseBody(req).then((body) => {
    const goalKcal = Number(body.goalKcal);
    if (!Number.isFinite(goalKcal) || goalKcal <= 0) {
      return sendError(res, 400, 'goalKcal deve essere un numero positivo');
    }
    const db = readDb();
    db.goalKcal = Math.round(goalKcal);
    writeDbSync(db);
    handleGetState(req, res);
  });
}

function handlePostEntry(req, res) {
  return parseBody(req).then((body) => {
    const { meal, description, kcal } = body;
    if (!VALID_MEALS.includes(meal)) {
      return sendError(res, 400, `meal deve essere uno tra: ${VALID_MEALS.join(', ')}`);
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return sendError(res, 400, 'description non puo essere vuota');
    }
    const kcalNum = Number(kcal);
    if (!Number.isFinite(kcalNum) || kcalNum <= 0) {
      return sendError(res, 400, 'kcal deve essere un numero positivo');
    }
    const entry = {
      id: crypto.randomUUID(),
      date: todayStr(),
      meal,
      description: description.trim(),
      kcal: Math.round(kcalNum),
      createdAt: new Date().toISOString(),
    };
    const db = readDb();
    db.entries.push(entry);
    writeDbSync(db);
    handleGetState(req, res);
  });
}

function handleDeleteEntry(req, res, url) {
  const id = url.searchParams.get('id');
  if (!id) return sendError(res, 400, 'id mancante');
  const db = readDb();
  const idx = db.entries.findIndex((e) => e.id === id);
  if (idx === -1) return sendError(res, 404, 'Entry non trovata');
  db.entries.splice(idx, 1);
  writeDbSync(db);
  handleGetState(req, res);
}

function handleReset(req, res) {
  const today = todayStr();
  const db = readDb();
  db.entries = db.entries.filter((e) => e.date !== today);
  writeDbSync(db);
  handleGetState(req, res);
}

// --- Static file serving ---

function serveStatic(req, res, urlPath) {
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  filePath = path.normalize(filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// --- Router ---

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;
  const pathname = url.pathname;

  const handleError = (err) => {
    console.error(err);
    sendError(res, err.message === 'Invalid JSON' ? 400 : 500, err.message);
  };

  try {
    // API routes
    if (pathname === '/api/state' && method === 'GET') {
      return handleGetState(req, res);
    }
    if (pathname === '/api/goal' && method === 'POST') {
      return handlePostGoal(req, res).catch(handleError);
    }
    if (pathname === '/api/entries' && method === 'POST') {
      return handlePostEntry(req, res).catch(handleError);
    }
    if (pathname === '/api/entries' && method === 'DELETE') {
      return handleDeleteEntry(req, res, url);
    }
    if (pathname === '/api/reset' && method === 'POST') {
      return handleReset(req, res);
    }

    // Static files
    serveStatic(req, res, pathname);
  } catch (err) {
    handleError(err);
  }
});

server.listen(PORT, () => {
  console.log(`Calorie Tracker avviato su http://localhost:${PORT}`);
});
