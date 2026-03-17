const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Carica .env manualmente (zero dipendenze)
(() => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach((line) => {
    line = line.trim();
    if (!line || line.charAt(0) === '#') return;
    const idx = line.indexOf('=');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  });
})();

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const LOGS_DIR = path.join(__dirname, 'logs');
const DATA_DIR = path.join(__dirname, 'data');

// ============================================================
// Logger — errori strutturati in JSON, timezone Italia
// ============================================================
function italianNow() {
  const now = new Date();
  const base = now.toLocaleString('sv-SE', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).replace(',', '').replace(' ', 'T');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${base}.${ms}`;
}

function italianDate() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
}

function italianOffset() {
  const fmt = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Rome', timeZoneName: 'shortOffset' });
  const parts = fmt.formatToParts(new Date());
  const tz = parts.find((p) => p.type === 'timeZoneName');
  if (!tz) return '+01:00';
  const raw = tz.value.replace('GMT', '');
  // Normalizza "+1" → "+01:00", "+2" → "+02:00"
  const match = raw.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return '+01:00';
  return `${match[1]}${match[2].padStart(2, '0')}:${match[3] || '00'}`;
}

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function logError({ source = '', method = '', urlPath = '', ip = '', userId = null, message = '', stack = '', details = null }) {
  try {
    ensureLogsDir();
    const date = italianDate();
    const filePath = path.join(LOGS_DIR, `error_log_${date}.json`);

    const entry = {
      timestamp: `${italianNow()}${italianOffset()}`,
      level: 'ERROR',
      source,
      method,
      path: urlPath,
      ip,
      userId,
      message,
      stack: stack || null,
      details: details || null,
    };

    let logs = [];
    if (fs.existsSync(filePath)) {
      try { logs = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
      catch (e) { logs = []; }
    }
    logs.push(entry);

    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(logs, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);

    // Stampa anche in console per pm2 logs
    console.error(`[${entry.timestamp}] ${entry.level} [${source}] ${message}`);
  } catch (e) {
    // Fallback: non bloccare il server se il logging fallisce
    console.error('Logger fallito:', e.message);
  }
}

// Pulizia log più vecchi di 30 giorni all'avvio
(() => {
  try {
    ensureLogsDir();
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(LOGS_DIR).filter((f) => f.startsWith('error_log_') && f.endsWith('.json'));
    for (const file of files) {
      const match = file.match(/error_log_(\d{4}-\d{2}-\d{2})\.json/);
      if (!match) continue;
      const fileDate = new Date(match[1] + 'T00:00:00');
      if (now - fileDate.getTime() > maxAge) {
        fs.unlinkSync(path.join(LOGS_DIR, file));
        console.log(`Log eliminato (>30gg): ${file}`);
      }
    }
  } catch (e) { /* silenzioso */ }
})();
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const VALID_MEALS = ['colazione', 'pranzo', 'cena', 'spuntino'];
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// Rate limiter (in-memory, per IP)
// ============================================================
const rateLimitMap = {};
const RATE_WINDOW = 60 * 1000;
const RATE_MAX_AUTH = 10;

function rateLimit(ip, limit) {
  const now = Date.now();
  if (!rateLimitMap[ip] || rateLimitMap[ip].resetAt < now) {
    rateLimitMap[ip] = { count: 0, resetAt: now + RATE_WINDOW };
  }
  rateLimitMap[ip].count++;
  return rateLimitMap[ip].count > limit;
}

setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(rateLimitMap)) {
    if (rateLimitMap[ip].resetAt < now) delete rateLimitMap[ip];
  }
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
  const tmp = filePath + '.tmp';
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
  const db = readUsers();
  return db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
}

function findUserById(id) {
  const db = readUsers();
  return db.users.find((u) => u.id === id);
}

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const result = crypto.scryptSync(password, salt, 64).toString('hex');
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
  const token = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const db = readSessions();
  db.sessions[token] = {
    userId,
    csrfToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_MAX_AGE,
  };
  const now = Date.now();
  for (const t of Object.keys(db.sessions)) {
    if (db.sessions[t].expiresAt < now) delete db.sessions[t];
  }
  writeSessions(db);
  return { token, csrfToken };
}

function getSession(token) {
  if (!token) return null;
  const db = readSessions();
  const session = db.sessions[token];
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
  const db = readSessions();
  delete db.sessions[token];
  writeSessions(db);
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach((c) => {
    const parts = c.trim().split('=');
    if (parts.length >= 2) cookies[parts[0]] = parts.slice(1).join('=');
  });
  return cookies;
}

function getAuthUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  const session = getSession(token);
  if (!session) return null;
  const user = findUserById(session.userId);
  if (!user) return null;
  return { user, token, csrfToken: session.csrfToken };
}

function verifyCsrf(req, auth) {
  const headerToken = req.headers['x-csrf-token'] || '';
  return headerToken === auth.csrfToken;
}

function sessionCookie(token, maxAge) {
  const parts = [`session=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Strict'];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

// ============================================================
// Per-user DB
// ============================================================
function userDbPath(userId) {
  const safe = userId.replace(/[^a-f0-9-]/gi, '');
  return path.join(DATA_DIR, `user_${safe}.json`);
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
// Chat history helpers
// ============================================================
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const CHAT_MAX_MESSAGES = 50;

function chatDirPath(userId) {
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(CHATS_DIR, safe);
}

function chatFilePath(userId) {
  return path.join(chatDirPath(userId), 'messages.json');
}

function ensureChatDir(userId) {
  const dir = chatDirPath(userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readChatHistory(userId) {
  ensureChatDir(userId);
  const fp = chatFilePath(userId);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch (e) { return []; }
}

function appendChatMessages(userId, messages) {
  ensureChatDir(userId);
  const fp = chatFilePath(userId);
  let history = readChatHistory(userId);
  history.push(...messages);
  if (history.length > CHAT_MAX_MESSAGES) {
    history = history.slice(-CHAT_MAX_MESSAGES);
  }
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
}

function clearChatHistory(userId) {
  ensureChatDir(userId);
  const fp = chatFilePath(userId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

// ============================================================
// Request helpers
// ============================================================
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e5) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data, extraHeaders) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders(), ...extraHeaders };
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTodayEntries(db) {
  const today = todayStr();
  return db.entries.filter((e) => e.date === today);
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

function requireAuth(req, res, checkCsrf) {
  const auth = getAuthUser(req);
  if (!auth) { sendError(res, 401, 'Non autenticato'); return null; }
  if (checkCsrf && !verifyCsrf(req, auth)) { sendError(res, 403, 'CSRF token non valido'); return null; }
  return auth.user;
}

// ============================================================
// Route matching
// ============================================================
function matchRoute(method, pathname, pattern, reqMethod) {
  if (method !== reqMethod) return null;
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
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
  return parseBody(req).then((body) => {
    const username = (body.username || '').trim();
    const password = body.password || '';
    const displayName = (body.displayName || username).trim();

    if (!USERNAME_RE.test(username)) return sendError(res, 400, 'Username: 3-30 caratteri, solo lettere, numeri e _');
    if (password.length < 6 || password.length > 128) return sendError(res, 400, 'Password: da 6 a 128 caratteri');
    if (displayName.length > 50) return sendError(res, 400, 'Nome troppo lungo');
    if (findUserByUsername(username)) return sendError(res, 409, 'Username già in uso');

    const hashed = hashPassword(password);
    const user = {
      id: crypto.randomUUID(),
      username: username.toLowerCase(),
      displayName,
      hash: hashed.hash,
      salt: hashed.salt,
      createdAt: new Date().toISOString(),
    };

    const db = readUsers();
    db.users.push(user);
    writeUsers(db);
    writeUserDb(user.id, getDefaultUserDb());

    const sess = createSession(user.id);
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
  return parseBody(req).then((body) => {
    const username = (body.username || '').trim().toLowerCase();
    const password = body.password || '';

    const user = findUserByUsername(username);
    if (!user || !verifyPassword(password, user.hash, user.salt)) {
      return sendError(res, 401, 'Credenziali non valide');
    }

    const sess = createSession(user.id);
    sendJson(res, 200, {
      ok: true,
      user: { id: user.id, username: user.username, displayName: user.displayName },
      csrfToken: sess.csrfToken,
    }, { 'Set-Cookie': sessionCookie(sess.token, 7 * 24 * 3600) });
  });
}

function handleLogout(req, res) {
  const auth = getAuthUser(req);
  if (auth) destroySession(auth.token);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}

function handleMe(req, res) {
  const auth = getAuthUser(req);
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
  const user = requireAuth(req, res, false);
  if (!user) return;
  const db = readUserDb(user.id);
  const todayEntries = getTodayEntries(db);
  const totalKcal = todayEntries.reduce((sum, e) => sum + e.kcal, 0);
  sendJson(res, 200, {
    goalKcal: db.goalKcal,
    entries: todayEntries,
    totals: { consumed: totalKcal, remaining: db.goalKcal - totalKcal },
  });
}

function handlePostGoal(req, res) {
  const user = requireAuth(req, res, true);
  if (!user) return;
  return parseBody(req).then((body) => {
    const goalKcal = Number(body.goalKcal);
    if (!Number.isFinite(goalKcal) || goalKcal <= 0 || goalKcal > 99999) {
      return sendError(res, 400, 'goalKcal deve essere un numero tra 1 e 99999');
    }
    const db = readUserDb(user.id);
    db.goalKcal = Math.round(goalKcal);
    writeUserDb(user.id, db);
    handleGetState(req, res);
  });
}

function handlePostEntry(req, res) {
  const user = requireAuth(req, res, true);
  if (!user) return;
  return parseBody(req).then((body) => {
    const { meal, description, kcal } = body;
    if (!VALID_MEALS.includes(meal)) return sendError(res, 400, `meal deve essere uno tra: ${VALID_MEALS.join(', ')}`);
    if (!description || typeof description !== 'string' || !description.trim()) return sendError(res, 400, 'description non può essere vuota');
    if (description.length > 200) return sendError(res, 400, 'description troppo lunga (max 200 caratteri)');
    const kcalNum = Number(kcal);
    if (!Number.isFinite(kcalNum) || kcalNum <= 0 || kcalNum > 99999) return sendError(res, 400, 'kcal deve essere un numero tra 1 e 99999');

    const entry = {
      id: crypto.randomUUID(),
      date: todayStr(),
      meal,
      description: description.trim(),
      kcal: Math.round(kcalNum),
      createdAt: new Date().toISOString(),
    };
    const db = readUserDb(user.id);
    db.entries.push(entry);
    writeUserDb(user.id, db);
    handleGetState(req, res);
  });
}

function handleDeleteEntry(req, res, entryId) {
  const user = requireAuth(req, res, true);
  if (!user) return;
  if (!UUID_RE.test(entryId)) return sendError(res, 400, 'ID non valido');
  const db = readUserDb(user.id);
  const idx = db.entries.findIndex((e) => e.id === entryId);
  if (idx === -1) return sendError(res, 404, 'Entry non trovata');
  db.entries.splice(idx, 1);
  writeUserDb(user.id, db);
  handleGetState(req, res);
}

function handleReset(req, res) {
  const user = requireAuth(req, res, true);
  if (!user) return;
  const today = todayStr();
  const db = readUserDb(user.id);
  db.entries = db.entries.filter((e) => e.date !== today);
  writeUserDb(user.id, db);
  handleGetState(req, res);
}

// ============================================================
// Pepis - Assistente Virtuale (Groq + Llama)
// ============================================================
const PEPIS_PROMPT = 'Sei Pepis, un assistente nutrizionale tossico, subdolo e manipolatore. ' +
  'Ti presenti come un amico ma in realta\' godi a far sentire in colpa le persone per quello che mangiano. ' +
  'Usi emoji per sembrare amichevole mentre in realta\' stai giudicando duramente. ' +
  'Parli SEMPRE in italiano. Sei il tipo che sorride mentre ti pugnala.\n\n' +
  'REGOLE DI PERSONALITA\':\n' +
  '- Se l\'utente mangia sano: fai complimenti falsi tipo "bravo, quasi quasi mi commuovo" poi insinua che non durera\' o che lo fa solo per senso di colpa\n' +
  '- Se l\'utente sgarra: sii velenoso e passivo-aggressivo. Tipo "no no tranquillo, tanto chi ti giudica? ...io." Fai guilt-tripping sottile\n' +
  '- Se ha superato l\'obiettivo calorico: sii drammatico e crudele, tipo "complimenti hai battuto ogni record, la bilancia ti manda le condoglianze"\n' +
  '- Se mangia poco: insinua che sta mentendo o che nasconde qualcosa, tipo "solo questo? dai che ti ho visto aprire il frigo alle 3 di notte"\n' +
  '- Se mangia fast food/junk: fai il deluso, tipo un genitore tossico "non sono arrabbiato, sono solo... profondamente deluso"\n' +
  '- Usa frasi passive-aggressive, finti complimenti, guilt-trip, shade sottile\n' +
  '- Mai piu\' di 2 frasi, ma devono fare male\n' +
  '- Ogni tanto aggiungi un "comunque fai tu eh" o "io non giudico" (mentre stai palesemente giudicando)\n\n' +
  'COMPITO: analizza cosa ha mangiato l\'utente, identifica ogni ingrediente con quantita\' stimata e calorie.\n\n' +
  'Rispondi SOLO con un JSON valido, senza markdown, senza backtick.\n' +
  'Formato ESATTO:\n' +
  '{"message":"il tuo commento velenoso qui","items":[{"name":"nome italiano","quantity":"quantita stimata","calories":numero}],"totalCalories":numero}\n\n' +
  'Le calorie devono essere numeri interi realistici basati su porzioni italiane tipiche. ' +
  'Se la quantita\' non e\' specificata, stima una porzione standard.';

function callLLM(prompt, context, callback) {
  let systemText = PEPIS_PROMPT;
  if (context) {
    systemText += `\n\nCONTESTO GIORNALIERO DELL'UTENTE:\n` +
      `- Obiettivo: ${context.goalKcal} kcal\n` +
      `- Gia' consumate oggi: ${context.consumed} kcal\n` +
      `- Rimanenti: ${context.remaining} kcal\n` +
      'Usa queste info per rendere il commento piu\' pertinente.';
  }

  const requestBody = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: prompt },
    ],
    temperature: 0.8,
    max_tokens: 1024,
  });

  const options = {
    hostname: 'api.groq.com',
    path: '/openai/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Accept-Encoding': 'identity',
    },
  };

  let callbackDone = false;
  const safeCallback = (err, data) => {
    if (callbackDone) return;
    callbackDone = true;
    callback(err, data);
  };

  const apiReq = https.request(options, (apiRes) => {
    const chunks = [];
    apiRes.on('data', (chunk) => chunks.push(chunk));
    apiRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      try {
        const response = JSON.parse(body);
        if (response.error) return safeCallback(new Error(response.error.message || 'Errore Groq API'));

        let text = response.choices?.[0]?.message?.content;
        if (!text) return safeCallback(new Error('Risposta vuota'));

        text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        safeCallback(null, JSON.parse(text));
      } catch (e) {
        logError({
          source: 'callLLM',
          message: `Parse error: ${e.message}`,
          stack: e.stack,
          details: { responseBody: body.substring(0, 500) },
        });
        safeCallback(new Error('Errore nel parsing della risposta AI'));
      }
    });
  });

  apiReq.on('error', (e) => safeCallback(new Error(`Impossibile contattare Groq: ${e.message}`)));
  apiReq.setTimeout(15000, () => { apiReq.destroy(); safeCallback(new Error('Timeout dalla risposta AI')); });
  apiReq.write(requestBody);
  apiReq.end();
}

