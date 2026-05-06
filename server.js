'use strict';

const path = require('path');
const crypto = require('crypto');
const { execFile, execSync } = require('child_process');
const http = require('http');

const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const nunjucks = require('nunjucks');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT       = parseInt(process.env.PORT || '5000');
const SECRET_KEY = process.env.SECRET_KEY || 'dev-only-change-in-production';
const DB_PATH    = process.env.DB_PATH || path.join(__dirname, 'platform.db');

// ── Template engine ───────────────────────────────────────────────────────────
nunjucks.configure(path.join(__dirname, 'templates'), { autoescape: true, express: app });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(session({
  secret: SECRET_KEY,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT    UNIQUE NOT NULL,
    password TEXT    NOT NULL,
    email    TEXT    DEFAULT '',
    is_admin INTEGER DEFAULT 0,
    created_at TEXT  DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    user_type   TEXT DEFAULT 'user',
    logged_in_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS questions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT NOT NULL,
    description     TEXT DEFAULT '',
    expected_output TEXT NOT NULL,
    time_limit      INTEGER DEFAULT 0,
    max_points      REAL DEFAULT 10,
    created_by      TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now')),
    is_active       INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS scoring_criteria (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id     INTEGER DEFAULT NULL,
    min_similarity  REAL NOT NULL,
    score           REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL,
    question_id     INTEGER NOT NULL,
    room_id         TEXT DEFAULT '',
    code            TEXT NOT NULL,
    output          TEXT NOT NULL,
    expected_output TEXT NOT NULL,
    similarity      REAL DEFAULT 0,
    score           REAL DEFAULT 0,
    max_score       REAL DEFAULT 0,
    submitted_at    TEXT DEFAULT (datetime('now'))
  );
`);

// Migrate existing users table (add columns if missing)
try { db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN created_at TEXT DEFAULT (datetime('now'))`); } catch {}

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashPw(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }

function lookupUser(username, password) {
  return db.prepare('SELECT * FROM users WHERE username=? AND password=?')
    .get(username, hashPw(password));
}

function createUser(username, password, email = '') {
  const isFirst = db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0;
  try {
    db.prepare('INSERT INTO users (username, password, email, is_admin) VALUES (?,?,?,?)')
      .run(username, hashPw(password), email, isFirst ? 1 : 0);
    return true;
  } catch { return false; }
}

function currentUser(req) { return req.session.username || null; }

function getIsAdmin(req) {
  const u = req.session.username;
  if (!u || req.session.user_type === 'guest') return false;
  const row = db.prepare('SELECT is_admin FROM users WHERE username=?').get(u);
  return !!(row && row.is_admin);
}

const rooms = {};

function genRoomId() {
  let id;
  do { id = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'); } while (rooms[id]);
  return id;
}

function genGuestName() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const s = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `Guest_${s}`;
}

// ── Python detection ──────────────────────────────────────────────────────────
function findPython() {
  const candidates = process.platform === 'win32'
    ? [{ cmd: 'py', args: ['-3'] }, { cmd: 'python3', args: [] }, { cmd: 'python', args: [] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
  for (const e of candidates) {
    try {
      const out = execSync(`${e.cmd} ${[...e.args, '--version'].join(' ')}`, { timeout: 5000, stdio: 'pipe' }).toString();
      if (out.includes('Python 3')) return e;
    } catch {}
  }
  return null;
}
const PYTHON = findPython();
if (!PYTHON) console.warn('WARNING: Python 3 not found — code execution will fail.');

function runPython(code, cb) {
  if (!PYTHON) { cb(new Error('Python not found'), '', ''); return; }
  execFile(PYTHON.cmd, [...PYTHON.args, '-c', code], { timeout: 15_000, windowsHide: true }, cb);
}

// ── Scoring ───────────────────────────────────────────────────────────────────
function stringSimilarity(a, b) {
  a = a.trim().replace(/\r\n/g, '\n');
  b = b.trim().replace(/\r\n/g, '\n');
  if (a === b) return 1.0;
  if (!a.length || !b.length) return 0.0;
  const m = a.length, n = b.length;
  if (m > 3000 || n > 3000) {
    // Fast approximate for very long strings
    const shorter = m < n ? a : b;
    const longer  = m < n ? b : a;
    let hits = 0;
    for (const ch of shorter) if (longer.includes(ch)) hits++;
    return hits / Math.max(m, n);
  }
  const prev = new Array(n + 1).fill(0).map((_, j) => j);
  const curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i-1] === b[j-1]
        ? prev[j-1]
        : 1 + Math.min(prev[j-1], prev[j], curr[j-1]);
    }
    prev.splice(0, n+1, ...curr);
  }
  return 1 - prev[n] / Math.max(m, n);
}

