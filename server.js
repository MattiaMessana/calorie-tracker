var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var PORT = process.env.PORT || 3000;
var DATA_DIR = path.join(__dirname, 'data');
var USERS_PATH = path.join(DATA_DIR, 'users.json');
var SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
var PUBLIC_DIR = path.join(__dirname, 'public');

var MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

var VALID_MEALS = ['colazione', 'pranzo', 'cena', 'spuntino'];
var SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
var USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// Rate limiter (in-memory, per IP)
// ============================================================
var rateLimitMap = {};
var RATE_WINDOW = 60 * 1000; // 1 min
var RATE_MAX_AUTH = 10;       // 10 auth attempts per minute

function rateLimit(ip, limit) {
  var now = Date.now();
  if (!rateLimitMap[ip] || rateLimitMap[ip].resetAt < now) {
    rateLimitMap[ip] = { count: 0, resetAt: now + RATE_WINDOW };
  }
  rateLimitMap[ip].count++;
  return rateLimitMap[ip].count > limit;
}

// Cleanup stale entries every 5 min
setInterval(function () {
  var now = Date.now();
  Object.keys(rateLimitMap).forEach(function (ip) {
    if (rateLimitMap[ip].resetAt < now) delete rateLimitMap[ip];
  });
}, 5 * 60 * 1000);

// ============================================================
// Security headers
// ============================================================
function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  };
}

// ============================================================
// Data helpers
// ============================================================
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(filePath, defaultValue) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    writeJsonFile(filePath, defaultValue);
    return JSON.parse(JSON.stringify(defaultValue));
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJsonFile(filePath, data) {
  ensureDataDir();
  var tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

// ============================================================
// Users
// ============================================================
function readUsers() {
  return readJsonFile(USERS_PATH, { users: [] });
}

function writeUsers(data) {
  writeJsonFile(USERS_PATH, data);
}

function findUserByUsername(username) {
  var db = readUsers();
  return db.users.find(function (u) {
    return u.username.toLowerCase() === username.toLowerCase();
  });
}

function findUserById(id) {
  var db = readUsers();
  return db.users.find(function (u) { return u.id === id; });
}

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  var hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash: hash, salt: salt };
}

function verifyPassword(password, hash, salt) {
  var result = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(result, 'hex'), Buffer.from(hash, 'hex'));
}

// ============================================================
// Sessions + CSRF
// ============================================================
function readSessions() {
  return readJsonFile(SESSIONS_PATH, { sessions: {} });
}

function writeSessions(data) {
  writeJsonFile(SESSIONS_PATH, data);
}

function createSession(userId) {
  var token = crypto.randomBytes(32).toString('hex');
  var csrfToken = crypto.randomBytes(32).toString('hex');
  var db = readSessions();
  db.sessions[token] = {
    userId: userId,
    csrfToken: csrfToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_MAX_AGE,
  };
  var now = Date.now();
  Object.keys(db.sessions).forEach(function (t) {
    if (db.sessions[t].expiresAt < now) delete db.sessions[t];
  });
  writeSessions(db);
  return { token: token, csrfToken: csrfToken };
}

function getSession(token) {
  if (!token) return null;
  var db = readSessions();
  var session = db.sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    delete db.sessions[token];
    writeSessions(db);
    return null;
  }
  return session;
}

function destroySession(token) {
  if (!token) return;
  var db = readSessions();
  delete db.sessions[token];
  writeSessions(db);
}

function parseCookies(req) {
  var cookies = {};
  var header = req.headers.cookie || '';
  header.split(';').forEach(function (c) {
    var parts = c.trim().split('=');
    if (parts.length >= 2) cookies[parts[0]] = parts.slice(1).join('=');
  });
  return cookies;
}

function getAuthUser(req) {
  var cookies = parseCookies(req);
  var token = cookies.session;
  var session = getSession(token);
  if (!session) return null;
  var user = findUserById(session.userId);
  if (!user) return null;
  return { user: user, token: token, csrfToken: session.csrfToken };
}