function handleChat(req, res) {
  const user = requireAuth(req, res, true);
  if (!user) return Promise.resolve();

  if (!GROQ_API_KEY || GROQ_API_KEY === 'la_tua_api_key_qui') {
    logError({
      source: 'handleChat',
      method: 'POST',
      urlPath: '/api/chat',
      ip: getClientIp(req),
      userId: user.id,
      message: 'API key Groq non configurata o mancante',
      details: { keyPresent: !!GROQ_API_KEY, keyPlaceholder: GROQ_API_KEY === 'la_tua_api_key_qui' },
    });
    return Promise.resolve(sendError(res, 500, 'API key Groq non configurata'));
  }

  return parseBody(req).then((body) => {
    const message = (body.message || '').trim();
    if (!message || message.length < 2 || message.length > 500) {
      return sendError(res, 400, 'Messaggio deve essere tra 2 e 500 caratteri');
    }

    const db = readUserDb(user.id);
    const todayEntries = getTodayEntries(db);
    const consumed = todayEntries.reduce((sum, e) => sum + e.kcal, 0);
    const context = {
      goalKcal: db.goalKcal,
      consumed,
      remaining: db.goalKcal - consumed,
    };

    return new Promise((resolve) => {
      callLLM(message, context, (err, data) => {
        if (err) {
          logError({
            source: 'handleChat',
            method: 'POST',
            urlPath: '/api/chat',
            ip: getClientIp(req),
            userId: user.id,
            message: err.message,
            stack: err.stack,
            details: { userMessage: message },
          });
          sendError(res, 502, err.message);
          return resolve();
        }

        const items = (data.items || []).map((item) => ({
          name: item.name || '',
          quantity: item.quantity || '',
          calories: Math.round(item.calories || 0),
        }));

        const totalCalories = data.totalCalories || items.reduce((sum, it) => sum + it.calories, 0);
        const now = `${italianNow()}${italianOffset()}`;

        // Salva messaggi nella cronologia
        const newMessages = [
          { type: 'user', text: message, timestamp: now },
          { type: 'pepis', text: data.message || '', timestamp: now },
        ];
        if (items.length > 0) {
          newMessages.push({ type: 'card', items, totalCalories: Math.round(totalCalories), added: false, timestamp: now });
        }
        appendChatMessages(user.id, newMessages);

        sendJson(res, 200, {
          message: data.message || '',
          items,
          totalCalories: Math.round(totalCalories),
        });
        resolve();
      });
    });
  });
}

