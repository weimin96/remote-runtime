from __future__ import annotations

import json
import os
import re
import uuid
import zipfile
from pathlib import Path

import remote_agent
from remote_agent.core.version import AGENT_VERSION, CORE_VERSION

from .profiles import PROFILE_REGISTRY, validate_profiles


class AgentBuildError(Exception):
    pass


GITHUB_ACTIONS_TEMPLATE = """name: Remote Agent Session

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: remote-agent-${{ github.repository }}
  cancel-in-progress: true

jobs:
  remote-agent:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      REMOTE_AGENT_DIR: __AGENT_DIR__
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          persist-credentials: false

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install Agent dependency
        run: python -m pip install -r "$REMOTE_AGENT_DIR/requirements.txt"

      - name: Keep remote Agent online
        env:
          REMOTE_AGENT_CONFIG_B64: ${{ secrets.REMOTE_AGENT_CONFIG_B64 }}
        run: >-
          python "$REMOTE_AGENT_DIR/run.py"
          --config-env REMOTE_AGENT_CONFIG_B64
          --workdir "$GITHUB_WORKSPACE"
"""

SYSTEMD_TEMPLATE = """[Unit]
Description=Remote Runtime device agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=remote-agent
Group=remote-agent
WorkingDirectory=/srv/remote-agent-work
ExecStart=/opt/remote-agent/.venv/bin/python /opt/remote-agent/run.py --config /var/lib/remote-agent/config.json --workdir /srv/remote-agent-work
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=/var/lib/remote-agent /srv/remote-agent-work

[Install]
WantedBy=multi-user.target
"""

AGENT_DOCKERFILE_TEMPLATE = """FROM python:3.12-slim

RUN groupadd --gid 10001 remote-agent \\
    && useradd --uid 10001 --gid remote-agent --create-home remote-agent
WORKDIR /opt/remote-agent
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY --chown=remote-agent:remote-agent . ./
USER 10001:10001
ENTRYPOINT [\"python\", \"run.py\"]
CMD [\"--config\", \"/var/lib/remote-agent/config.json\", \"--workdir\", \"/workspace\"]
"""

AGENT_COMPOSE_TEMPLATE = """services:
  remote-agent:
    build:
      context: .
      dockerfile: Dockerfile.agent.example
    restart: unless-stopped
    user: \"10001:10001\"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:size=64m,mode=1777
    volumes:
      - ./state:/var/lib/remote-agent
      - ./workspace:/workspace
"""


