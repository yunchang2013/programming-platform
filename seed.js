'use strict';
const Database = require('better-sqlite3');
const db = new Database('platform.db');

const roomId   = '999999';
const hostName = 'admin';

db.prepare('INSERT OR REPLACE INTO rooms_db (room_id, host, code, output) VALUES (?,?,?,?)')
  .run(roomId, hostName, 'print("Hello")', 'Hello');

['Alice', 'Bob', 'Charlie'].forEach(u =>
  db.prepare('INSERT OR IGNORE INTO room_participants (room_id, username) VALUES (?,?)').run(roomId, u)
);

let q = db.prepare('SELECT id FROM questions LIMIT 1').get();
if (!q) {
  const r = db.prepare(
    'INSERT INTO questions (title,description,expected_output,max_points,created_by,solution_code) VALUES (?,?,?,?,?,?)'
  ).run('Print Hello World', 'Print Hello, World! to the screen', 'Hello, World!', 10, hostName, 'print("Hello, World!")');
  q = { id: r.lastInsertRowid };
}

const now  = new Date().toISOString().replace('T', ' ').slice(0, 19);
const stmt = db.prepare(
  'INSERT INTO submissions (username,question_id,room_id,code,output,expected_output,similarity,score,max_score,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
);
stmt.run('Alice',   q.id, roomId, 'print("Hello, World!")', 'Hello, World!', 'Hello, World!', 1.00, 10.0, 10, now);
stmt.run('Alice',   q.id, roomId, 'print("hello world")',   'hello world',   'Hello, World!', 0.75,  7.5, 10, now);
stmt.run('Bob',     q.id, roomId, 'print("Hello, World!")', 'Hello, World!', 'Hello, World!', 1.00, 10.0, 10, now);
stmt.run('Bob',     q.id, roomId, 'print("hi")',            'hi',            'Hello, World!', 0.20,  2.0, 10, now);
stmt.run('Charlie', q.id, roomId, 'print("Hello, World!")', 'Hello, World!', 'Hello, World!', 1.00, 10.0, 10, now);

console.log('Room:',         db.prepare('SELECT room_id,host FROM rooms_db WHERE room_id=?').get(roomId));
console.log('Submissions:',  db.prepare('SELECT COUNT(*) as c FROM submissions WHERE room_id=?').get(roomId).c);
console.log('Participants:', db.prepare('SELECT COUNT(*) as c FROM room_participants WHERE room_id=?').get(roomId).c);
console.log('\nDone! Log in as "admin" and visit: http://localhost:5000/room/999999/report');
