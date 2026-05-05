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

const PORT = parseInt(process.env.PORT || '5000');
const SECRET_KEY = process.env.SECRET_KEY || 'dev-only-change-in-production';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'platform.db');

// ── Template engine ───────────────────────────────────────────────────────────
nunjucks.configure(path.join(__dirname, 'templates'), { autoescape: true, express: app });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(session({
  secret: SECRET_KEY,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false },
}));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT    UNIQUE NOT NULL,
    password TEXT    NOT NULL,
    email    TEXT    DEFAULT ''
  )
`);

function hashPw(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function lookupUser(username, password) {
  return db.prepare('SELECT * FROM users WHERE username=? AND password=?')
    .get(username, hashPw(password));
}

function createUser(username, password, email = '') {
  try {
    db.prepare('INSERT INTO users (username, password, email) VALUES (?,?,?)')
      .run(username, hashPw(password), email);
    return true;
  } catch {
    return false; // UNIQUE constraint violated
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const rooms = {};

function genRoomId() {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function genGuestName() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const suffix = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `Guest_${suffix}`;
}

function currentUser(req) {
  return req.session.username || null;
}

// Detect the Python 3 executable once at startup.
// On Windows, prefer the Python Launcher (py) which bypasses the Store alias.
function findPython() {
  const candidates = process.platform === 'win32'
    ? [{ cmd: 'py', args: ['-3'] }, { cmd: 'python3', args: [] }, { cmd: 'python', args: [] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
  for (const entry of candidates) {
    try {
      const probe = [...entry.args, '--version'].join(' ');
      const out = execSync(`${entry.cmd} ${probe}`, { timeout: 5000, stdio: 'pipe' }).toString();
      if (out.includes('Python 3')) return entry;
    } catch { /* try next */ }
  }
  return null;
}
const PYTHON = findPython();
if (!PYTHON) console.warn('WARNING: Python 3 not found — code execution will fail.');

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.render('index.html', {
    username: currentUser(req),
    user_type: req.session.user_type,
  });
});

app.get('/register', (req, res) => {
  res.render('register.html');
});

app.post('/register', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const email    = (req.body.email || '').trim();
  if (!username || !password) {
    return res.render('register.html', { error: 'Username and password required.' });
  }
  if (createUser(username, password, email)) {
    req.session.username  = username;
    req.session.user_type = 'user';
    return res.redirect('/');
  }
  return res.render('register.html', { error: 'Username already taken.' });
});

app.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const user = lookupUser(username, password);
  if (user) {
    req.session.username  = username;
    req.session.user_type = 'user';
    return res.redirect('/');
  }
  return res.render('index.html', { error: 'Invalid username or password.' });
});

app.post('/guest', (req, res) => {
  req.session.username  = genGuestName();
  req.session.user_type = 'guest';
  return res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  return res.redirect('/');
});

app.post('/create_room', (req, res) => {
  if (!currentUser(req)) return res.redirect('/');
  let roomId = genRoomId();
  while (rooms[roomId]) roomId = genRoomId();
  rooms[roomId] = {
    code:   '# Welcome to CodeTogether!\nprint("Hello, World!")\n',
    output: '',
    host:   currentUser(req),
    users:  {},
  };
  return res.redirect(`/room/${roomId}`);
});

app.post('/join', (req, res) => {
  if (!currentUser(req)) return res.redirect('/');
  const roomId = (req.body.room_id || '').trim();
  if (rooms[roomId]) return res.redirect(`/room/${roomId}`);
  return res.render('index.html', {
    username: currentUser(req),
    user_type: req.session.user_type,
    error: `Room "${roomId}" not found.`,
  });
});

app.get('/room/:room_id', (req, res) => {
  const { room_id } = req.params;
  if (!currentUser(req)) return res.redirect('/');
  if (!rooms[room_id]) return res.redirect('/');
  const data = rooms[room_id];
  return res.render('room.html', {
    room_id,
    username: currentUser(req),
    user_type: req.session.user_type,
    is_host: data.host === currentUser(req),
    host: data.host,
  });
});

// ── Socket.IO events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const { room_id, username } = data;
    if (!rooms[room_id]) {
      socket.emit('error', { message: 'Room no longer exists.' });
      return;
    }
    socket.join(room_id);
    rooms[room_id].users[socket.id] = username;

    // Send current state to the joining user only
    socket.emit('sync', {
      code:   rooms[room_id].code,
      output: rooms[room_id].output,
      host:   rooms[room_id].host,
      users:  Object.values(rooms[room_id].users),
    });

    // Broadcast updated user list to the whole room
    io.to(room_id).emit('user_joined', {
      username,
      users: Object.values(rooms[room_id].users),
    });
  });

  socket.on('code_change', (data) => {
    const { room_id, code, username } = data;
    if (rooms[room_id]) {
      rooms[room_id].code = code;
      // Broadcast to everyone except the sender
      socket.to(room_id).emit('code_update', { code, by: username });
    }
  });

  socket.on('run_code', (data) => {
    const { room_id, username } = data;
    if (!rooms[room_id]) return;

    if (!PYTHON) {
      io.to(room_id).emit('run_output', { output: '[Error] Python 3 not found on this server.' });
      return;
    }

    const code = rooms[room_id].code;
    io.to(room_id).emit('run_start', { by: username });

    execFile(PYTHON.cmd, [...PYTHON.args, '-c', code], {
      timeout: 15_000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      let out = stdout || '';
      if (stderr) out += (out ? '\n' : '') + '[stderr]\n' + stderr;
      if (err && err.killed) {
        out = '[Error] Execution timed out (15 s limit).';
      } else if (err && !stderr && !stdout) {
        out = `[Error] ${err.message}`;
      }
      if (rooms[room_id]) rooms[room_id].output = out;
      io.to(room_id).emit('run_output', { output: out });
    });
  });

  socket.on('clear_output', (data) => {
    const { room_id } = data;
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
        io.to(room_id).emit('user_left', {
          username,
          users: Object.values(data.users),
        });
        if (Object.keys(data.users).length === 0) {
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
