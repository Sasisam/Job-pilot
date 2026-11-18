import os
import subprocess
import sys
import threading
import time
import webbrowser
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, config, db, filters, llm, matcher, notify, pipeline, portals, resume
from .runner import RUN

STATIC = Path(__file__).resolve().parent.parent / "static"
db.init()


def _scheduler():
    while config.RUN_EVERY_MINUTES > 0:
        time.sleep(config.RUN_EVERY_MINUTES * 60)
        # scheduled runs use admin or first user — skip if none
        users = db.list_users()
        if not users:
            continue
        uid = users[0]["id"]
        RUN.start("auto-run", pipeline.run_once, uid, label="Scheduled run")


@asynccontextmanager
async def lifespan(_app):
    if config.RUN_EVERY_MINUTES > 0:
        threading.Thread(target=_scheduler, daemon=True).start()
    if config.OPEN_BROWSER:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{config.PORT}")).start()
    yield


app = FastAPI(title="JobPilot", lifespan=lifespan)
app.mount("/shots", StaticFiles(directory=str(config.SHOTS)), name="shots")
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.middleware("http")
async def no_cache_static(request, call_next):
    response = await call_next(request)
    path = request.url.path or ""
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response


def _resume_info(user):
    p = resume.active_path(user.get("resume_path"))
    if not p:
        return None
    st = p.stat()
    return {
        "name": p.name,
        "kb": round(st.st_size / 1024),
        "modified": datetime.fromtimestamp(st.st_mtime).strftime("%d %b %Y, %H:%M"),
        "folder": str(config.RESUME_DIR),
        "ext": p.suffix.lower().lstrip("."),
    }


def _start(phase, fn, *args, label=""):
    return {"started": RUN.start(phase, fn, *args, label=label)}


def _public_user(u: dict) -> dict:
    return {
        "id": u["id"],
        "username": u.get("username") or "",
        "email": u.get("email") or "",
        "display_name": u.get("display_name") or u.get("username") or "",
        "is_admin": bool(u.get("is_admin")),
        "oauth_provider": u.get("oauth_provider") or "",
        "login_count": u.get("login_count") or 0,
        "last_login": u.get("last_login"),
    }


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(STATIC / "icons" / "favicon-32.png")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


# ─────────────────────────────────────────────────────────────
# Auth endpoints
# ─────────────────────────────────────────────────────────────

class RegisterBody(BaseModel):
    username: str
    password: str
    email: Optional[str] = None
    display_name: Optional[str] = None


class LoginBody(BaseModel):
    username: str
    password: str


class CreateUserBody(BaseModel):
    username: str
    password: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    is_admin: bool = False


class PasswordBody(BaseModel):
    password: str


@app.get("/api/auth/status")
def auth_status(user: Optional[dict] = Depends(auth.get_optional_user)):
    total = db.count_users()
    return {
        "authenticated": bool(user),
        "user": _public_user(user) if user else None,
        "needs_setup": total == 0,
        "allow_register": total == 0 or True,  # team can self-register; admin can disable later if needed
    }


