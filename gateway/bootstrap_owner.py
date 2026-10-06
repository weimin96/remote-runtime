from __future__ import annotations

import argparse
import getpass
import secrets
import sys

from .config import Settings
from .database import ConflictError, Database
from .mfa import provision_owner_mfa
from .security import hash_password


def _normalize_email(raw: str) -> str:
    email = raw.strip().lower()
    if email.count("@") != 1 or email.startswith("@") or email.endswith("@"):
        raise ValueError("请输入有效邮箱")
    return email


def main() -> None:
    parser = argparse.ArgumentParser(
        description="初始化本机执行模式的唯一 Owner。只允许在数据库没有任何用户时执行一次。"
    )
    parser.add_argument("email", help="Owner 登录邮箱")
    parser.add_argument(
        "--generate-credentials",
        action="store_true",
        help="为无人值守首次部署生成强随机密码，并与 TOTP/恢复码一起输出一次",
    )
    args = parser.parse_args()

    try:
        email = _normalize_email(args.email)
    except ValueError as exc:
        parser.error(str(exc))

    if args.generate_credentials:
        password = secrets.token_urlsafe(24)
    else:
        password = getpass.getpass("Owner password: ")
        if len(password) < 12:
            print("密码至少需要 12 位", file=sys.stderr)
            raise SystemExit(2)
        confirm = getpass.getpass("Confirm password: ")
        if password != confirm:
            print("两次密码不一致", file=sys.stderr)
            raise SystemExit(2)

    settings = Settings.from_env()
    database = Database(settings.database_path)
    database.initialize()
    try:
        owner = database.create_owner(email, hash_password(password))
    except ConflictError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
    secret, recovery_codes, otpauth_uri = provision_owner_mfa(
        database,
        owner["id"],
        owner["email"],
    )
    print(f"Owner created: {owner['email']}")
    if args.generate_credentials:
        print("\nGenerated owner password (shown once):")
        print(password)
    print("\nTOTP secret (save in your authenticator):")
    print(secret)
    print("\notpauth URI:")
    print(otpauth_uri)
    print("\nRecovery codes (shown once):")
    for code in recovery_codes:
        print(code)
    print("\nStore the recovery codes offline. Configuring MFA revoked any existing sessions/tokens.")


if __name__ == "__main__":
    main()
