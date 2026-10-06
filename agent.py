"""Compatibility entry point for the modular remote Agent package."""

from remote_agent.cli import main
from remote_agent.profiles.shell_v1 import MAX_CAPTURE_BYTES, TRUNCATION_MARKER, ShellExecutor

__all__ = ["MAX_CAPTURE_BYTES", "TRUNCATION_MARKER", "ShellExecutor", "main"]


if __name__ == "__main__":
    main()
