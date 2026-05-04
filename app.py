import sys
import os
import sqlite3
import hashlib
import random
import string
import subprocess

from flask import Flask, render_template, request, session, redirect, url_for
from flask_socketio import SocketIO, join_room, leave_room, emit

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-only-change-in-production")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

DB_PATH = os.path.join(os.path.dirname(__file__), "platform.db")

# In-memory rooms: room_id -> {code, output, host, users: {sid: username}}
rooms: dict = {}


# ── Database ──────────────────────────────────────────────────────────────────

def get_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def init_db():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT    UNIQUE NOT NULL,
                password TEXT    NOT NULL,
                email    TEXT    DEFAULT ''
            )
        """)
        db.commit()


def hash_pw(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def lookup_user(username: str, password: str):
    with get_db() as db:
        return db.execute(
            "SELECT * FROM users WHERE username=? AND password=?",
            (username, hash_pw(password)),
        ).fetchone()


def create_user(username: str, password: str, email: str = "") -> bool:
    try:
        with get_db() as db:
            db.execute(
                "INSERT INTO users (username, password, email) VALUES (?,?,?)",
                (username, hash_pw(password), email),
            )
            db.commit()
        return True
    except sqlite3.IntegrityError:
        return False


# ── Helpers ───────────────────────────────────────────────────────────────────

def gen_room_id() -> str:
    return "".join(random.choices(string.digits, k=6))


def gen_guest_name() -> str:
    suffix = "".join(random.choices(string.ascii_uppercase + string.digits, k=4))
    return f"Guest_{suffix}"


def current_user() -> str | None:
    return session.get("username")


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html", username=current_user(),
                           user_type=session.get("user_type"))


@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        email    = request.form.get("email", "").strip()
        if not username or not password:
            return render_template("register.html", error="Username and password required.")
        if create_user(username, password, email):
            session["username"]  = username
            session["user_type"] = "user"
            return redirect(url_for("index"))
        return render_template("register.html", error="Username already taken.")
    return render_template("register.html")


@app.route("/login", methods=["POST"])
def login():
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    user = lookup_user(username, password)
    if user:
        session["username"]  = username
        session["user_type"] = "user"
        return redirect(url_for("index"))
    return render_template("index.html", error="Invalid username or password.")


@app.route("/guest", methods=["POST"])
def guest():
    session["username"]  = gen_guest_name()
    session["user_type"] = "guest"
    return redirect(url_for("index"))


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))


@app.route("/create_room", methods=["POST"])
def create_room():
    if not current_user():
        return redirect(url_for("index"))
    room_id = gen_room_id()
    while room_id in rooms:
        room_id = gen_room_id()
    rooms[room_id] = {
        "code":   '# Welcome to CodeTogether!\nprint("Hello, World!")\n',
        "output": "",
        "host":   current_user(),
        "users":  {},
    }
    return redirect(url_for("room", room_id=room_id))


@app.route("/join", methods=["POST"])
def join():
    if not current_user():
        return redirect(url_for("index"))
    room_id = request.form.get("room_id", "").strip()
    if room_id in rooms:
        return redirect(url_for("room", room_id=room_id))
    return render_template("index.html", username=current_user(),
                           user_type=session.get("user_type"),
                           error=f'Room "{room_id}" not found.')


@app.route("/room/<room_id>")
def room(room_id):
    if not current_user():
        return redirect(url_for("index"))
    if room_id not in rooms:
        return redirect(url_for("index"))
    data = rooms[room_id]
    return render_template(
        "room.html",
        room_id=room_id,
        username=current_user(),
        user_type=session.get("user_type"),
        is_host=(data["host"] == current_user()),
        host=data["host"],
    )


# ── Socket.IO events ──────────────────────────────────────────────────────────

@socketio.on("join")
def on_join(data):
    room_id  = data.get("room_id")
    username = data.get("username")
    if room_id not in rooms:
        emit("error", {"message": "Room no longer exists."})
        return

    join_room(room_id)
    rooms[room_id]["users"][request.sid] = username

    # Send current state to the joining user only
    emit("sync", {
        "code":   rooms[room_id]["code"],
        "output": rooms[room_id]["output"],
        "host":   rooms[room_id]["host"],
        "users":  list(rooms[room_id]["users"].values()),
    })

    # Broadcast updated user list to room
    emit("user_joined", {
        "username": username,
        "users":    list(rooms[room_id]["users"].values()),
    }, to=room_id)


@socketio.on("code_change")
def on_code_change(data):
    room_id  = data.get("room_id")
    code     = data.get("code", "")
    username = data.get("username")
    if room_id in rooms:
        rooms[room_id]["code"] = code
        emit("code_update", {"code": code, "by": username},
             to=room_id, include_self=False)


@socketio.on("run_code")
def on_run_code(data):
    room_id  = data.get("room_id")
    username = data.get("username")
    if room_id not in rooms:
        return

    code = rooms[room_id]["code"]
    emit("run_start", {"by": username}, to=room_id)

    def execute():
        try:
            # Use the real Python executable, not the py launcher
            python_exe = sys.executable
            if python_exe.lower().endswith("py.exe"):
                import shutil
                python_exe = shutil.which("python") or shutil.which("python3") or sys.executable

            result = subprocess.run(
                [python_exe, "-c", code],
                capture_output=True,
                text=True,
                timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
            )
            out = result.stdout
            if result.stderr:
                out += ("\n" if out else "") + "[stderr]\n" + result.stderr
        except subprocess.TimeoutExpired:
            out = "[Error] Execution timed out (15 s limit)."
        except Exception as exc:
            out = f"[Error] {exc}"

        rooms[room_id]["output"] = out
        socketio.emit("run_output", {"output": out}, to=room_id)

    # Use socketio's background task (eventlet-safe) instead of threading.Thread
    socketio.start_background_task(execute)


@socketio.on("clear_output")
def on_clear_output(data):
    room_id = data.get("room_id")
    if room_id in rooms:
        rooms[room_id]["output"] = ""
        emit("run_output", {"output": ""}, to=room_id)


@socketio.on("disconnect")
def on_disconnect():
    for room_id, data in list(rooms.items()):
        if request.sid in data["users"]:
            username = data["users"].pop(request.sid)
            leave_room(room_id)
            emit("user_left", {
                "username": username,
                "users":    list(data["users"].values()),
            }, to=room_id)
            # Clean up empty rooms (keep host's room a bit longer if wanted)
            if not data["users"]:
                del rooms[room_id]
            break


# ── Entry point ───────────────────────────────────────────────────────────────

init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("DEBUG", "true").lower() == "true"
    print("=" * 50)
    print("  CodeTogether — Collaborative Python IDE")
    print(f"  http://localhost:{port}")
    print("=" * 50)
    socketio.run(app, host="0.0.0.0", port=port, debug=debug)
