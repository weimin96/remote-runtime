from __future__ import annotations

from urllib.parse import quote, urlencode

from .database import Database
from .security import (
    generate_recovery_codes,
    generate_totp_secret,
    hash_token,
    normalize_recovery_code,
    verify_totp_code,
)


def provision_owner_mfa(
    db: Database,
    user_id: str,
    email: str,
) -> tuple[str, list[str], str]:
    secret = generate_totp_secret()
    recovery_codes = generate_recovery_codes()
    recovery_hashes = [hash_token(normalize_recovery_code(code)) for code in recovery_codes]
    db.configure_owner_mfa(user_id, secret, recovery_hashes)
    issuer = "Remote Runtime"
    label = quote(f"{issuer}:{email}", safe="")
    query = urlencode(
        {
            "secret": secret,
            "issuer": issuer,
            "algorithm": "SHA1",
            "digits": "6",
            "period": "30",
        }
    )
    return secret, recovery_codes, f"otpauth://totp/{label}?{query}"


def verify_owner_mfa_code(db: Database, user_id: str, code: str) -> bool:
    secret = db.get_owner_mfa_secret(user_id)
    if secret is None:
        return False
    if verify_totp_code(secret, code):
        return True
    recovery = normalize_recovery_code(code)
    if len(recovery) < 12:
        return False
    return db.consume_owner_recovery_code(user_id, hash_token(recovery))