function calcScore(actualOutput, expectedOutput, questionId) {
  const sim = stringSimilarity(actualOutput, expectedOutput);
  let criteria = db.prepare(
    'SELECT * FROM scoring_criteria WHERE question_id=? ORDER BY min_similarity DESC'
  ).all(questionId);
  if (!criteria.length) {
    criteria = db.prepare(
      'SELECT * FROM scoring_criteria WHERE question_id IS NULL ORDER BY min_similarity DESC'
    ).all();
  }
  for (const c of criteria) {
    if (sim >= c.min_similarity) return { sim, score: c.score };
  }
  return { sim, score: 0 };
}

// ── Route guards ──────────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (!currentUser(req)) return res.redirect('/');
  next();
};
const requireRegistered = (req, res, next) => {
  if (!currentUser(req)) return res.redirect('/');
  if (req.session.user_type === 'guest') {
    req.session.authError = 'A registered account is required for this page.';
    return res.redirect('/');
  }
  next();
};

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const err = req.session.authError || null;
  delete req.session.authError;
  res.render('index.html', {
    username:  currentUser(req),
    user_type: req.session.user_type,
    is_admin:  getIsAdmin(req),
    error: err || null,
  });
});

app.get('/register', (req, res) => res.render('register.html'));

app.post('/register', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const email    = (req.body.email || '').trim();
  if (!username || !password)
    return res.render('register.html', { error: 'Username and password required.' });
  if (!createUser(username, password, email))
    return res.render('register.html', { error: 'Username already taken.' });
  req.session.username  = username;
  req.session.user_type = 'user';
  db.prepare('INSERT INTO user_sessions (username, user_type) VALUES (?,?)').run(username, 'user');
  return res.redirect('/');
});

app.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const user = lookupUser(username, password);
  if (user) {
    req.session.username  = user.username;
    req.session.user_type = 'user';
    db.prepare('INSERT INTO user_sessions (username, user_type) VALUES (?,?)').run(user.username, 'user');
    return res.redirect('/');
  }
  return res.render('index.html', { error: 'Invalid username or password.' });
});

app.post('/guest', (req, res) => {
  const name = genGuestName();
  req.session.username  = name;
  req.session.user_type = 'guest';
  db.prepare('INSERT INTO user_sessions (username, user_type) VALUES (?,?)').run(name, 'guest');
  return res.redirect('/');
});

app.get('/logout', (req, res) => { req.session.destroy(); return res.redirect('/'); });

app.post('/create_room', requireAuth, (req, res) => {
  const roomId = genRoomId();
  rooms[roomId] = {
    code: '# Welcome to CodeTogether!\nprint("Hello, World!")\n',
    output: '',
    host:  currentUser(req),
    users: {},
    activeQuestion:  null,
    questionTimer:   null,
    timerInterval:   null,
  };
  return res.redirect(`/room/${roomId}`);
});

app.post('/join', requireAuth, (req, res) => {
  const roomId = (req.body.room_id || '').trim();
  if (rooms[roomId]) return res.redirect(`/room/${roomId}`);
  return res.render('index.html', {
    username: currentUser(req),
    user_type: req.session.user_type,
    is_admin: getIsAdmin(req),
    error: `Room "${roomId}" not found.`,
  });
});