@app.post("/api/auth/register")
def register(b: RegisterBody, request: Request, response: Response):
    username = (b.username or "").strip()
    password = b.password or ""
    if len(username) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    if len(password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    is_first = db.count_users() == 0
    try:
        user = db.create_user(
            username=username,
            password=password,
            email=b.email,
            display_name=b.display_name or username,
            is_admin=is_first,  # first account is admin
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    auth.record_login(user["id"], True, request)
    auth.set_session_cookie(response, user["id"])
    return {"ok": True, "user": _public_user(user), "is_first_admin": is_first}


@app.post("/api/auth/login")
def login(b: LoginBody, request: Request, response: Response):
    username = (b.username or "").strip()
    password = b.password or ""
    if not username or not password:
        raise HTTPException(401, "Username or password incorrect")
    user = db.get_user_by_username(username)
    if not user or not user.get("password_hash"):
        # still record failed attempt if we can identify a user
        if user:
            auth.record_login(user["id"], False, request)
        raise HTTPException(401, "Username or password incorrect")
    if not auth.verify_password(password, user["password_hash"]):
        auth.record_login(user["id"], False, request)
        raise HTTPException(401, "Username or password incorrect")
    auth.record_login(user["id"], True, request)
    auth.set_session_cookie(response, user["id"])
    return {"ok": True, "user": _public_user(user)}


@app.post("/api/auth/logout")
def logout(response: Response):
    auth.clear_session_cookie(response)
    return {"ok": True}


@app.post("/api/auth/social")
def social_login(request: Request, response: Response, body: dict):
    """
    Lightweight social-style login for team use.
    Body: { provider: 'google'|'github'|'apple',', email, name, sub }
    Creates or links a local account. Real OAuth can be wired later with client IDs.
    """
    provider = (body.get("provider") or "").strip().lower()
    email = (body.get("email") or "").strip().lower()
    name = (body.get("name") or "").strip()
    sub = (body.get("sub") or body.get("id") or "").strip()
    if provider not in ("google", "github", "apple"):
        raise HTTPException(400, "Unsupported provider")
    if not sub and not email:
        raise HTTPException(400, "Missing identity from provider")
    oauth_id = sub or email
    user = db.get_user_by_oauth(provider, oauth_id)
    if not user and email:
        # try match by email
        user = db.get_user_by_username(email)
        if user:
            # link
            with db._db() as c:
                c.execute(
                    "UPDATE users SET oauth_provider=?, oauth_id=? WHERE id=?",
                    (provider, oauth_id, user["id"]),
                )
            user = db.get_user_by_id(user["id"])
    if not user:
        # create
        base = (email.split("@")[0] if email else f"{provider}_{oauth_id[:8]}").replace(".", "_")[:24]
        username = base
        n = 1
        while db.get_user_by_username(username):
            n += 1
            username = f"{base}{n}"
        is_first = db.count_users() == 0
        user = db.create_user(
            username=username,
            email=email or None,
            display_name=name or username,
            is_admin=is_first,
            oauth_provider=provider,
            oauth_id=oauth_id,
            password_hash=None,
        )
    auth.record_login(user["id"], True, request)
    auth.set_session_cookie(response, user["id"])
    return {"ok": True, "user": _public_user(user)}


# ─────────────────────────────────────────────────────────────
# Admin
# ─────────────────────────────────────────────────────────────

@app.get("/api/admin/users")
def admin_users(_: dict = Depends(auth.require_admin)):
    return db.user_login_summary()


@app.get("/api/admin/logins")
def admin_logins(_: dict = Depends(auth.require_admin)):
    return db.login_stats(80)


@app.post("/api/admin/users")
def admin_create_user(b: CreateUserBody, _: dict = Depends(auth.require_admin)):
    try:
        user = db.create_user(
            username=b.username,
            password=b.password,
            email=b.email,
            display_name=b.display_name,
            is_admin=b.is_admin,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "user": _public_user(user)}


@app.post("/api/admin/users/{uid}/password")
def admin_set_password(uid: int, b: PasswordBody, _: dict = Depends(auth.require_admin)):
    if not db.get_user_by_id(uid):
        raise HTTPException(404, "User not found")
    if len(b.password or "") < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    db.change_password(uid, b.password)
    return {"ok": True}


@app.delete("/api/admin/users/{uid}")
def admin_delete_user(uid: int, admin: dict = Depends(auth.require_admin)):
    if uid == admin["id"]:
        raise HTTPException(400, "Cannot delete your own account")
    if not db.get_user_by_id(uid):
        raise HTTPException(404)
    db.delete_user(uid)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────
# App state (authenticated)
# ─────────────────────────────────────────────────────────────

@app.get("/api/state")
def state(user: dict = Depends(auth.get_current_user)):
    uid = user["id"]
    u = db.get_user(uid)
    nc = config.get_notify_config()
    return {
        "user": _public_user(user),
        "profile": u["profile"],
        "prefs": pipeline.effective_prefs(u["prefs"]),
        "resume": _resume_info(u),
        "ai_enabled": llm.available(),
        "email_enabled": nc["email_ready"],
        "push_enabled": nc["push_ready"],
        "notify": nc,
        "portals": [
            {
                "id": p.id,
                "name": p.name,
                "auto": p.auto,
                "blurb": p.blurb,
                "connected": db.portal_connected(uid, p.id),
            }
            for p in portals.PORTALS.values()
        ],
        "city_presets": filters.CITY_PRESETS,
        "run": {
            "running": RUN.running,
            "stopping": RUN.stopping,
            "phase": RUN.phase,
            "label": RUN.label,
            "done": RUN.done,
            "total": RUN.total,
            "current": RUN.current,
            "last_run": RUN.last_run,
            "summary": RUN.last_summary,
        },
        "stats": db.stats(uid),
        "applied_today": db.applied_today(uid),
        "log": list(RUN.log_lines)[-80:],
    }


@app.post("/api/stop")
def stop(user: dict = Depends(auth.get_current_user)):
    return {"stopping": RUN.request_stop()}


# ---------------------------------------------------------------- resume
@app.post("/api/resume")
async def upload_resume(file: UploadFile = File(...), user: dict = Depends(auth.get_current_user)):
    uid = user["id"]
    MAX_RESUME_BYTES = 8 * 1024 * 1024
    raw = await file.read()
    if len(raw) > MAX_RESUME_BYTES:
        raise HTTPException(400, "Resume too large (max 8 MB).")
    if len(raw) < 80:
        raise HTTPException(400, "File is empty or too small.")
    name = file.filename or "resume.pdf"
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if ext not in (".pdf", ".docx", ".txt"):
        raise HTTPException(400, "Only PDF, DOCX or TXT resumes are accepted.")
    try:
        from io import BytesIO
        dest = resume.save_upload(BytesIO(raw), name, uid=uid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    text = resume.extract_text(dest)
    if len(text.strip()) < 50:
        resume.remove_active(uid=uid)
        raise HTTPException(400, "Could not read text from this file (scanned image?). Use a text PDF or DOCX.")
    profile = resume.parse_profile(text)
    db.save_user(uid, profile=profile, resume_path=dest)
    return {"profile": profile, "resume": _resume_info(db.get_user(uid))}


@app.get("/api/resume/file")
def resume_file(user: dict = Depends(auth.get_current_user)):
    p = resume.active_path(db.get_user(user["id"])["resume_path"])
    if not p:
        raise HTTPException(404)
    return FileResponse(p, filename=p.name)


@app.delete("/api/resume")
def delete_resume(user: dict = Depends(auth.get_current_user)):
    resume.remove_active(uid=user["id"])
    db.save_user(user["id"], resume_path="")
    return {"ok": True}


@app.post("/api/resume/open-folder")
def open_folder(user: dict = Depends(auth.get_current_user)):
    try:
        if sys.platform.startswith("win"):
            os.startfile(str(config.RESUME_DIR))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(config.RESUME_DIR)])
        else:
            subprocess.Popen(["xdg-open", str(config.RESUME_DIR)])
    except Exception:
        pass
    return {"folder": str(config.RESUME_DIR)}


class Body(BaseModel):
    data: dict


@app.put("/api/profile")
def put_profile(b: Body, user: dict = Depends(auth.get_current_user)):
    db.save_user(user["id"], profile=b.data)
    return {"ok": True}


@app.put("/api/prefs")
def put_prefs(b: Body, user: dict = Depends(auth.get_current_user)):
    db.save_user(user["id"], prefs=b.data)
    return {"ok": True}


# ---------------------------------------------------------------- search + portals
class SearchBody(BaseModel):
    roles: List[str]
    locations: Optional[List[str]] = None
    work_modes: Optional[List[str]] = None
    company_tiers: Optional[List[str]] = None
    company_types: Optional[List[str]] = None
    portals: Optional[List[str]] = None
    experience_years: Optional[float] = None


@app.post("/api/search")
def search(b: SearchBody, user: dict = Depends(auth.get_current_user)):
    uid = user["id"]
    roles = [r.strip() for r in b.roles if r.strip()]
    if not roles:
        raise HTTPException(400, "Add at least one role")
    u = db.get_user(uid)
    if not u["profile"]:
        raise HTTPException(400, "Upload your resume first")
    prefs = dict(u["prefs"])
    prefs["roles"] = roles
    for k in ("locations", "work_modes", "company_tiers", "company_types", "portals", "experience_years"):
        v = getattr(b, k)
        if v is not None:
            prefs[k] = v
    db.save_user(uid, prefs=prefs)
    return _start("search", pipeline.discover, uid, label="Searching jobs")


@app.post("/api/portals/{pid}/connect")
def portal_connect(pid: str, user: dict = Depends(auth.get_current_user)):
    p = portals.PORTALS.get(pid)
    if not p or not p.auto:
        raise HTTPException(404, "This portal cannot be connected")
    # Pass uid so browser profile is per-user
    return _start("login", portals.connect, pid, user["id"], label=f"Log in to {p.name}")


@app.post("/api/portals/done")
def portal_done(user: dict = Depends(auth.get_current_user)):
    RUN.done_event.set()
    return {"ok": True}


@app.post("/api/portals/{pid}/disconnect")
def portal_disconnect(pid: str, user: dict = Depends(auth.get_current_user)):
    db.set_portal_connected(user["id"], pid, False)
    return {"ok": True}


@app.get("/api/portals/links")
def portal_links(role: str = "", loc: str = "", user: dict = Depends(auth.get_current_user)):
    return [{"id": p.id, "name": p.name, "url": p.manual_url(role or "jobs", loc)} for p in portals.PORTALS.values() if p.manual_url]


# ---------------------------------------------------------------- jobs
@app.get("/api/jobs")
def list_jobs(status: str = "", roles: str = "", user: dict = Depends(auth.get_current_user)):
    rows = db.jobs(user["id"], status or None)
    wanted = [r.strip() for r in roles.split("|") if r.strip()]
    if wanted:
        rows = [j for j in rows if matcher.title_fit(wanted, j["title"]) >= 0.5]
    return rows


@app.post("/api/jobs/clear")
def clear_jobs(user: dict = Depends(auth.get_current_user)):
    return {"removed": db.clear_jobs(user["id"])}


@app.post("/api/run")
def run_now(user: dict = Depends(auth.get_current_user)):
    return _start("auto-run", pipeline.run_once, user["id"], label="Search + auto-apply")


class ApplyBody(BaseModel):
    ids: List[int]
    submit: bool = False


@app.post("/api/apply")
def apply_selected(b: ApplyBody, user: dict = Depends(auth.get_current_user)):
    uid = user["id"]
    if not b.ids:
        raise HTTPException(400, "No jobs selected")
    if not resume.active_path(db.get_user(uid)["resume_path"]):
        raise HTTPException(400, "Upload your resume first. JobPilot applies with the file in your resume folder.")
    owned = []
    for jid in b.ids[:50]:
        job = db.get_job(jid, uid=uid)
        if job:
            owned.append(jid)
    if not owned:
        raise HTTPException(400, "No valid jobs to apply")
    prefs = pipeline.effective_prefs(db.get_user(uid)["prefs"])
    if b.submit and db.applied_today(uid) >= prefs["daily_cap"]:
        raise HTTPException(400, f"Daily apply cap ({prefs['daily_cap']}) already reached.")
    return _start("apply", pipeline.apply_batch, owned, uid, b.submit, label="Auto-applying")


@app.post("/api/jobs/{jid}/approve")
def approve(jid: int, user: dict = Depends(auth.get_current_user)):
    uid = user["id"]
    if not db.get_job(jid, uid=uid):
        raise HTTPException(404)
    prefs = pipeline.effective_prefs(db.get_user(uid)["prefs"])
    if db.applied_today(uid) >= prefs["daily_cap"]:
        raise HTTPException(400, f"Daily apply cap ({prefs['daily_cap']}) already reached.")
    return _start("apply", pipeline.process_application, jid, uid, True, label="Submitting application")


@app.post("/api/jobs/{jid}/retry")
def retry(jid: int, user: dict = Depends(auth.get_current_user)):
    if not db.get_job(jid, uid=user["id"]):
        raise HTTPException(404)
    return _start("apply", pipeline.process_application, jid, user["id"], False, label="Retrying")


class StatusBody(BaseModel):
    status: str


@app.post("/api/jobs/{jid}/status")
def set_status(jid: int, b: StatusBody, user: dict = Depends(auth.get_current_user)):
    if b.status not in ("new", "skipped", "applied", "manual"):
        raise HTTPException(400, "bad status")
    if not db.get_job(jid, uid=user["id"]):
        raise HTTPException(404)
    fields = {"status": b.status}
    if b.status == "applied":
        fields.update(
            applied_by="human",
            applied_at=datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
            note="Applied by you.",
        )
    if not db.set_job(jid, uid=user["id"], **fields):
        raise HTTPException(404)
    return {"ok": True}


@app.get("/api/notify")
def get_notify(user: dict = Depends(auth.get_current_user)):
    return config.get_notify_config()


@app.put("/api/notify")
def put_notify(b: Body, user: dict = Depends(auth.get_current_user)):
    return config.save_notify_config(b.data or {})


@app.post("/api/test-notify")
def test_notify(user: dict = Depends(auth.get_current_user)):
    return {"sent": notify.notify("Test notification", "JobPilot can reach you here. If you got this, email / alerts are working.")}
