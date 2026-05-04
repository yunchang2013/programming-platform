# CodeTogether — Collaborative Python IDE

A real-time collaborative coding platform built with Python. Multiple users can join the same room, edit code together live, and run it instantly.

## Features

- **User accounts** — sign up or continue as a guest
- **Room system** — create a room and share the 6-digit code with others
- **Live collaboration** — everyone in the room edits the same code in real time
- **Run code** — execute Python and see output broadcast to all users (Ctrl+Enter or ▶ Run)
- **Dark theme** — CodeMirror editor with Python syntax highlighting

## Run locally

```bash
pip install -r requirements.txt
python app.py
```

Then open http://localhost:5000

> **Windows:** use `py app.py` instead of `python app.py`

## Deploy to Railway (recommended)

1. Fork or push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
3. Select this repo — Railway auto-detects the `Procfile`
4. Add an environment variable: `SECRET_KEY` → any long random string
5. Set `DEBUG` → `false`
6. Done — Railway gives you a public URL

## Deploy to Render

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect this GitHub repo
3. Render reads `render.yaml` automatically and configures everything
4. Add `SECRET_KEY` in the environment variables dashboard

## Environment variables

| Variable     | Default                          | Description                        |
|--------------|----------------------------------|------------------------------------|
| `SECRET_KEY` | `dev-only-change-in-production`  | Flask session secret — **change this in production** |
| `PORT`       | `5000`                           | Port the server listens on         |
| `DEBUG`      | `true`                           | Set to `false` in production       |

Copy `.env.example` to `.env` for local configuration.

## Tech stack

- [Flask](https://flask.palletsprojects.com/) + [Flask-SocketIO](https://flask-socketio.readthedocs.io/) — web framework and WebSockets
- [eventlet](https://eventlet.readthedocs.io/) — async worker
- [CodeMirror 5](https://codemirror.net/5/) — browser code editor
- SQLite — user database