class PythonAgentBuilder:
    runtime = "python"

    def __init__(self, output_dir: Path):
        self.output_dir = output_dir
        self.package_root = Path(remote_agent.__file__).resolve().parent

    @staticmethod
    def _safe_slug(name: str) -> str:
        slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", name.strip()).strip("-").lower()
        return slug[:48] or "remote-agent"

    def build(
        self,
        *,
        bundle_id: str,
        name: str,
        description: str,
        profiles: list[str],
    ) -> tuple[Path, str]:
        selected = validate_profiles(profiles)
        for profile_id in selected:
            if self.runtime not in PROFILE_REGISTRY[profile_id]["implementations"]:
                raise AgentBuildError(f"Profile {profile_id} 没有 Python 实现")

        self.output_dir.mkdir(parents=True, exist_ok=True)
        filename = f"remote-agent-{self._safe_slug(name)}-{bundle_id[:8]}.zip"
        destination = self.output_dir / filename
        temporary = destination.with_suffix(".zip.tmp")
        archive_root = filename.removesuffix(".zip")
        manifest = {
            "runtime": self.runtime,
            "agent_version": AGENT_VERSION,
            "core_version": CORE_VERSION,
            "build_id": bundle_id,
            "profiles": selected,
            "agent": {"name": name, "description": description},
        }
        launcher = (
            "from pathlib import Path\n"
            "from remote_agent.cli import main\n\n"
            "if __name__ == '__main__':\n"
            "    main(default_config=Path(__file__).resolve().parent / '.agent' / 'config.json')\n"
        )
        readme = (
            "Remote Runtime - Python Agent\n"
            "===================================\n\n"
            "1. Install dependency: python -m pip install -r requirements.txt\n"
            "2. Run the one-time enrollment command shown by the gateway.\n"
            "3. Later restarts only need: python run.py\n\n"
            "Device credentials default to .agent/config.json. The Agent checks that this\n"
            "location is writable before consuming the enrollment token. For services,\n"
            "read-only directories, or containers, use --config with a persistent path.\n"
            "\n"
            "GitHub Actions / CI\n"
            "-------------------\n"
            "1. Register this dedicated Agent once with the normal enrollment command.\n"
            "2. Stop it, then encode .agent/config.json as a single-line Base64 value:\n"
            "   python -c \"import base64,pathlib; print(base64.b64encode(pathlib.Path('.agent/config.json').read_bytes()).decode())\"\n"
            "3. Save the output as the repository secret REMOTE_AGENT_CONFIG_B64.\n"
            "4. Keep this Agent directory at the repository root and copy\n"
            "   github-actions.yml.example to .github/workflows/remote-agent.yml.\n"
            "5. Start 'Remote Agent Session' manually from the Actions page.\n"
            "\n"
            "The CI secret is consumed and removed from the Agent process environment\n"
            "before shell commands can run. Never commit .agent/config.json, and do not\n"
            "run the same device credential in two places at the same time.\n"
            "\n"
            "Least-privilege production deployment\n"
            "-------------------------------------\n"
            "shell.v1 always inherits the operating-system account that starts this\n"
            "process. --workdir limits workspace.v1 paths but is NOT a shell sandbox.\n"
            "Never run a production shell Agent as root or Administrator.\n"
            "\n"
            "Linux: create an unprivileged remote-agent account with no sudo access,\n"
            "make /opt/remote-agent read-only to it, and grant it access only to\n"
            "/var/lib/remote-agent plus the intended workspace. Adapt and install\n"
            "remote-agent.service.example after the first enrollment.\n"
            "Example preparation commands (run as root):\n"
            "   useradd --system --home /var/lib/remote-agent --shell /usr/sbin/nologin remote-agent\n"
            "   install -d -o remote-agent -g remote-agent -m 0700 /var/lib/remote-agent\n"
            "   install -d -o remote-agent -g remote-agent -m 0750 /srv/remote-agent-work\n"
            "   chown -R root:root /opt/remote-agent && chmod -R go-w /opt/remote-agent\n"
            "Run the enrollment command once with 'sudo -u remote-agent' and the\n"
            "service template's --config/--workdir paths, then enable the service.\n"
            "\n"
            "Windows: create a dedicated Standard local user (not Administrators),\n"
            "deny interactive use where policy permits, grant that user Read/Execute\n"
            "on the Agent directory and Modify only on .agent plus the intended\n"
            "workspace, then run the scheduled task or service as that user.\n"
            "From an elevated PowerShell, create the account with New-LocalUser, then\n"
            "use icacls to remove inherited broad access where appropriate and grant\n"
            "'<computer>\\remote-agent:(OI)(CI)RX' on the Agent directory plus\n"
            "'<computer>\\remote-agent:(OI)(CI)M' on .agent and the workspace.\n"
            "Do not add this account to Administrators or Remote Desktop Users.\n"
            "\n"
            "Container: use Dockerfile.agent.example and compose.agent.yml.example.\n"
            "They run as UID 10001 with a read-only root filesystem, all capabilities\n"
            "dropped, and only state/workspace mounted writable. Before first start,\n"
            "create state/workspace and make them writable by UID/GID 10001.\n"
            "Enroll once with: docker compose -f compose.agent.yml.example run --rm\n"
            "   remote-agent --config /var/lib/remote-agent/config.json --workdir /workspace\n"
            "   --gateway wss://gateway.example/ws/agent --token <enrollment-token>\n"
        )
        github_actions = GITHUB_ACTIONS_TEMPLATE.replace("__AGENT_DIR__", archive_root)

        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(f"{archive_root}/run.py", launcher)
                archive.writestr(f"{archive_root}/requirements.txt", "websockets>=14,<18\n")
                archive.writestr(f"{archive_root}/README.txt", readme)
                archive.writestr(
                    f"{archive_root}/.gitignore",
                    ".agent/\n__pycache__/\n*.py[cod]\n",
                )
                archive.writestr(
                    f"{archive_root}/github-actions.yml.example",
                    github_actions,
                )
                archive.writestr(
                    f"{archive_root}/remote-agent.service.example",
                    SYSTEMD_TEMPLATE,
                )
                archive.writestr(
                    f"{archive_root}/Dockerfile.agent.example",
                    AGENT_DOCKERFILE_TEMPLATE,
                )
                archive.writestr(
                    f"{archive_root}/compose.agent.yml.example",
                    AGENT_COMPOSE_TEMPLATE,
                )
                archive.writestr(
                    f"{archive_root}/remote_agent/manifest.json",
                    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                )
                self._write_file(archive, self.package_root / "__init__.py", archive_root)
                self._write_file(archive, self.package_root / "__main__.py", archive_root)
                self._write_file(archive, self.package_root / "cli.py", archive_root)
                for source in sorted((self.package_root / "core").glob("*.py")):
                    self._write_file(archive, source, archive_root)
                self._write_file(archive, self.package_root / "profiles" / "__init__.py", archive_root)
                self._write_file(archive, self.package_root / "profiles" / "base.py", archive_root)
                self._write_file(archive, self.package_root / "profiles" / "registry.py", archive_root)
                self._write_tree(archive, self.package_root / "profiles" / "common", archive_root)
                for profile_id in selected:
                    source_name = PROFILE_REGISTRY[profile_id]["implementations"][self.runtime]["source"]
                    source = self.package_root / "profiles" / source_name
                    if source.is_dir():
                        self._write_tree(archive, source, archive_root)
                    else:
                        self._write_file(archive, source, archive_root)
            os.replace(temporary, destination)
        except OSError as exc:
            if temporary.exists():
                temporary.unlink()
            raise AgentBuildError(f"生成 Agent 包失败: {exc}") from exc
        return destination, filename

    def _write_file(self, archive: zipfile.ZipFile, source: Path, archive_root: str) -> None:
        if not source.is_file():
            raise AgentBuildError(f"Agent 源文件不存在: {source.name}")
        relative = source.relative_to(self.package_root)
        archive.write(source, f"{archive_root}/remote_agent/{relative.as_posix()}")

    def _write_tree(self, archive: zipfile.ZipFile, source: Path, archive_root: str) -> None:
        if not source.is_dir():
            raise AgentBuildError(f"Agent 源目录不存在: {source.name}")
        for child in sorted(source.rglob("*")):
            if child.is_file() and child.suffix == ".py":
                self._write_file(archive, child, archive_root)


def new_bundle_id() -> str:
    return str(uuid.uuid4())
