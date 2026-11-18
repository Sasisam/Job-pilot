"""SQLite storage — multi-user ready."""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime

from .config import DB_PATH

_lock = threading.Lock()
AUTO_ATS = ("greenhouse", "lever", "ashby", "naukri", "foundit", "shine", "internshala")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT,
  display_name TEXT DEFAULT '',
  is_admin INTEGER DEFAULT 0,
  oauth_provider TEXT DEFAULT '',
  oauth_id TEXT DEFAULT '',
  profile TEXT DEFAULT '{}',
  prefs TEXT DEFAULT '{}',
  resume_path TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_login TEXT,
  login_count INTEGER DEFAULT 0,
  portal_state TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER DEFAULT 1,
  source TEXT, ext_id TEXT, ats TEXT,
  title TEXT, company TEXT, location TEXT, url TEXT, description TEXT,
  work_mode TEXT, company_tier TEXT, company_type TEXT,
  score INTEGER DEFAULT 0, matched TEXT DEFAULT '[]', reason TEXT DEFAULT '',
  llm_scored INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new', note TEXT DEFAULT '',
  applied_by TEXT DEFAULT '', apply_mode TEXT DEFAULT '',
  exp TEXT DEFAULT '', salary TEXT DEFAULT '',
  created TEXT DEFAULT CURRENT_TIMESTAMP, applied_at TEXT,
  UNIQUE(user_id, source, ext_id)
);
CREATE TABLE IF NOT EXISTS login_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  ip TEXT,
  user_agent TEXT,
  success INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_login_user ON login_history(user_id);