app.get('/room/:room_id', requireAuth, (req, res) => {
  const { room_id } = req.params;
  if (!rooms[room_id]) return res.redirect('/');
  const room = rooms[room_id];
  const username = currentUser(req);

  let activeQuestion = null;
  if (room.activeQuestion) {
    const q = db.prepare('SELECT id,title,description,max_points,time_limit FROM questions WHERE id=?')
      .get(room.activeQuestion.id);
    if (q) {
      const remaining = room.activeQuestion.endTime
        ? Math.max(0, Math.ceil((room.activeQuestion.endTime - Date.now()) / 1000))
        : null;
      activeQuestion = { ...q, endTime: room.activeQuestion.endTime, remaining };
    }
  }

  const questions = username === room.host
    ? db.prepare('SELECT id,title,time_limit,max_points FROM questions WHERE is_active=1 ORDER BY created_at DESC').all()
    : [];

  return res.render('room.html', {
    room_id,
    username,
    user_type:      req.session.user_type,
    is_host:        room.host === username,
    is_admin:       getIsAdmin(req),
    host:           room.host,
    active_question: activeQuestion,
    questions,
  });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/dashboard', requireRegistered, (req, res) => {
  const username = currentUser(req);
  const admin    = getIsAdmin(req);

  const registeredUsers = db.prepare(`
    SELECT u.id, u.username, u.email, u.is_admin, u.created_at,
           MAX(s.logged_in_at) as last_login,
           COUNT(DISTINCT s.id) as login_count,
           COALESCE(SUM(sub.score),0) as total_score,
           COUNT(DISTINCT sub.id) as submission_count
    FROM users u
    LEFT JOIN user_sessions s ON s.username=u.username AND s.user_type='user'
    LEFT JOIN submissions sub ON sub.username=u.username
    GROUP BY u.id ORDER BY u.created_at DESC
  `).all();

  const guestUsers = db.prepare(`
    SELECT username, MAX(logged_in_at) as last_login, COUNT(*) as login_count
    FROM user_sessions WHERE user_type='guest'
    GROUP BY username ORDER BY last_login DESC LIMIT 100
  `).all();

  const questions = admin
    ? db.prepare(`SELECT q.*,COUNT(s.id) as sub_count FROM questions q
        LEFT JOIN submissions s ON s.question_id=q.id GROUP BY q.id ORDER BY q.created_at DESC`).all()
    : db.prepare(`SELECT q.*,COUNT(s.id) as sub_count FROM questions q
        LEFT JOIN submissions s ON s.question_id=q.id WHERE q.created_by=?
        GROUP BY q.id ORDER BY q.created_at DESC`).all(username);

  const globalCriteria = db.prepare(
    'SELECT * FROM scoring_criteria WHERE question_id IS NULL ORDER BY min_similarity ASC'
  ).all();

  const submissions = admin
    ? db.prepare(`SELECT s.*,q.title as q_title FROM submissions s
        JOIN questions q ON q.id=s.question_id ORDER BY s.submitted_at DESC LIMIT 200`).all()
    : db.prepare(`SELECT s.*,q.title as q_title FROM submissions s
        JOIN questions q ON q.id=s.question_id WHERE q.created_by=?
        ORDER BY s.submitted_at DESC LIMIT 200`).all(username);

  res.render('dashboard.html', {
    username, is_admin: admin,
    registeredUsers, guestUsers, questions, globalCriteria, submissions,
  });
});

// Questions CRUD
app.post('/dashboard/questions', requireRegistered, (req, res) => {
  const { title, description, expected_output, time_limit, max_points } = req.body;
  if (!title || !expected_output) return res.status(400).json({ error: 'Title and expected output required.' });
  const r = db.prepare(
    'INSERT INTO questions (title,description,expected_output,time_limit,max_points,created_by) VALUES (?,?,?,?,?,?)'
  ).run(title, description || '', expected_output, parseInt(time_limit)||0, parseFloat(max_points)||10, currentUser(req));
  res.json({ id: r.lastInsertRowid });
});

