---
name: remote-ssh
description: Use the Remote SSH plugin whenever the user asks Codex to connect to, inspect, develop on, deploy to, or run commands on an SSH server or remote host.
---

# Remote SSH

When the user's task targets an SSH server or remote host, prefer the Remote SSH plugin tools over invoking the local `ssh` executable through a generic shell tool.

Use this sequence:

1. Call `ssh.listHosts` to resolve configured hosts when needed.
2. For connectivity checks, use `ssh.testConnection`. It runs a fixed read-only probe and streams the result to the Remote SSH UI.
3. Call `ssh.exec` for general remote commands. This is the primary execution path because it streams command lifecycle events to the Remote SSH UI.
4. If `ssh.exec` returns a running `sessionId`, continue with `ssh.poll` until completion or cancellation.
5. Do not expose or read private-key contents. Let OpenSSH handle `IdentityFile`, `ssh-agent`, `ProxyJump`, and `known_hosts`.
6. Use a local shell `ssh ...` command only when the plugin cannot express the operation or is unavailable, and state that fallback explicitly.