"""


@contextmanager
def _db():
    with _lock:
        c = sqlite3.connect(DB_PATH, check_same_thread=False)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()


def init():
    with _db() as c:
        c.executescript(SCHEMA)
        # migrate older single-column users table
        cols = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
        for name, decl in [
            ("username", "TEXT UNIQUE"),
            ("email", "TEXT UNIQUE"),
            ("password_hash", "TEXT"),
            ("display_name", "TEXT DEFAULT ''"),
            ("is_admin", "INTEGER DEFAULT 0"),
            ("oauth_provider", "TEXT DEFAULT ''"),
            ("oauth_id", "TEXT DEFAULT ''"),
            ("created_at", "TEXT DEFAULT CURRENT_TIMESTAMP"),
            ("last_login", "TEXT"),
            ("login_count", "INTEGER DEFAULT 0"),
            ("portal_state", "TEXT DEFAULT '{}'"),
        ]:
            if name not in cols:
                try:
                    c.execute(f"ALTER TABLE users ADD COLUMN {name} {decl}")
                except Exception:
                    pass
        cols = {r["name"] for r in c.execute("PRAGMA table_info(jobs)")}
        for name in ("applied_by", "apply_mode", "exp", "salary"):
            if name not in cols:
                c.execute(f"ALTER TABLE jobs ADD COLUMN {name} TEXT DEFAULT ''")
        c.execute(
            "UPDATE jobs SET apply_mode=CASE WHEN ats IN ('greenhouse','lever','ashby','naukri','foundit','shine','internshala') THEN 'auto' ELSE 'manual' END "
            "WHERE apply_mode='' OR apply_mode IS NULL"
        )
        c.execute("UPDATE jobs SET status='new', note='Interrupted - ready to try again.' WHERE status='applying'")
        c.execute("DELETE FROM jobs WHERE source IN ('remotive','arbeitnow') AND status IN ('new','skipped')")
        c.execute("UPDATE jobs SET applied_by='ai' WHERE status='applied' AND (applied_by='' OR applied_by IS NULL)")


def _user_row(r):
    if not r:
        return None
    return {
        "id": r["id"],
        "username": r["username"] or "",
        "email": r["email"] or "",
        "display_name": r["display_name"] or r["username"] or "",
        "is_admin": bool(r["is_admin"]),
        "oauth_provider": r["oauth_provider"] or "",
        "oauth_id": r["oauth_id"] or "",
        "profile": json.loads(r["profile"] or "{}"),
        "prefs": json.loads(r["prefs"] or "{}"),
        "resume_path": r["resume_path"],
        "created_at": r["created_at"],
        "last_login": r["last_login"],
        "login_count": r["login_count"] or 0,
        "portal_state": json.loads(r["portal_state"] or "{}"),
        "password_hash": r["password_hash"],
    }


def get_user_by_id(uid: int):
    with _db() as c:
        r = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return _user_row(r)


def get_user_by_username(username: str):
    if not username:
        return None
    with _db() as c:
        r = c.execute(
            "SELECT * FROM users WHERE lower(username)=lower(?) OR lower(email)=lower(?)",
            (username.strip(), username.strip()),
        ).fetchone()
        return _user_row(r)


def get_user_by_oauth(provider: str, oauth_id: str):
    with _db() as c:
        r = c.execute(
            "SELECT * FROM users WHERE oauth_provider=? AND oauth_id=?",
            (provider, oauth_id),
        ).fetchone()
        return _user_row(r)


def create_user(
    username: str,
    password: str = None,
    email: str = None,
    display_name: str = None,
    is_admin: bool = False,
    oauth_provider: str = "",
    oauth_id: str = "",
    password_hash: str = None,
):
    from .auth import hash_password

    username = (username or "").strip()
    if not username:
        raise ValueError("Username is required")
    if get_user_by_username(username):
        raise ValueError("Username or email already taken")
    if email and get_user_by_username(email):
        raise ValueError("Username or email already taken")
    ph = password_hash
    if password and not ph:
        ph = hash_password(password)
    with _db() as c:
        cur = c.execute(
            """INSERT INTO users(username, email, password_hash, display_name, is_admin,
               oauth_provider, oauth_id, profile, prefs, portal_state)
               VALUES (?,?,?,?,?,?,?,'{}','{}','{}')""",
            (
                username,
                (email or "").strip() or None,
                ph,
                (display_name or username).strip(),
                1 if is_admin else 0,
                oauth_provider or "",
                oauth_id or "",
            ),
        )
        uid = cur.lastrowid
    return get_user_by_id(uid)


def count_users() -> int:
    with _db() as c:
        return c.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def list_users():
    with _db() as c:
        rows = c.execute(
            "SELECT id, username, email, display_name, is_admin, oauth_provider, "
            "created_at, last_login, login_count FROM users ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]


def bump_login(uid: int):
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    with _db() as c:
        c.execute(
            "UPDATE users SET last_login=?, login_count=COALESCE(login_count,0)+1 WHERE id=?",
            (now, uid),
        )


def add_login_history(user_id: int, ip: str, user_agent: str, success: bool):
    with _db() as c:
        c.execute(
            "INSERT INTO login_history(user_id, ip, user_agent, success) VALUES (?,?,?,?)",
            (user_id, ip or "", user_agent or "", 1 if success else 0),
        )


def login_stats(limit=50):
    with _db() as c:
        rows = c.execute(
            """SELECT h.id, h.user_id, u.username, u.display_name, h.ip, h.user_agent,
                      h.success, h.created_at
               FROM login_history h
               LEFT JOIN users u ON u.id = h.user_id
               ORDER BY h.id DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def user_login_summary():
    with _db() as c:
        rows = c.execute(
            """SELECT id, username, display_name, email, is_admin, login_count, last_login, created_at,
                      (SELECT COUNT(*) FROM login_history WHERE user_id=users.id AND success=1) AS successful_logins,
                      (SELECT COUNT(*) FROM login_history WHERE user_id=users.id AND success=0) AS failed_logins
               FROM users ORDER BY login_count DESC, id"""
        ).fetchall()
        return [dict(r) for r in rows]


def set_admin(uid: int, is_admin: bool):
    with _db() as c:
        c.execute("UPDATE users SET is_admin=? WHERE id=?", (1 if is_admin else 0, uid))


def delete_user(uid: int):
    with _db() as c:
        c.execute("DELETE FROM jobs WHERE user_id=?", (uid,))
        c.execute("DELETE FROM login_history WHERE user_id=?", (uid,))
        c.execute("DELETE FROM users WHERE id=?", (uid,))


def change_password(uid: int, new_password: str):
    from .auth import hash_password
    with _db() as c:
        c.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(new_password), uid))


# ---------- legacy-compatible helpers (now take real uid) ----------

def get_user(uid=1):
    u = get_user_by_id(uid)
    if u:
        return u
    # bootstrap empty shell for very old DBs
    with _db() as c:
        c.execute("INSERT OR IGNORE INTO users(id) VALUES(?)", (uid,))
    return get_user_by_id(uid) or {
        "id": uid, "profile": {}, "prefs": {}, "resume_path": None,
        "username": "", "is_admin": False, "portal_state": {},
    }