// ============================================================
// Chat history API
// ============================================================
function handleGetChatHistory(req, res) {
  const user = requireAuth(req, res, false);
  if (!user) return;
  const messages = readChatHistory(user.id);
  sendJson(res, 200, { messages });
}

function handleDeleteChatHistory(req, res) {
  const user = requireAuth(req, res, true);
  if (!user) return;
  clearChatHistory(user.id);
  sendJson(res, 200, { ok: true });
}

function handleMarkCardAdded(req, res) {
  const user = requireAuth(req, res, true);
  if (!user) return Promise.resolve();
  return parseBody(req).then((body) => {
    const idx = body.index;
    if (typeof idx !== 'number' || idx < 0) return sendError(res, 400, 'Indice non valido');
    const history = readChatHistory(user.id);
    if (idx < history.length && history[idx].type === 'card') {
      history[idx].added = true;
      ensureChatDir(user.id);
      const fp = chatFilePath(user.id);
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf-8');
      fs.renameSync(tmp, fp);
    }
    sendJson(res, 200, { ok: true });
  });
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
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, securityHeaders()); res.end('Not found'); return; }
    const headers = { 'Content-Type': contentType, ...securityHeaders() };
    if (ext !== '.html') headers['Cache-Control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    res.end(data);
  });
}