app.put('/dashboard/questions/:id', requireRegistered, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found.' });
  if (q.created_by !== currentUser(req) && !getIsAdmin(req))
    return res.status(403).json({ error: 'Not authorized.' });
  const { title, description, expected_output, time_limit, max_points, is_active } = req.body;
  db.prepare(`UPDATE questions SET title=?,description=?,expected_output=?,time_limit=?,max_points=?,is_active=?
    WHERE id=?`).run(
    title ?? q.title, description ?? q.description, expected_output ?? q.expected_output,
    time_limit !== undefined ? parseInt(time_limit) : q.time_limit,
    max_points !== undefined ? parseFloat(max_points) : q.max_points,
    is_active  !== undefined ? (is_active ? 1 : 0) : q.is_active,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/dashboard/questions/:id', requireRegistered, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found.' });
  if (q.created_by !== currentUser(req) && !getIsAdmin(req))
    return res.status(403).json({ error: 'Not authorized.' });
  db.prepare('DELETE FROM scoring_criteria WHERE question_id=?').run(req.params.id);
  db.prepare('DELETE FROM questions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Per-question scoring criteria
app.get('/dashboard/questions/:id/criteria', requireRegistered, (req, res) => {
  res.json(db.prepare('SELECT * FROM scoring_criteria WHERE question_id=? ORDER BY min_similarity ASC').all(req.params.id));
});

app.post('/dashboard/questions/:id/criteria', requireRegistered, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found.' });
  if (q.created_by !== currentUser(req) && !getIsAdmin(req))
    return res.status(403).json({ error: 'Not authorized.' });
  const criteria = req.body.criteria;
  if (!Array.isArray(criteria)) return res.status(400).json({ error: 'Expected array.' });
  db.prepare('DELETE FROM scoring_criteria WHERE question_id=?').run(req.params.id);
  const stmt = db.prepare('INSERT INTO scoring_criteria (question_id,min_similarity,score) VALUES (?,?,?)');
  criteria.forEach(c => stmt.run(req.params.id, parseFloat(c.min_similarity), parseFloat(c.score)));
  res.json({ ok: true });
});

// Global scoring criteria
app.get('/dashboard/scoring-criteria', requireRegistered, (req, res) => {
  res.json(db.prepare('SELECT * FROM scoring_criteria WHERE question_id IS NULL ORDER BY min_similarity ASC').all());
});

app.post('/dashboard/scoring-criteria', requireRegistered, (req, res) => {
  const { min_similarity, score } = req.body;
  if (min_similarity === undefined || score === undefined)
    return res.status(400).json({ error: 'min_similarity and score required.' });
  const r = db.prepare('INSERT INTO scoring_criteria (question_id,min_similarity,score) VALUES (NULL,?,?)')
    .run(parseFloat(min_similarity), parseFloat(score));
  res.json({ id: r.lastInsertRowid });
});

app.delete('/dashboard/scoring-criteria/:id', requireRegistered, (req, res) => {
  db.prepare('DELETE FROM scoring_criteria WHERE id=? AND question_id IS NULL').run(req.params.id);
  res.json({ ok: true });
});