def save_user(uid=1, profile=None, prefs=None, resume_path=None, portal_state=None):
    get_user(uid)
    with _db() as c:
        if profile is not None:
            c.execute("UPDATE users SET profile=? WHERE id=?", (json.dumps(profile), uid))
        if prefs is not None:
            c.execute("UPDATE users SET prefs=? WHERE id=?", (json.dumps(prefs), uid))
        if resume_path is not None:
            c.execute("UPDATE users SET resume_path=? WHERE id=?", (str(resume_path), uid))
        if portal_state is not None:
            c.execute("UPDATE users SET portal_state=? WHERE id=?", (json.dumps(portal_state), uid))


def portal_connected(uid: int, pid: str) -> bool:
    u = get_user(uid)
    return bool((u.get("portal_state") or {}).get(pid))


def set_portal_connected(uid: int, pid: str, on: bool):
    u = get_user(uid)
    state = dict(u.get("portal_state") or {})
    state[pid] = bool(on)
    save_user(uid, portal_state=state)


def clear_jobs(uid=1, statuses=("new", "skipped", "manual")):
    q = ",".join("?" * len(statuses))
    with _db() as c:
        return c.execute(f"DELETE FROM jobs WHERE user_id=? AND status IN ({q})", (uid, *statuses)).rowcount


def add_job(uid, j):
    """Insert a job; return its id, or None if we already have it."""
    with _db() as c:
        try:
            cur = c.execute(
                """INSERT INTO jobs(
                    user_id, source, ext_id, ats, title, company, location, url, description,
                    work_mode, company_tier, company_type, score, matched, reason, llm_scored,
                    status, note, apply_mode, exp, salary
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    uid,
                    j.get("source") or "",
                    j.get("ext_id") or "",
                    j.get("ats") or "",
                    j.get("title") or "",
                    j.get("company") or "",
                    j.get("location") or "",
                    j.get("url") or "",
                    (j.get("description") or "")[:8000],
                    j.get("work_mode") or "",
                    j.get("company_tier") or "",
                    j.get("company_type") or "",
                    int(j.get("score") or 0),
                    json.dumps(j.get("matched") or []),
                    j.get("reason") or "",
                    1 if j.get("llm_scored") else 0,
                    j.get("status") or "new",
                    j.get("note") or "",
                    j.get("apply_mode") or "",
                    j.get("exp") or "",
                    j.get("salary") or "",
                ),
            )
            return cur.lastrowid
        except sqlite3.IntegrityError:
            return None


def _row(r):
    if not r:
        return None
    d = dict(r)
    try:
        d["matched"] = json.loads(d.get("matched") or "[]")
    except Exception:
        d["matched"] = []
    return d


def jobs(uid=1, status=None, limit=500):
    q, args = "SELECT * FROM jobs WHERE user_id=?", [uid]
    if status:
        q += " AND status=?"
        args.append(status)
    q += " ORDER BY score DESC, id DESC LIMIT ?"
    args.append(limit)
    with _db() as c:
        return [_row(r) for r in c.execute(q, args).fetchall()]


def get_job(jid, uid=None):
    with _db() as c:
        if uid is None:
            r = c.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
        else:
            r = c.execute("SELECT * FROM jobs WHERE id=? AND user_id=?", (jid, uid)).fetchone()
        return _row(r) if r else None


def set_job(jid, uid=None, **fields):
    if not fields:
        return 0
    if "matched" in fields:
        fields["matched"] = json.dumps(fields["matched"])
    cols = ", ".join(f"{k}=?" for k in fields)
    with _db() as c:
        if uid is None:
            cur = c.execute(f"UPDATE jobs SET {cols} WHERE id=?", [*fields.values(), jid])
        else:
            cur = c.execute(f"UPDATE jobs SET {cols} WHERE id=? AND user_id=?", [*fields.values(), jid, uid])
        return cur.rowcount


def already_applied_url(uid, url):
    if not url:
        return False
    with _db() as c:
        r = c.execute(
            "SELECT 1 FROM jobs WHERE user_id=? AND url=? AND status IN ('applied','ready') LIMIT 1",
            (uid, url),
        ).fetchone()
        return bool(r)


def applied_today(uid=1):
    with _db() as c:
        return c.execute(
            "SELECT COUNT(*) FROM jobs WHERE user_id=? AND status='applied' "
            "AND date(applied_at)=date('now')",
            (uid,),
        ).fetchone()[0]


def status_history_note(old_status, new_status, extra=""):
    ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M")
    base = f"[{ts}] {old_status} → {new_status}"
    return (base + (f" — {extra}" if extra else ""))[:400]


def stats(uid=1):
    with _db() as c:
        rows = c.execute(
            "SELECT status, COUNT(*) n FROM jobs WHERE user_id=? GROUP BY status", (uid,)
        ).fetchall()
        return {r["status"]: r["n"] for r in rows}