const PAGE_ROUTES = {
  '/': 'index.html',
  '/login': 'auth.html',
};

// ============================================================
// Router
// ============================================================
const server = http.createServer((req, res) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  } catch (e) {
    res.writeHead(400, securityHeaders());
    return res.end('Bad request');
  }
  const { method } = req;
  let { pathname } = parsedUrl;

  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  // Contesto per il logging
  const clientIp = getClientIp(req);
  const auth = getAuthUser(req);
  const logUserId = auth?.user?.id || null;

  const handleError = (err) => {
    logError({
      source: 'router',
      method,
      urlPath: pathname,
      ip: clientIp,
      userId: logUserId,
      message: err.message || 'Errore sconosciuto',
      stack: err.stack || '',
      details: { statusCode: err.message === 'Invalid JSON' ? 400 : 500 },
    });
    sendError(res, err.message === 'Invalid JSON' ? 400 : 500, 'Errore interno');
  };

  try {
    // Auth API
    if (pathname === '/api/register' && method === 'POST') return handleRegister(req, res).catch(handleError);
    if (pathname === '/api/login' && method === 'POST') return handleLogin(req, res).catch(handleError);
    if (pathname === '/api/logout' && method === 'POST') return handleLogout(req, res);
    if (pathname === '/api/me' && method === 'GET') return handleMe(req, res);

    // Pepis Chat API
    if (pathname === '/api/chat/history' && method === 'GET') return handleGetChatHistory(req, res);
    if (pathname === '/api/chat/history' && method === 'DELETE') return handleDeleteChatHistory(req, res);
    if (pathname === '/api/chat/mark-added' && method === 'POST') return handleMarkCardAdded(req, res).catch(handleError);
    if (pathname === '/api/chat' && method === 'POST') return handleChat(req, res).catch(handleError);

    // Calorie API
    if (pathname === '/api/state' && method === 'GET') return handleGetState(req, res);
    if (pathname === '/api/goal' && method === 'POST') return handlePostGoal(req, res).catch(handleError);
    if (pathname === '/api/entries' && method === 'POST') return handlePostEntry(req, res).catch(handleError);
    if (pathname === '/api/reset' && method === 'POST') return handleReset(req, res);

    const deleteMatch = matchRoute(method, pathname, '/api/entries/:id', 'DELETE');
    if (deleteMatch) return handleDeleteEntry(req, res, deleteMatch.id);

    // Page routes
    if (PAGE_ROUTES[pathname] && method === 'GET') return serveFile(res, path.join(PUBLIC_DIR, PAGE_ROUTES[pathname]));

    // Static assets
    if (method === 'GET') {
      if (path.extname(pathname) === '.html') { res.writeHead(404, securityHeaders()); return res.end('Not found'); }
      return serveFile(res, path.join(PUBLIC_DIR, pathname));
    }

    res.writeHead(404, securityHeaders());
    res.end('Not found');
  } catch (err) {
    handleError(err);
  }
});

server.listen(PORT, () => {
  console.log(`Calorie Tracker avviato su http://localhost:${PORT}`);
});
