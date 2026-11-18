"""Authentication helpers for multi-user JobPilot."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Optional

from fastapi import Cookie, Depends, HTTPException, Request, Response

from . import config, db

SESSION_COOKIE = "jp_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 14  # 14 days


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 200_000)
    return f"pbkdf2${salt}${dk.hex()}"


def verify_password(plain: str, hashed: str) -> bool:
    if not hashed or not hashed.startswith("pbkdf2$"):
        return False
    try:
        _, salt, dig = hashed.split("$", 2)
        dk = hashlib.pbkdf2_hmac("sha256", plain.encode("utf-8"), salt.encode("utf-8"), 200_000)
        return hmac.compare_digest(dk.hex(), dig)
    except Exception:
        return False


def _secret() -> bytes:
    return (getattr(config, "SECRET_KEY", None) or "jobpilot-change-me-in-production-please").encode("utf-8")


def create_session_token(user_id: int) -> str:
    payload = json.dumps({"uid": int(user_id), "exp": int(time.time()) + SESSION_MAX_AGE, "r": secrets.token_hex(8)}, separators=(",", ":"))
    body = base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")
    sig = hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def load_session_token(token: str) -> Optional[int]:
    if not token or "." not in token:
        return None
    try:
        body, sig = token.rsplit(".", 1)
        expect = hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expect, sig):
            return None
        pad = "=" * (-len(body) % 4)
        data = json.loads(base64.urlsafe_b64decode(body + pad).decode("utf-8"))
        if int(data.get("exp", 0)) < time.time():
            return None
        return int(data["uid"])
    except Exception:
        return None


def set_session_cookie(response: Response, user_id: int):
    token = create_session_token(user_id)
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")


def get_current_user(
    request: Request,
    jp_session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    uid = load_session_token(jp_session)
    if not uid:
        raise HTTPException(status_code=401, detail="Please log in")
    user = db.get_user_by_id(uid)
    if not user:
        raise HTTPException(status_code=401, detail="Please log in")
    return user


def get_optional_user(
    request: Request,
    jp_session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> Optional[dict]:
    uid = load_session_token(jp_session)
    if not uid:
        return None
    return db.get_user_by_id(uid)


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin only")
    return user


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else ""


def record_login(user_id: int, success: bool, request: Request):
    db.add_login_history(
        user_id=user_id,
        ip=client_ip(request),
        user_agent=(request.headers.get("user-agent") or "")[:240],
        success=success,
    )
    if success:
        db.bump_login(user_id)
