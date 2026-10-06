from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import tomllib
from datetime import datetime, timezone


ROOT = pathlib.Path(__file__).resolve().parents[1]
PLUGIN_ROOT = ROOT / "apps" / "codex-remote-ssh"


def run(*args: str, cwd: pathlib.Path = ROOT, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or result.stdout.strip() or f"command failed: {args}")
    return result.stdout.strip()


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def project_version() -> str:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    version = project["project"]["version"]
    package = json.loads((PLUGIN_ROOT / "package.json").read_text(encoding="utf-8"))
    plugin = json.loads(
        (PLUGIN_ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
    )
    if package["version"] != version or plugin["version"] != version:
        raise SystemExit("Remote Runtime and Remote SSH versions do not match")
    return version


def git_metadata(allow_dirty: bool) -> tuple[str, int, bool]:
    dirty = bool(run("git", "status", "--porcelain"))
    if dirty and not allow_dirty:
        raise SystemExit("repository is dirty; commit changes or pass --allow-dirty")
    commit = run("git", "rev-parse", "HEAD")
    epoch = int(run("git", "show", "-s", "--format=%ct", "HEAD"))
    return commit, epoch, dirty


def node_platform() -> str:
    value = run("node", "-p", "process.platform + '-' + process.arch", cwd=PLUGIN_ROOT)
    if value not in {"darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"}:
        raise SystemExit(f"unsupported stable Remote SSH release platform: {value}")
    return value


def add_file(archive: tarfile.TarFile, path: pathlib.Path, arcname: str, epoch: int) -> None:
    info = archive.gettarinfo(str(path), arcname=arcname)
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = epoch
    info.mode = 0o755 if path.name == "spawn-helper" else 0o644
    with path.open("rb") as handle:
        archive.addfile(info, handle)


def add_tree(archive: tarfile.TarFile, source: pathlib.Path, target: str, epoch: int) -> None:
    for path in sorted(source.rglob("*"), key=lambda item: item.as_posix()):
        if not path.is_file():
            continue
        relative = path.relative_to(source).as_posix()
        add_file(archive, path, f"{target}/{relative}", epoch)


def stage_node_pty(target: pathlib.Path, target_platform: str) -> None:
    source = PLUGIN_ROOT / "node_modules" / "node-pty"
    target.mkdir(parents=True)
    shutil.copy2(source / "package.json", target / "package.json")
    shutil.copy2(source / "LICENSE", target / "LICENSE")
    lib_target = target / "lib"
    lib_target.mkdir()
    for path in sorted((source / "lib").glob("*.js")):
        shutil.copy2(path, lib_target / path.name)

    prebuild = source / "prebuilds" / target_platform
    compiled = source / "build" / "Release"
    if prebuild.is_dir():
        shutil.copytree(prebuild, target / "prebuilds" / target_platform)
    elif compiled.is_dir():
        shutil.copytree(compiled, target / "build" / "Release")
    else:
        raise SystemExit(
            f"node-pty has no native runtime for {target_platform}; run npm ci on the target platform"
        )


def build(output_dir: pathlib.Path, allow_dirty: bool) -> pathlib.Path:
    version = project_version()
    commit, epoch, dirty = git_metadata(allow_dirty)
    target_platform = node_platform()
    release_id = f"v{version}-{commit[:12]}{'-dirty' if dirty else ''}-{target_platform}"
    output_dir.mkdir(parents=True, exist_ok=True)

    if not (PLUGIN_ROOT / "node_modules" / "node-pty").is_dir():
        raise SystemExit("Remote SSH dependencies are missing; run npm ci first")

    run("npm", "run", "build", cwd=PLUGIN_ROOT)
    run(
        "node",
        "-e",
        "import('node-pty').then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); })",
        cwd=PLUGIN_ROOT,
    )

    with tempfile.TemporaryDirectory(prefix="remote-ssh-release-") as temp:
        tempdir = pathlib.Path(temp)
        stage = tempdir / f"remote-ssh-{release_id}"
        plugin_stage = stage / "apps" / "codex-remote-ssh"
        (stage / ".agents" / "plugins").mkdir(parents=True)
        plugin_stage.mkdir(parents=True)

        shutil.copy2(ROOT / ".agents" / "plugins" / "marketplace.json", stage / ".agents" / "plugins" / "marketplace.json")
        shutil.copy2(ROOT / "LICENSE", stage / "LICENSE")
        shutil.copy2(PLUGIN_ROOT / "README.md", plugin_stage / "README.md")
        shutil.copy2(PLUGIN_ROOT / "package.json", plugin_stage / "package.json")
        shutil.copy2(PLUGIN_ROOT / ".mcp.json", plugin_stage / ".mcp.json")
        shutil.copytree(PLUGIN_ROOT / ".codex-plugin", plugin_stage / ".codex-plugin")
        shutil.copytree(PLUGIN_ROOT / "assets", plugin_stage / "assets")
        shutil.copytree(PLUGIN_ROOT / "dist", plugin_stage / "dist")
        stage_node_pty(plugin_stage / "node_modules" / "node-pty", target_platform)
        run(
            "node",
            "-e",
            "import('node-pty').then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); })",
            cwd=plugin_stage,
        )

        manifest = {
            "format_version": 1,
            "project": "remote-runtime",
            "artifact_type": "codex-remote-ssh",
            "version": version,
            "commit": commit,
            "dirty": dirty,
            "platform": target_platform,
            "release_id": release_id,
            "source_date_epoch": epoch,
            "source_date": datetime.fromtimestamp(epoch, timezone.utc).isoformat(),
        }
        (stage / "release.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        artifact = output_dir / f"remote-ssh-{release_id}.tar.gz"
        with artifact.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch) as zipped:
                with tarfile.open(fileobj=zipped, mode="w") as archive:
                    add_tree(archive, stage, stage.name, epoch)

        checksum_path = artifact.with_suffix(artifact.suffix + ".sha256")
        checksum_path.write_text(f"{sha256(artifact)}  {artifact.name}\n", encoding="utf-8")
        print(artifact)
        return artifact


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a deterministic Codex Remote SSH release")
    parser.add_argument("--output-dir", default="dist", type=pathlib.Path)
    parser.add_argument("--allow-dirty", action="store_true")
    args = parser.parse_args()
    build(args.output_dir.resolve(), args.allow_dirty)


if __name__ == "__main__":
    main()
