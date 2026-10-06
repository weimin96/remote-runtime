from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path
from typing import Any


PROJECT_MARKERS = (
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
)
RULE_FILES = ("AGENTS.md", "CLAUDE.md", "README.md", "README", "CONTRIBUTING.md")
SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    ".venv",
    "venv",
    "node_modules",
    "target",
    "build",
    "dist",
    ".next",
    "vendor",
    "__pycache__",
}


def _git(path: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(path), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def _read_package_scripts(path: Path) -> dict[str, str]:
    package = path / "package.json"
    if not package.is_file():
        return {}
    try:
        payload = json.loads(package.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    scripts = payload.get("scripts")
    if not isinstance(scripts, dict):
        return {}
    return {
        str(name): str(command)
        for name, command in scripts.items()
        if isinstance(name, str) and isinstance(command, str)
    }


def _detected_commands(path: Path, markers: list[str]) -> dict[str, list[str]]:
    commands: dict[str, list[str]] = {}
    marker_set = set(markers)
    if "pom.xml" in marker_set:
        wrapper = "./mvnw" if (path / "mvnw").is_file() else "mvn"
        commands["test"] = [f"{wrapper} test"]
        commands["build"] = [f"{wrapper} package"]
    if {"build.gradle", "build.gradle.kts"} & marker_set:
        wrapper = "./gradlew" if (path / "gradlew").is_file() else "gradle"
        commands.setdefault("test", []).append(f"{wrapper} test")
        commands.setdefault("build", []).append(f"{wrapper} build")
    if "package.json" in marker_set:
        if (path / "pnpm-lock.yaml").is_file():
            manager = "pnpm"
        elif (path / "yarn.lock").is_file():
            manager = "yarn"
        else:
            manager = "npm"
        scripts = _read_package_scripts(path)
        if "test" in scripts:
            commands.setdefault("test", []).append(f"{manager} test")
        if "build" in scripts:
            commands.setdefault("build", []).append(f"{manager} run build")
        if "lint" in scripts:
            commands.setdefault("lint", []).append(f"{manager} run lint")
        if "typecheck" in scripts:
            commands.setdefault("typecheck", []).append(f"{manager} run typecheck")
    if "pyproject.toml" in marker_set:
        if (path / "uv.lock").is_file():
            commands.setdefault("test", []).append("uv run pytest")
        else:
            commands.setdefault("test", []).append("python -m pytest")
    if "Cargo.toml" in marker_set:
        commands.setdefault("test", []).append("cargo test")
        commands.setdefault("build", []).append("cargo build")
    if "go.mod" in marker_set:
        commands.setdefault("test", []).append("go test ./...")
        commands.setdefault("build", []).append("go build ./...")
    return commands


def inspect_project(path: Path) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    if not resolved.is_dir():
        raise ValueError(f"项目目录不存在或不是目录: {path}")
    markers = [name for name in PROJECT_MARKERS if (resolved / name).is_file()]
    rules = [name for name in RULE_FILES if (resolved / name).is_file()]
    is_git = (resolved / ".git").exists() or _git(resolved, "rev-parse", "--show-toplevel") is not None
    branch = _git(resolved, "branch", "--show-current") if is_git else None
    status = _git(resolved, "status", "--porcelain", "--untracked-files=no") if is_git else None
    git_root = _git(resolved, "rev-parse", "--show-toplevel") if is_git else None
    return {
        "name": resolved.name,
        "path": str(resolved),
        "git": {
            "is_repository": is_git,
            "root": git_root,
            "branch": branch,
            "dirty": bool(status) if status is not None else None,
        },
        "markers": markers,
        "rule_files": rules,
        "package_scripts": _read_package_scripts(resolved),
        "suggested_commands": _detected_commands(resolved, markers),
    }


def discover_projects(root: Path, max_depth: int) -> list[dict[str, Any]]:
    resolved_root = root.expanduser().resolve()
    if not resolved_root.is_dir():
        raise ValueError(f"搜索目录不存在或不是目录: {root}")
    projects: list[dict[str, Any]] = []
    seen: set[Path] = set()

    def visit(directory: Path, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            entries = list(os.scandir(directory))
        except (OSError, PermissionError):
            return
        names = {entry.name for entry in entries}
        is_project = ".git" in names or any(marker in names for marker in PROJECT_MARKERS)
        if is_project:
            resolved = directory.resolve()
            if resolved not in seen:
                seen.add(resolved)
                projects.append(inspect_project(resolved))
            # A repository root is the useful project boundary. Do not recursively
            # enumerate every package inside a monorepo as an independent project.
            if ".git" in names:
                return
        if depth == max_depth:
            return
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False) or entry.name in SKIP_DIRS:
                continue
            visit(Path(entry.path), depth + 1)

    visit(resolved_root, 0)
    projects.sort(key=lambda item: item["path"])
    return projects


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="remote-project",
        description="Discover and inspect development projects without executing project code.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    discover = subparsers.add_parser("discover", help="Find project roots under one directory")
    discover.add_argument("root", nargs="?", default=".")
    discover.add_argument("--max-depth", type=int, default=3)

    inspect = subparsers.add_parser("inspect", help="Inspect one project root")
    inspect.add_argument("path", nargs="?", default=".")

    args = parser.parse_args()
    try:
        if args.command == "discover":
            if args.max_depth < 0 or args.max_depth > 8:
                raise ValueError("--max-depth 必须在 0 到 8 之间")
            result: Any = {"projects": discover_projects(Path(args.root), args.max_depth)}
        else:
            result = inspect_project(Path(args.path))
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