// Toggle admin
app.post('/dashboard/users/:id/toggle-admin', requireRegistered, (req, res) => {
  if (!getIsAdmin(req)) return res.status(403).json({ error: 'Admin only.' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found.' });
  db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(u.is_admin ? 0 : 1, u.id);
  res.json({ is_admin: !u.is_admin });
});

// Submissions for a question
app.get('/dashboard/questions/:id/submissions', requireRegistered, (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, u.email FROM submissions s
    LEFT JOIN users u ON u.username=s.username
    WHERE s.question_id=? ORDER BY s.submitted_at DESC
  `).all(req.params.id));
});

// ── Scores ────────────────────────────────────────────────────────────────────
app.get('/scores', requireAuth, (req, res) => {
  res.render('scores.html', { username: currentUser(req), user_type: req.session.user_type });
});

app.get('/scores/data', requireAuth, (req, res) => {
  const u = currentUser(req);
  const submissions = db.prepare(`
    SELECT s.*, q.title as q_title, q.max_points
    FROM submissions s JOIN questions q ON q.id=s.question_id
    WHERE s.username=? ORDER BY s.submitted_at DESC
  `).all(u);
  const daily = db.prepare(`
    SELECT date(s.submitted_at) as date,
           SUM(s.score) as total_score, COUNT(s.id) as count,
           COUNT(DISTINCT s.question_id) as questions_attempted
    FROM submissions s WHERE s.username=?
    GROUP BY date(s.submitted_at) ORDER BY date DESC
  `).all(u);
  res.json({ submissions, daily });
});

// ── Socket.IO events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('join', ({ room_id, username }) => {
    if (!rooms[room_id]) { socket.emit('error', { message: 'Room no longer exists.' }); return; }
    const room = rooms[room_id];
    socket.join(room_id);
    room.users[socket.id] = username;
    socket.room_id  = room_id;
    socket.username = username;

    const syncData = {
      code:   room.code,
      output: room.output,
      host:   room.host,
      users:  Object.values(room.users),
    };
    if (room.activeQuestion) {
      const q = db.prepare('SELECT id,title,description,max_points,time_limit FROM questions WHERE id=?')
        .get(room.activeQuestion.id);
      if (q) {
        syncData.activeQuestion = {
          ...q,
          endTime:   room.activeQuestion.endTime,
          remaining: room.activeQuestion.endTime
            ? Math.max(0, Math.ceil((room.activeQuestion.endTime - Date.now()) / 1000))
            : null,
        };
      }
    }
    socket.emit('sync', syncData);
    io.to(room_id).emit('user_joined', { username, users: Object.values(room.users) });
  });

  socket.on('code_change', ({ room_id, code, username }) => {
    if (rooms[room_id]) {
      rooms[room_id].code = code;
      socket.to(room_id).emit('code_update', { code, by: username });
    }
  });

  socket.on('run_code', ({ room_id, username }) => {
    if (!rooms[room_id]) return;
    if (!PYTHON) { io.to(room_id).emit('run_output', { output: '[Error] Python 3 not found on this server.' }); return; }
    const code = rooms[room_id].code;
    io.to(room_id).emit('run_start', { by: username });
    runPython(code, (err, stdout, stderr) => {
      let out = stdout || '';
      if (stderr) out += (out ? '\n' : '') + '[stderr]\n' + stderr;
      if (err && err.killed) out = '[Error] Execution timed out (15s limit).';
      else if (err && !stdout && !stderr) out = `[Error] ${err.message}`;
      if (rooms[room_id]) rooms[room_id].output = out;
      io.to(room_id).emit('run_output', { output: out });
    });
  });

  socket.on('run_personal', ({ code }) => {
    if (!PYTHON) { socket.emit('personal_output', { output: '[Error] Python 3 not found on this server.' }); return; }
    socket.emit('personal_run_start');
    runPython(code, (err, stdout, stderr) => {
      let out = stdout || '';
      if (stderr) out += (out ? '\n' : '') + '[stderr]\n' + stderr;
      if (err && err.killed) out = '[Error] Execution timed out (15s limit).';
      else if (err && !stdout && !stderr) out = `[Error] ${err.message}`;
      socket.emit('personal_output', { output: out });
    });
  });

  socket.on('submit_answer', ({ room_id, question_id, code }) => {
    if (!PYTHON) { socket.emit('submission_result', { error: 'Python not available.' }); return; }
    const question = db.prepare('SELECT * FROM questions WHERE id=?').get(question_id);
    if (!question) { socket.emit('submission_result', { error: 'Question not found.' }); return; }
    socket.emit('personal_run_start');
    runPython(code, (err, stdout, stderr) => {
      let out = stdout || '';
      if (stderr) out += (out ? '\n' : '') + '[stderr]\n' + stderr;
      if (err && err.killed) out = '[Error] Execution timed out (15s limit).';
      else if (err && !stdout && !stderr) out = `[Error] ${err.message}`;
      socket.emit('personal_output', { output: out });
      const { sim, score } = calcScore(out, question.expected_output, question_id);
      if (socket.username) {
        db.prepare(`INSERT INTO submissions
          (username,question_id,room_id,code,output,expected_output,similarity,score,max_score)
          VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(socket.username, question_id, room_id||'', code, out,
              question.expected_output, sim, score, question.max_points);
      }
      socket.emit('submission_result', {
        score,
        max_score:  question.max_points,
        similarity: Math.round(sim * 100),
        output:     out,
      });
    });
  });

  socket.on('activate_question', ({ room_id, question_id }) => {
    if (!rooms[room_id]) return;
    const room = rooms[room_id];
    if (room.host !== socket.username) {
      socket.emit('error', { message: 'Only the host can activate questions.' }); return;
    }
    const q = db.prepare('SELECT * FROM questions WHERE id=?').get(question_id);
    if (!q) { socket.emit('error', { message: 'Question not found.' }); return; }
    if (room.questionTimer)  clearTimeout(room.questionTimer);
    if (room.timerInterval)  clearInterval(room.timerInterval);
    const endTime = q.time_limit > 0 ? Date.now() + q.time_limit * 1000 : null;
    room.activeQuestion = { id: q.id, time_limit: q.time_limit, endTime };
    const payload = {
      id: q.id, title: q.title, description: q.description,
      max_points: q.max_points, time_limit: q.time_limit,
      endTime, remaining: q.time_limit > 0 ? q.time_limit : null,
    };
    io.to(room_id).emit('question_activated', payload);
    if (endTime) {
      room.timerInterval = setInterval(() => {
        if (!rooms[room_id]) { clearInterval(room.timerInterval); return; }
        const rem = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
        io.to(room_id).emit('question_timer', { remaining: rem });
        if (rem <= 0) { clearInterval(room.timerInterval); room.timerInterval = null; }
      }, 1000);
      room.questionTimer = setTimeout(() => {
        if (rooms[room_id]) { rooms[room_id].activeQuestion = null; io.to(room_id).emit('question_ended'); }
      }, q.time_limit * 1000);
    }
  });

  socket.on('deactivate_question', ({ room_id }) => {
    if (!rooms[room_id]) return;
    const room = rooms[room_id];
    if (room.host !== socket.username) return;
    if (room.questionTimer)  clearTimeout(room.questionTimer);
    if (room.timerInterval)  clearInterval(room.timerInterval);
    room.activeQuestion = room.questionTimer = room.timerInterval = null;
    io.to(room_id).emit('question_ended');
  });

  socket.on('clear_output', ({ room_id }) => {
    if (rooms[room_id]) {
      rooms[room_id].output = '';
      io.to(room_id).emit('run_output', { output: '' });
    }
  });

  socket.on('disconnect', () => {
    for (const [room_id, data] of Object.entries(rooms)) {
      if (socket.id in data.users) {
        const username = data.users[socket.id];
        delete data.users[socket.id];
        io.to(room_id).emit('user_left', { username, users: Object.values(data.users) });
        if (Object.keys(data.users).length === 0) {
          if (data.questionTimer)  clearTimeout(data.questionTimer);
          if (data.timerInterval)  clearInterval(data.timerInterval);
          delete rooms[room_id];
        }
        break;
      }
    }
  });
});

// ── Entry point ───────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log('  CodeTogether — Collaborative Python IDE');
  console.log(`  http://localhost:${PORT}`);
  console.log('='.repeat(50));
});
