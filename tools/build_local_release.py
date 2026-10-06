from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from datetime import datetime, timezone


ROOT = pathlib.Path(__file__).resolve().parents[1]


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(*args: str, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        args,
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or result.stdout.strip() or f"command failed: {args}")
    return result.stdout.strip()


def project_version() -> str:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    version = project["project"]["version"]
    source = (ROOT / "remote_agent" / "core" / "version.py").read_text(encoding="utf-8")
    match = re.search(r'^AGENT_VERSION = "([^"]+)"$', source, re.MULTILINE)
    if match is None or match.group(1) != version:
        raise SystemExit("project version and AGENT_VERSION do not match")
    return version


def git_metadata(allow_dirty: bool) -> tuple[str, int, bool]:
    dirty = bool(run("git", "status", "--porcelain"))
    if dirty and not allow_dirty:
        raise SystemExit("repository is dirty; commit changes or pass --allow-dirty")
    commit = run("git", "rev-parse", "HEAD")
    epoch = int(run("git", "show", "-s", "--format=%ct", "HEAD"))
    return commit, epoch, dirty


def add_file_to_tar(archive: tarfile.TarFile, path: pathlib.Path, arcname: str, epoch: int) -> None:
    info = archive.gettarinfo(str(path), arcname=arcname)
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = epoch
    info.mode = 0o755 if path.suffix == ".sh" else 0o644
    with path.open("rb") as handle:
        archive.addfile(info, handle)


def build(output_dir: pathlib.Path, allow_dirty: bool) -> pathlib.Path:
    version = project_version()
    commit, epoch, dirty = git_metadata(allow_dirty)
    short_commit = commit[:12]
    release_id = f"v{version}-{short_commit}{'-dirty' if dirty else ''}"
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="remote-agent-release-") as temp:
        tempdir = pathlib.Path(temp)
        wheel_dir = tempdir / "wheel"
        wheel_dir.mkdir()
        env = os.environ.copy()
        env["SOURCE_DATE_EPOCH"] = str(epoch)
        run(sys.executable, "-m", "build", "--wheel", "--outdir", str(wheel_dir), env=env)
        wheels = list(wheel_dir.glob("remote_agent_gateway-*.whl"))
        if len(wheels) != 1:
            raise SystemExit(f"expected one wheel, found: {wheels}")

        stage = tempdir / f"remote-agent-gateway-{release_id}"
        stage.mkdir()
        wheel = wheels[0]
        shutil.copy2(wheel, output_dir / wheel.name)
        shutil.copy2(wheel, stage / wheel.name)
        for relative in (
            "deploy/install-local-runtime.sh",
            "deploy/upgrade-local-runtime.sh",
            "deploy/check-local-runtime.sh",
            "deploy/remote-agent-gateway.service.example",
            "deploy/remote-agent-gateway.sudoers.example",
            "deploy/Caddyfile.local.example",
            "deploy/nginx.local.example",
            "README.md",
            "LICENSE",
        ):
            source = ROOT / relative
            target = stage / pathlib.Path(relative).name
            shutil.copy2(source, target)

        manifest = {
            "format_version": 1,
            "project": "remote-agent-gateway",
            "artifact_type": "local-runtime",
            "version": version,
            "commit": commit,
            "dirty": dirty,
            "release_id": release_id,
            "python_requires": ">=3.11",
            "source_date_epoch": epoch,
            "source_date": datetime.fromtimestamp(epoch, timezone.utc).isoformat(),
        }
        (stage / "release.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        checksum_lines = []
        for path in sorted(stage.iterdir(), key=lambda item: item.name):
            if path.name == "SHA256SUMS.txt" or not path.is_file():
                continue
            checksum_lines.append(f"{sha256(path)}  {path.name}")
        (stage / "SHA256SUMS.txt").write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")

        artifact = output_dir / f"remote-agent-gateway-{release_id}-linux.tar.gz"
        with artifact.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch) as zipped:
                with tarfile.open(fileobj=zipped, mode="w") as archive:
                    for path in sorted(stage.iterdir(), key=lambda item: item.name):
                        add_file_to_tar(archive, path, f"{stage.name}/{path.name}", epoch)

        checksum_path = artifact.with_suffix(artifact.suffix + ".sha256")
        checksum_path.write_text(f"{sha256(artifact)}  {artifact.name}\n", encoding="utf-8")
        print(artifact)
        return artifact


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a deterministic local-runtime release artifact")
    parser.add_argument("--output-dir", default="dist", type=pathlib.Path)
    parser.add_argument("--allow-dirty", action="store_true")
    args = parser.parse_args()
    build(args.output_dir.resolve(), args.allow_dirty)


if __name__ == "__main__":
    main()
