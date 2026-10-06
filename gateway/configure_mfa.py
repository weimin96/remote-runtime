from __future__ import annotations

import argparse
import getpass
import sys

from .config import Settings
from .database import Database
from .mfa import provision_owner_mfa
from .security import verify_password


def main() -> None:
    parser = argparse.ArgumentParser(
        description="为现有本机模式 Owner 配置或轮换 TOTP MFA，并生成新的恢复码。"
    )
    parser.add_argument("email", help="Owner 登录邮箱")
    args = parser.parse_args()

    email = args.email.strip().lower()
    settings = Settings.from_env()
    database = Database(settings.database_path)
    database.initialize()
    owner = database.get_user_by_email(email)
    if owner is None or not owner.get("is_owner"):
        print("Owner 不存在", file=sys.stderr)
        raise SystemExit(1)

    password = getpass.getpass("Owner password: ")
    if not verify_password(password, owner["password_hash"]):
        print("Owner 密码错误", file=sys.stderr)
        raise SystemExit(1)

    secret, recovery_codes, otpauth_uri = provision_owner_mfa(
        database,
        owner["id"],
        owner["email"],
    )
    print("TOTP configured. All existing web sessions and OAuth tokens were revoked.")
    print("\nTOTP secret:")
    print(secret)
    print("\notpauth URI:")
    print(otpauth_uri)
    print("\nRecovery codes (shown once):")
    for code in recovery_codes:
        print(code)


if __name__ == "__main__":
    main()
