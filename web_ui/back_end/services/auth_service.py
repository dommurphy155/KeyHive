from __future__ import annotations

import hmac
import os
from pathlib import Path

from dotenv import load_dotenv

# Resolve the project root from this module so the Web UI does not depend on a
# fixed checkout path.
ROOT_DIR = Path(__file__).resolve().parents[3]
load_dotenv(ROOT_DIR / ".env")

# The login page can validate either a password-style secret or a token-style
# secret. Route protection is not wired up yet, but the secret check is here.
PASSWORD_ENV = "KEYHIVE_WEB_PASSWORD"
TOKEN_ENV = "KEYHIVE_WEB_AUTH_TOKEN"


def configured_secret() -> tuple[str | None, str]:
    # Prefer the password value if both are present so the config has a single
    # clear "active" secret for the login form.
    password = os.getenv(PASSWORD_ENV, "")
    if password:
        return password, "password"
    token = os.getenv(TOKEN_ENV, "")
    if token:
        return token, "token"
    return None, "unconfigured"


def auth_config() -> dict[str, object]:
    # The frontend uses this to tell the operator whether the login form is
    # actually configured or just sitting there looking decorative.
    _secret, mode = configured_secret()
    return {
        "configured": mode != "unconfigured",
        "mode": mode,
        "protects_ui": False,
        "note": "Login foundation only; route protection is not enabled yet.",
    }


def verify_login(value: str) -> bool:
    # Constant-time comparison avoids leaking the configured secret through a
    # timing side channel, even though the route is not yet hard-protected.
    secret, _mode = configured_secret()
    if not secret or not value:
        return False
    return hmac.compare_digest(value, secret)
