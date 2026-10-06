import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ExecutionBroker } from "../src/server/execution-broker.js";
import type { RemoteHost } from "../src/server/host-registry.js";

test("streams command lifecycle events through the broker", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-broker-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(fakeSsh, "#!/bin/sh\nprintf 'hello\\n'\nprintf 'warning\\n' >&2\nexit 0\n");
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example",
    alias: "example",
    hostname: "example.invalid",
    user: "deploy",
    port: 22,
    identityFiles: [],
    proxyJump: null,
    resolved: true,
    source: "ssh-config",
    identityFile: null,
    defaultCwd: null,
  };
  const journal = path.join(root, "events.jsonl");
  const broker = new ExecutionBroker({ eventJournalPath: journal });
  const observer = new ExecutionBroker({ eventJournalPath: journal });
  try {
    let result = await broker.exec(host, "printf ok", { yieldTimeMs: 1000 });
    const completionDeadline = Date.now() + 10_000;
    while (result.running && result.sessionId && Date.now() < completionDeadline) {
      result = await broker.poll(result.sessionId, { yieldTimeMs: 250 });
    }
    assert.equal(result.running, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "hello\n");
    assert.equal(result.stderr, "warning\n");
    const deadline = Date.now() + 10_000;
    let events = (await observer.readEvents(0)).events;
    while (!events.some((event) => event.type === "command.completed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      events = (await observer.readEvents(0)).events;
    }
    assert.deepEqual(events.map((event) => event.type), [
      "command.started",
      "stdout",
      "stderr",
      "command.completed",
    ]);
    assert.equal(events[0].host, "example");
    assert.equal(events[0].command, "printf ok");
  } finally {
    broker.close();
    observer.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("poll timeouts do not accumulate ChildProcess close listeners", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-poll-listeners-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(fakeSsh, "#!/bin/sh\nsleep 1\nprintf 'done\\n'\n");
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example", alias: "example", hostname: "example.invalid", user: "deploy", port: 22,
    identityFiles: [], proxyJump: null, resolved: true, source: "ssh-config", identityFile: null, defaultCwd: null,
  };
  const broker = new ExecutionBroker({ eventJournalPath: path.join(root, "events.jsonl") });
  try {
    const initial = await broker.exec(host, "slow-command", { yieldTimeMs: 0 });
    assert.equal(initial.running, true);
    assert.ok(initial.sessionId);
    const sessions = (broker as unknown as { sessions: Map<string, { process: { listenerCount(event: string): number } }> }).sessions;
    const child = sessions.get(initial.sessionId!)?.process;
    assert.ok(child);
    const baseline = child.listenerCount("close");
    for (let index = 0; index < 20; index += 1) {
      const result = await broker.poll(initial.sessionId!, { yieldTimeMs: 1 });
      assert.equal(result.running, true);
      assert.equal(child.listenerCount("close"), baseline);
    }
  } finally {
    broker.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("reconciles active command sessions across broker processes", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-presence-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(fakeSsh, "#!/bin/sh\nsleep 0.8\nprintf 'done\\n'\n");
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example", alias: "example", hostname: "example.invalid", user: "deploy", port: 22,
    identityFiles: [], proxyJump: null, resolved: true, source: "ssh-config", identityFile: null, defaultCwd: null,
  };
  const journal = path.join(root, "events.jsonl");
  const executor = new ExecutionBroker({ eventJournalPath: journal });
  const observer = new ExecutionBroker({ eventJournalPath: journal });
  try {
    const initial = await executor.exec(host, "slow-command", { yieldTimeMs: 0 });
    assert.equal(initial.running, true);
    assert.ok(initial.sessionId);

    const active = await observer.readEvents(0, 0);
    assert.ok(active.activeCommandSessionIds?.includes(initial.sessionId!), "observer should see command owned by another broker");

    let finished = initial;
    const deadline = Date.now() + 10_000;
    while (finished.running && finished.sessionId && Date.now() < deadline) {
      finished = await executor.poll(finished.sessionId, { yieldTimeMs: 250 });
    }
    assert.equal(finished.running, false);

    const presenceDeadline = Date.now() + 2000;
    let after = await observer.readEvents(0, 0);
    while (after.activeCommandSessionIds?.includes(initial.sessionId!) && Date.now() < presenceDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      after = await observer.readEvents(0, 0);
    }
    assert.equal(after.activeCommandSessionIds?.includes(initial.sessionId!), false);
  } finally {
    executor.close();
    observer.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("poll returns only output after the supplied cursors", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-incremental-poll-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(fakeSsh, "#!/bin/sh\nprintf 'first\\n'\nprintf 'warn-one\\n' >&2\nIFS= read -r _line\nprintf 'second\\n'\nprintf 'warn-two\\n' >&2\n");
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example", alias: "example", hostname: "example.invalid", user: "deploy", port: 22,
    identityFiles: [], proxyJump: null, resolved: true, source: "ssh-config", identityFile: null, defaultCwd: null,
  };
  const broker = new ExecutionBroker({ eventJournalPath: path.join(root, "events.jsonl") });
  try {
    let initial = await broker.exec(host, "incremental", { yieldTimeMs: 0, keepStdinOpen: true });
    const firstOutputDeadline = Date.now() + 3000;
    while (initial.running && (!initial.stdout || !initial.stderr) && initial.sessionId && Date.now() < firstOutputDeadline) {
      initial = await broker.poll(initial.sessionId, { yieldTimeMs: 100 });
    }
    assert.equal(initial.running, true);
    assert.equal(initial.stdout, "first\n");
    assert.equal(initial.stderr, "warn-one\n");
    assert.ok(initial.sessionId);
    await broker.writeStdin(initial.sessionId!, "\n", true);
    const next = await broker.poll(initial.sessionId!, {
      yieldTimeMs: 1000,
      afterStdoutChars: initial.stdoutChars,
      afterStderrChars: initial.stderrChars,
    });
    assert.equal(next.running, false);
    assert.equal(next.stdout, "second\n");
    assert.equal(next.stderr, "warn-two\n");
    assert.equal(next.stdoutFrom, initial.stdoutChars);
    assert.equal(next.stderrFrom, initial.stderrChars);
    assert.equal(next.outputGap, false);
  } finally {
    broker.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("fails fast after a recent SSH network failure", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-fail-fast-"));
  const fakeSsh = path.join(root, "ssh");
  const countFile = path.join(root, "count");
  await writeFile(fakeSsh, `#!/bin/sh\nprintf x >> ${JSON.stringify(countFile)}\nprintf 'ssh: connect to host example.invalid port 22: Connection timed out\\n' >&2\nexit 255\n`);
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example", alias: "example", hostname: "example.invalid", user: "deploy", port: 22,
    identityFiles: [], proxyJump: null, resolved: true, source: "ssh-config", identityFile: null, defaultCwd: null,
  };
  const broker = new ExecutionBroker({ eventJournalPath: path.join(root, "events.jsonl") });
  try {
    let first = await broker.exec(host, "pwd", { yieldTimeMs: 1000 });
    while (first.running && first.sessionId) first = await broker.poll(first.sessionId, { yieldTimeMs: 100 });
    assert.equal(first.exitCode, 255);
    await assert.rejects(() => broker.exec(host, "pwd", { yieldTimeMs: 1000 }), /快速失败/);
    const count = await (await import("node:fs/promises")).readFile(countFile, "utf8");
    assert.equal(count, "x", "fail-fast must avoid spawning a second ssh process");
  } finally {
    broker.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("truncates model capture while preserving output head and tail", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-output-cap-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(fakeSsh, "#!/bin/sh\nprintf 'HEAD\\n'\nhead -c 180000 /dev/zero | tr '\\0' x\nprintf '\\nTAIL\\n'\n");
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example", alias: "example", hostname: "example.invalid", user: "deploy", port: 22,
    identityFiles: [], proxyJump: null, resolved: true, source: "ssh-config", identityFile: null, defaultCwd: null,
  };
  const broker = new ExecutionBroker({ eventJournalPath: path.join(root, "events.jsonl") });
  try {
    let result = await broker.exec(host, "large-output", { yieldTimeMs: 1000 });
    while (result.running && result.sessionId) result = await broker.poll(result.sessionId, { yieldTimeMs: 100 });
    assert.match(result.stdout, /^HEAD\n/);
    assert.match(result.stdout, /模型输出已截断/);
    assert.match(result.stdout, /TAIL\n$/);
    assert.ok(result.stdout.length <= 120_000);
  } finally {
    broker.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("passes one-shot stdin without journaling its contents", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-stdin-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(fakeSsh, "#!/bin/sh\nwc -c\n");
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example", alias: "example", hostname: "example.invalid", user: "deploy", port: 22,
    identityFiles: [], proxyJump: null, resolved: true, source: "ssh-config", identityFile: null, defaultCwd: null,
  };
  const journal = path.join(root, "events.jsonl");
  const broker = new ExecutionBroker({ eventJournalPath: journal });
  try {
    let result = await broker.exec(host, "consumer", { stdin: "alpha\nbeta\n", yieldTimeMs: 1000 });
    while (result.running && result.sessionId) result = await broker.poll(result.sessionId, { yieldTimeMs: 250 });
    assert.equal(result.stdout.trim(), "11");
    assert.equal(result.stdinOpen, false);
    assert.equal(result.stdinCharsWritten, 11);
    const events = (await broker.readEvents(0)).events;
    assert.equal(JSON.stringify(events).includes("alpha"), false);
    assert.equal(JSON.stringify(events).includes("beta"), false);
  } finally {
    broker.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("streams stdin into a running non-PTY SSH session", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-stream-stdin-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(fakeSsh, "#!/bin/sh\nwhile IFS= read -r line; do printf 'ECHO:%s\\n' \"$line\"; done\n");
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example", alias: "example", hostname: "example.invalid", user: "deploy", port: 22,
    identityFiles: [], proxyJump: null, resolved: true, source: "ssh-config", identityFile: null, defaultCwd: null,
  };
  const broker = new ExecutionBroker({ eventJournalPath: path.join(root, "events.jsonl") });
  try {
    let result = await broker.exec(host, "reader", { keepStdinOpen: true, yieldTimeMs: 50 });
    assert.equal(result.running, true);
    assert.equal(result.stdinOpen, true);
    assert.ok(result.sessionId);
    const sessionId = result.sessionId!;
    const first = await broker.writeStdin(sessionId, "one\n");
    assert.equal(first.stdinOpen, true);
    const second = await broker.writeStdin(sessionId, "two\n", true);
    assert.equal(second.stdinOpen, false);
    assert.equal(second.totalWrittenChars, 8);
    const deadline = Date.now() + 3000;
    while (result.running && Date.now() < deadline) result = await broker.poll(sessionId, { yieldTimeMs: 250 });
    assert.equal(result.running, false);
    assert.match(result.stdout, /ECHO:one/);
    assert.match(result.stdout, /ECHO:two/);
  } finally {
    broker.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("hands an interactive SSH prompt to the user without exposing typed input", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-handoff-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(
    fakeSsh,
    `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
process.stdout.write("Password: ");
let secret = "";
let finished = false;
process.stdin.on("data", (chunk) => {
  if (finished) return;
  for (const char of chunk) {
    if (char === "\\r" || char === "\\n") {
      finished = true;
      let index = 0;
      const emitNext = () => {
        if (index < secret.length) {
          process.stdout.write(secret[index++]);
          setTimeout(emitNext, 10);
          return;
        }
        process.stdout.write("\\nAUTH_OK:" + secret.length + "\\n");
        process.exit(0);
      };
      emitNext();
      return;
    }
    secret += char;
  }
});
`,
  );
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example", alias: "example", hostname: "example.invalid", user: "deploy", port: 22,
    identityFiles: [], proxyJump: null, resolved: true, source: "ssh-config", identityFile: null, defaultCwd: null,
  };
  const broker = new ExecutionBroker({ eventJournalPath: path.join(root, "events.jsonl") });
  try {
    let result = await broker.execInteractive(host, "needs-auth", { yieldTimeMs: 500 });
    assert.equal(result.running, true);
    assert.equal(result.interactive, true);
    assert.equal(result.waitingForUser, true);
    assert.equal(result.takeoverState, "awaiting-user");
    assert.match(result.prompt ?? "", /Password:/i);
    assert.ok(result.sessionId);
    const sessionId = result.sessionId!;

    assert.throws(() => broker.writeHandoff(sessionId, "secret\n"), /先.*接管/);
    assert.equal(broker.takeoverHandoff(sessionId).takeoverState, "user");
    broker.writeHandoff(sessionId, "secret-value\n");
    assert.equal(broker.releaseHandoff(sessionId).takeoverState, "agent");

    const deadline = Date.now() + 6000;
    while (result.running && Date.now() < deadline) result = await broker.poll(sessionId, { yieldTimeMs: 250 });
    assert.equal(result.running, false);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /AUTH_OK:12/);
    assert.equal(result.stdout.includes("secret-value"), false, "model-visible output must redact user takeover input");
    assert.match(result.stdout, /\[user input redacted\]/);

    const events = (await broker.readEvents(0, 0)).events;
    assert.ok(events.some((event) => event.type === "handoff.state" && event.takeoverState === "awaiting-user"));
    assert.ok(events.some((event) => event.type === "handoff.state" && event.takeoverState === "user"));
    assert.ok(events.some((event) => event.type === "handoff.closed" && event.exitCode === 0));
    assert.equal(JSON.stringify(events).includes("secret-value"), false, "App-local events must redact user takeover input across PTY chunks");
  } finally {
    broker.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("opens an interactive PTY session and forwards input and resize", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-pty-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(
    fakeSsh,
    "#!/bin/sh\nprintf 'READY\\n'\nIFS= read -r line\nstty size\nprintf 'ECHO:%s\\n' \"$line\"\n",
  );
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example",
    alias: "example",
    hostname: "example.invalid",
    user: "deploy",
    port: 22,
    identityFiles: [],
    proxyJump: null,
    resolved: true,
    source: "ssh-config",
    identityFile: null,
    defaultCwd: null,
  };
  const journal = path.join(root, "events.jsonl");
  const broker = new ExecutionBroker({ eventJournalPath: journal });
  const observer = new ExecutionBroker({ eventJournalPath: journal });
  try {
    const opened = broker.openTerminal(host, { cols: 80, rows: 24 });
    assert.equal(opened.host, "example");
    broker.resizeTerminal(opened.sessionId, 120, 40);
    broker.writeTerminal(opened.sessionId, "hello\n");

    const deadline = Date.now() + 3000;
    let events = (await broker.readEvents(0, 0)).events;
    while (!events.some((event) => event.type === "terminal.closed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      events = (await broker.readEvents(0, 0)).events;
    }
    const data = events
      .filter((event) => event.type === "terminal.data")
      .map((event) => event.data ?? "")
      .join("");
    assert.match(data, /READY/);
    assert.match(data, /40 120/);
    assert.match(data, /ECHO:hello/);
    assert.equal(events[0].type, "terminal.opened");
    assert.ok(events.some((event) => event.type === "terminal.closed" && event.exitCode === 0));
    assert.deepEqual((await observer.readEvents(0, 0)).events, [], "PTY events must remain process-local");
  } finally {
    broker.close();
    observer.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("exposes a stable process-local runtime identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-runtime-id-"));
  const journal = path.join(root, "events.jsonl");
  const first = new ExecutionBroker({ eventJournalPath: journal });
  const second = new ExecutionBroker({ eventJournalPath: journal });
  try {
    const firstRead = await first.readEvents(0, 0);
    const repeatedRead = await first.readEvents(0, 0);
    const secondRead = await second.readEvents(0, 0);
    assert.match(firstRead.runtimeId, /^[0-9a-f-]{36}$/i);
    assert.equal(repeatedRead.runtimeId, firstRead.runtimeId);
    assert.notEqual(secondRead.runtimeId, firstRead.runtimeId);
  } finally {
    first.close();
    second.close();
  }
});

test("scans recursively changed files without emitting Agent command events", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-changes-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(
    fakeSsh,
    "#!/bin/sh\nprintf '/srv/app/src/a.ts\\0/srv/app/src/nested/b.ts\\0/srv/app/src/ padded name .ts \\0'\nexit 0\n",
  );
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example",
    alias: "example",
    hostname: "example.invalid",
    user: "deploy",
    port: 22,
    identityFiles: [],
    proxyJump: null,
    resolved: true,
    source: "ssh-config",
    identityFile: null,
    defaultCwd: null,
  };
  const journal = path.join(root, "events.jsonl");
  const broker = new ExecutionBroker({ eventJournalPath: journal });
  try {
    const result = await broker.inspectChangedFiles(host, "/srv/app", new Date(Date.now() - 1000).toISOString());
    assert.equal(result.supported, true);
    assert.deepEqual(result.files, ["/srv/app/src/a.ts", "/srv/app/src/nested/b.ts", "/srv/app/src/ padded name .ts "]);
    assert.deepEqual((await broker.readEvents(0, 0)).events, [], "change scan must not appear in Agent Console");
  } finally {
    broker.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});
