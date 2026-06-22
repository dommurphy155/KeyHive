from __future__ import annotations

import hmac
import os

from dotenv import load_dotenv

load_dotenv("/root/api_maker/.env")

PASSWORD_ENV = "KEYHIVE_WEB_PASSWORD"
TOKEN_ENV = "KEYHIVE_WEB_AUTH_TOKEN"


def configured_secret() -> tuple[str | None, str]:
    password = os.getenv(PASSWORD_ENV, "")
    if password:
        return password, "password"
    token = os.getenv(TOKEN_ENV, "")
    if token:
        return token, "token"
    return None, "unconfigured"


def auth_config() -> dict[str, object]:
    _secret, mode = configured_secret()
    return {
        "configured": mode != "unconfigured",
        "mode": mode,
        "protects_ui": False,
        "note": "Login foundation only; route protection is not enabled yet.",
    }


def verify_login(value: str) -> bool:
    secret, _mode = configured_secret()
    if not secret or not value:
        return False
    return hmac.compare_digest(value, secret)
