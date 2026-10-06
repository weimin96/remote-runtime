from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from dataclasses import dataclass


SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
TOTP_PERIOD_SECONDS = 30
TOTP_DIGITS = 6


@dataclass(frozen=True, slots=True)
class IssuedToken:
    value: str
    prefix: str
    digest: str


def issue_token(kind: str, entropy_bytes: int = 32) -> IssuedToken:
    value = f"{kind}_{secrets.token_urlsafe(entropy_bytes)}"
    return IssuedToken(value=value, prefix=value[:14], digest=hash_token(value))


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_totp_secret(entropy_bytes: int = 20) -> str:
    return base64.b32encode(secrets.token_bytes(entropy_bytes)).decode("ascii").rstrip("=")


def totp_code(
    secret: str,
    *,
    at_time: int | float | None = None,
    digits: int = TOTP_DIGITS,
    period: int = TOTP_PERIOD_SECONDS,
) -> str:
    normalized = secret.strip().replace(" ", "").upper()
    padding = "=" * ((8 - len(normalized) % 8) % 8)
    key = base64.b32decode(normalized + padding, casefold=True)
    timestamp = time.time() if at_time is None else at_time
    counter = int(timestamp // period)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return f"{binary % (10**digits):0{digits}d}"


def verify_totp_code(
    secret: str,
    code: str,
    *,
    at_time: int | float | None = None,
    window: int = 1,
) -> bool:
    candidate = code.strip().replace(" ", "")
    if len(candidate) != TOTP_DIGITS or not candidate.isdigit():
        return False
    timestamp = time.time() if at_time is None else at_time
    for offset in range(-window, window + 1):
        expected = totp_code(
            secret,
            at_time=timestamp + offset * TOTP_PERIOD_SECONDS,
        )
        if hmac.compare_digest(candidate, expected):
            return True
    return False


def generate_recovery_codes(count: int = 8) -> list[str]:
    codes: list[str] = []
    for _ in range(count):
        raw = base64.b32encode(secrets.token_bytes(10)).decode("ascii").rstrip("=")
        codes.append("-".join(raw[index : index + 4] for index in range(0, len(raw), 4)))
    return codes


def normalize_recovery_code(code: str) -> str:
    return "".join(character for character in code.upper() if character.isalnum())


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=32,
    )
    return "scrypt${}${}${}${}${}".format(
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(derived).decode("ascii"),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt_text, digest_text = encoded.split("$", 5)
        if algorithm != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(salt_text.encode("ascii"))
        expected = base64.urlsafe_b64decode(digest_text.encode("ascii"))
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)