function verifyCsrf(req, auth) {
  var headerToken = req.headers['x-csrf-token'] || '';
  return headerToken === auth.csrfToken;
}

function sessionCookie(token, maxAge) {
  var parts = ['session=' + token, 'HttpOnly', 'Path=/', 'SameSite=Strict'];
  if (typeof maxAge === 'number') parts.push('Max-Age=' + maxAge);
  return parts.join('; ');
}

// ============================================================
// Per-user DB
// ============================================================
function userDbPath(userId) {
  var safe = userId.replace(/[^a-f0-9-]/gi, '');
  return path.join(DATA_DIR, 'user_' + safe + '.json');
}

function getDefaultUserDb() {
  return { goalKcal: 2200, entries: [] };
}

function readUserDb(userId) {
  return readJsonFile(userDbPath(userId), getDefaultUserDb());
}

function writeUserDb(userId, data) {
  writeJsonFile(userDbPath(userId), data);
}

// ============================================================
// Request helpers
// ============================================================
function parseBody(req) {
  return new Promise(function (resolve, reject) {
    var body = '';
    req.on('data', function (chunk) {
      body += chunk;
      if (body.length > 1e5) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', function () {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data, extraHeaders) {
  var headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, securityHeaders(), extraHeaders || {});
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function getTodayEntries(db) {
  var today = todayStr();
  return db.entries.filter(function (e) { return e.date === today; });
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

// Auth check + CSRF verify for mutating requests
function requireAuth(req, res, checkCsrf) {
  var auth = getAuthUser(req);
  if (!auth) {
    sendError(res, 401, 'Non autenticato');
    return null;
  }
  if (checkCsrf && !verifyCsrf(req, auth)) {
    sendError(res, 403, 'CSRF token non valido');
    return null;
  }
  return auth.user;
}

// ============================================================
// Route matching
// ============================================================
function matchRoute(method, pathname, pattern, reqMethod) {
  if (method !== reqMethod) return null;
  var patternParts = pattern.split('/');
  var pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  var params = {};
  for (var i = 0; i < patternParts.length; i++) {
    if (patternParts[i].charAt(0) === ':') {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ============================================================
// Auth API
// ============================================================
function handleRegister(req, res) {
  if (rateLimit(getClientIp(req), RATE_MAX_AUTH)) {
    return Promise.resolve(sendError(res, 429, 'Troppi tentativi, riprova tra un minuto'));
  }
  return parseBody(req).then(function (body) {
    var username = (body.username || '').trim();
    var password = body.password || '';
    var displayName = (body.displayName || username).trim();

    if (!USERNAME_RE.test(username)) {
      return sendError(res, 400, 'Username: 3-30 caratteri, solo lettere, numeri e _');
    }
    if (password.length < 6 || password.length > 128) {
      return sendError(res, 400, 'Password: da 6 a 128 caratteri');
    }
    if (displayName.length > 50) {
      return sendError(res, 400, 'Nome troppo lungo');
    }
    if (findUserByUsername(username)) {
      return sendError(res, 409, 'Username già in uso');
    }

    var hashed = hashPassword(password);
    var user = {
      id: crypto.randomUUID(),
      username: username.toLowerCase(),
      displayName: displayName,
      hash: hashed.hash,
      salt: hashed.salt,
      createdAt: new Date().toISOString(),
    };

    var db = readUsers();
    db.users.push(user);
    writeUsers(db);
    writeUserDb(user.id, getDefaultUserDb());

    var sess = createSession(user.id);
    sendJson(res, 201, {
      ok: true,
      user: { id: user.id, username: user.username, displayName: user.displayName },
      csrfToken: sess.csrfToken,
    }, { 'Set-Cookie': sessionCookie(sess.token, 7 * 24 * 3600) });
  });
}

function handleLogin(req, res) {
  if (rateLimit(getClientIp(req), RATE_MAX_AUTH)) {
    return Promise.resolve(sendError(res, 429, 'Troppi tentativi, riprova tra un minuto'));
  }
  return parseBody(req).then(function (body) {
    var username = (body.username || '').trim().toLowerCase();
    var password = body.password || '';

    var user = findUserByUsername(username);
    if (!user || !verifyPassword(password, user.hash, user.salt)) {
      return sendError(res, 401, 'Credenziali non valide');
    }

    var sess = createSession(user.id);
    sendJson(res, 200, {
      ok: true,
      user: { id: user.id, username: user.username, displayName: user.displayName },
      csrfToken: sess.csrfToken,
    }, { 'Set-Cookie': sessionCookie(sess.token, 7 * 24 * 3600) });
  });
}

function handleLogout(req, res) {
  var auth = getAuthUser(req);
  if (auth) destroySession(auth.token);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}

function handleMe(req, res) {
  var auth = getAuthUser(req);
  if (!auth) return sendError(res, 401, 'Non autenticato');
  sendJson(res, 200, {
    user: { id: auth.user.id, username: auth.user.username, displayName: auth.user.displayName },
    csrfToken: auth.csrfToken,
  });
}

// ============================================================
// Calorie API (authenticated, CSRF-protected)
// ============================================================
function handleGetState(req, res) {
  var user = requireAuth(req, res, false);
  if (!user) return;
  var db = readUserDb(user.id);
  var todayEntries = getTodayEntries(db);
  var totalKcal = todayEntries.reduce(function (sum, e) { return sum + e.kcal; }, 0);
  sendJson(res, 200, {
    goalKcal: db.goalKcal,
    entries: todayEntries,
    totals: { consumed: totalKcal, remaining: db.goalKcal - totalKcal },
  });
}

function handlePostGoal(req, res) {
  var user = requireAuth(req, res, true);
  if (!user) return;
  return parseBody(req).then(function (body) {
    var goalKcal = Number(body.goalKcal);
    if (!Number.isFinite(goalKcal) || goalKcal <= 0 || goalKcal > 99999) {
      return sendError(res, 400, 'goalKcal deve essere un numero tra 1 e 99999');
    }
    var db = readUserDb(user.id);
    db.goalKcal = Math.round(goalKcal);
    writeUserDb(user.id, db);
    handleGetState(req, res);
  });
}

function handlePostEntry(req, res) {
  var user = requireAuth(req, res, true);
  if (!user) return;
  return parseBody(req).then(function (body) {
    var meal = body.meal;
    var description = body.description;
    var kcal = body.kcal;
    if (!VALID_MEALS.includes(meal)) {
      return sendError(res, 400, 'meal deve essere uno tra: ' + VALID_MEALS.join(', '));
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return sendError(res, 400, 'description non può essere vuota');
    }
    if (typeof description === 'string' && description.length > 200) {
      return sendError(res, 400, 'description troppo lunga (max 200 caratteri)');
    }
    var kcalNum = Number(kcal);
    if (!Number.isFinite(kcalNum) || kcalNum <= 0 || kcalNum > 99999) {
      return sendError(res, 400, 'kcal deve essere un numero tra 1 e 99999');
    }
    var entry = {
      id: crypto.randomUUID(),
      date: todayStr(),
      meal: meal,
      description: description.trim(),
      kcal: Math.round(kcalNum),
      createdAt: new Date().toISOString(),
    };
    var db = readUserDb(user.id);
    db.entries.push(entry);
    writeUserDb(user.id, db);
    handleGetState(req, res);
  });
}

function handleDeleteEntry(req, res, entryId) {
  var user = requireAuth(req, res, true);
  if (!user) return;
  if (!UUID_RE.test(entryId)) return sendError(res, 400, 'ID non valido');
  var db = readUserDb(user.id);
  var idx = db.entries.findIndex(function (e) { return e.id === entryId; });
  if (idx === -1) return sendError(res, 404, 'Entry non trovata');
  db.entries.splice(idx, 1);
  writeUserDb(user.id, db);
  handleGetState(req, res);
}

function handleReset(req, res) {
  var user = requireAuth(req, res, true);
  if (!user) return;
  var today = todayStr();
  var db = readUserDb(user.id);
  db.entries = db.entries.filter(function (e) { return e.date !== today; });
  writeUserDb(user.id, db);
  handleGetState(req, res);
}

// ============================================================
// Static + page routes
// ============================================================
function serveFile(res, filePath) {
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, securityHeaders());
    return res.end('Forbidden');
  }
  var ext = path.extname(filePath);
  var contentType = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, securityHeaders());
      res.end('Not found');
      return;
    }
    var headers = Object.assign({ 'Content-Type': contentType }, securityHeaders());
    // Cache static assets (not HTML)
    if (ext !== '.html') headers['Cache-Control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    res.end(data);
  });
}

// Clean page routes (no extensions)
var PAGE_ROUTES = {
  '/': 'index.html',
  '/login': 'auth.html',
};

// ============================================================
// Router
// ============================================================
var server = http.createServer(function (req, res) {
  var parsedUrl;
  try {
    parsedUrl = new URL(req.url, 'http://localhost:' + PORT);
  } catch (e) {
    res.writeHead(400, securityHeaders());
    return res.end('Bad request');
  }
  var method = req.method;
  var pathname = parsedUrl.pathname;

  // Remove trailing slash (except root)
  if (pathname.length > 1 && pathname.charAt(pathname.length - 1) === '/') {
    pathname = pathname.slice(0, -1);
  }

  var handleError = function (err) {
    console.error(err);
    sendError(res, err.message === 'Invalid JSON' ? 400 : 500, 'Errore interno');
  };

  try {
    // ---- Auth API ----
    if (pathname === '/api/register' && method === 'POST') {
      return handleRegister(req, res).catch(handleError);
    }
    if (pathname === '/api/login' && method === 'POST') {
      return handleLogin(req, res).catch(handleError);
    }
    if (pathname === '/api/logout' && method === 'POST') {
      return handleLogout(req, res);
    }
    if (pathname === '/api/me' && method === 'GET') {
      return handleMe(req, res);
    }

    // ---- Calorie API ----
    if (pathname === '/api/state' && method === 'GET') {
      return handleGetState(req, res);
    }
    if (pathname === '/api/goal' && method === 'POST') {
      return handlePostGoal(req, res).catch(handleError);
    }
    if (pathname === '/api/entries' && method === 'POST') {
      return handlePostEntry(req, res).catch(handleError);
    }
    if (pathname === '/api/reset' && method === 'POST') {
      return handleReset(req, res);
    }

    // DELETE /api/entries/:id
    var deleteMatch = matchRoute(method, pathname, '/api/entries/:id', 'DELETE');
    if (deleteMatch) {
      return handleDeleteEntry(req, res, deleteMatch.id);
    }

    // ---- Page routes (clean URLs) ----
    if (PAGE_ROUTES[pathname] && method === 'GET') {
      return serveFile(res, path.join(PUBLIC_DIR, PAGE_ROUTES[pathname]));
    }

    // ---- Static assets (css, js, images) ----
    if (method === 'GET') {
      // Block direct access to .html files (force clean URLs)
      if (path.extname(pathname) === '.html') {
        res.writeHead(404, securityHeaders());
        return res.end('Not found');
      }
      return serveFile(res, path.join(PUBLIC_DIR, pathname));
    }

    // Fallback
    res.writeHead(404, securityHeaders());
    res.end('Not found');
  } catch (err) {
    handleError(err);
  }
});

server.listen(PORT, function () {
  console.log('Calorie Tracker avviato su http://localhost:' + PORT);
});
