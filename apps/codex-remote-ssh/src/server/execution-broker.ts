import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import * as pty from "node-pty";
import type { IPty } from "node-pty";

import { eventJournalPath, SharedEventJournal } from "./event-journal.js";
import { HostHealthRegistry } from "./host-health.js";
import type { RemoteHost } from "./host-registry.js";
import { RuntimePresenceRegistry } from "./runtime-presence.js";
import { sshConfigPath } from "./ssh-config.js";
import {
  CONNECTION_FAILURE_TTL_MS,
  connectionCacheKey,
  connectionFailureMessage,
  inferExecYieldTimeMs,
  sshTransportFailureMessage,
  sshMultiplexingArgs,
} from "./ssh-performance.js";

const MAX_EVENTS = 4000;
const MAX_CAPTURE_CHARS = 120_000;
const CAPTURE_TRUNCATION_MARKER = "\n… [Remote SSH: 模型输出已截断，本地事件流继续接收完整输出] …\n";
const MAX_INCREMENTAL_CAPTURE_CHARS = 256_000;
const INCREMENTAL_GAP_MARKER = "\n… [Remote SSH: 增量输出过大，较早内容已跳过] …\n";
const MAX_COMMAND_CHARS = 200_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_INTERACTIVE_SESSIONS = 4;
const MAX_HANDOFF_SESSIONS = 4;
const MAX_TERMINAL_INPUT_CHARS = 1_000_000;
const MAX_EXEC_STDIN_CHARS = 1_000_000;
const MAX_EXEC_STDIN_TOTAL_CHARS = 8_000_000;
const MAX_HANDOFF_INPUT_CHARS = 1_000_000;
const MAX_HANDOFF_INPUT_TOTAL_CHARS = 8_000_000;

export type TerminalEvent = {
  seq: number;
  type:
    | "command.started"
    | "stdout"
    | "stderr"
    | "command.completed"
    | "command.failed"
    | "terminal.opened"
    | "terminal.data"
    | "terminal.closed"
    | "handoff.opened"
    | "handoff.data"
    | "handoff.state"
    | "handoff.closed";
  sessionId: string;
  host: string;
  at: string;
  cwd?: string | null;
  command?: string;
  data?: string;
  exitCode?: number | null;
  durationMs?: number;
  message?: string;
  cols?: number;
  rows?: number;
  takeoverState?: HandoffTakeoverState;
  prompt?: string | null;
};

export type HandoffTakeoverState = "agent" | "awaiting-user" | "user";

type Session = {
  id: string;
  host: RemoteHost;
  command: string;
  cwd: string | null;
  process: ChildProcessWithoutNullStreams;
  startedAt: number;
  stdout: string;
  stderr: string;
  stdoutChars: number;
  stderrChars: number;
  stdoutRecent: string;
  stderrRecent: string;
  stdoutRecentStart: number;
  stderrRecentStart: number;
  exitCode: number | null;
  running: boolean;
  error: string | null;
  stdinOpen: boolean;
  stdinCharsWritten: number;
  timeout: NodeJS.Timeout;
};

type InteractiveSession = {
  id: string;
  host: RemoteHost;
  cwd: string | null;
  terminal: IPty;
  startedAt: number;
};

type HandoffSession = {
  id: string;
  host: RemoteHost;
  command: string;
  cwd: string | null;
  terminal: IPty;
  startedAt: number;
  stdout: string;
  stdoutChars: number;
  stdoutRecent: string;
  stdoutRecentStart: number;
  exitCode: number | null;
  running: boolean;
  error: string | null;
  takeoverState: HandoffTakeoverState;
  prompt: string | null;
  inputCharsWritten: number;
  redactions: string[];
  redactionBuffer: string;
  closed: Promise<void>;
  resolveClosed: () => void;
};

export type ExecResult = {
  sessionId: string | null;
  running: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  stdinOpen: boolean;
  stdinCharsWritten: number;
  stdoutChars: number;
  stderrChars: number;
  stdoutFrom: number;
  stderrFrom: number;
  outputGap?: boolean;
  interactive?: boolean;
  takeoverState?: HandoffTakeoverState;
  waitingForUser?: boolean;
  prompt?: string | null;
};

export type HandoffControlResult = {
  ok: true;
  sessionId: string;
  takeoverState: HandoffTakeoverState;
};

export type StdinWriteResult = {
  ok: true;
  sessionId: string;
  stdinOpen: boolean;
  writtenChars: number;
  totalWrittenChars: number;
};

export type InteractiveSessionResult = {
  sessionId: string;
  host: string;
  cwd: string | null;
  cols: number;
  rows: number;
};

export type ChangedFilesResult = {
  host: string;
  cwd: string;
  supported: boolean;
  files: string[];
  truncated: boolean;
  message?: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function safeLocalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "SSH_AUTH_SOCK", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.TERM = process.env.TERM ?? "xterm-256color";
  return env;
}

function ensureNodePtyRuntime(): void {
  if (process.platform === "win32") return;
  const require = createRequire(import.meta.url);
  const entry = require.resolve("node-pty");
  const packageRoot = path.resolve(path.dirname(entry), "..");
  const helper = path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  if (!existsSync(helper)) return;
  // node-pty's prebuilt spawn-helper can lose its executable bit when a Codex
  // plugin is copied from a local marketplace cache. Repair only that bundled helper.
  chmodSync(helper, 0o755);
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function detectInteractivePrompt(value: string): string | null {
  const tail = stripAnsi(value).slice(-1200);
  const lines = tail.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const candidate = lines.at(-1) ?? tail.trim();
  const patterns = [
    /(?:password|passphrase)(?:\s+for\s+[^:]+)?\s*:\s*$/i,
    /(?:verification|security|authentication|one[- ]time|otp)\s+(?:code|token)\s*:\s*$/i,
    /(?:enter|input)\s+(?:code|token|password|passphrase)\s*:\s*$/i,
    /(?:are you sure|continue|proceed).*(?:\[y\/n\]|\(y\/n\)|yes\/no)\s*\??\s*$/i,
    /(?:\[sudo\]\s*)?password\s+for\s+[^:]+\s*:\s*$/i,
    /(?:密码|口令|验证码|动态码|一次性密码)\s*[：:]\s*$/i,
    /(?:是否继续|确认继续|确定继续).*(?:\[y\/n\]|\(y\/n\)|是\/否)\s*[？?]?\s*$/i,
  ];
  return patterns.some((pattern) => pattern.test(candidate)) ? candidate.slice(-240) : null;
}

function printableInput(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "");
}

function sshArgs(host: RemoteHost, options: { tty: boolean; remoteCommand?: string; batchMode?: boolean; multiplex?: boolean }): string[] {
  const args = [
    options.tty ? "-tt" : "-T",
    "-F", sshConfigPath(),
    "-o", `BatchMode=${options.batchMode === false ? "no" : "yes"}`,
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    ...(options.multiplex === false ? [] : sshMultiplexingArgs()),
  ];
  if (host.source === "managed") {
    args.push("-p", String(host.port));
    if (host.identityFile) args.push("-i", host.identityFile, "-o", "IdentitiesOnly=yes");
    if (host.proxyJump) args.push("-J", host.proxyJump);
    args.push("--", `${host.user}@${host.hostname}`);
  } else {
    args.push("--", host.alias);
  }
  if (options.remoteCommand) args.push(options.remoteCommand);
  return args;
}

export class ExecutionBroker {
  private readonly runtimeId = crypto.randomUUID();
  private localSeq = 0;
  private readonly localEvents: TerminalEvent[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly interactiveSessions = new Map<string, InteractiveSession>();
  private readonly handoffSessions = new Map<string, HandoffSession>();
  private readonly connectionFailures = new Map<string, { until: number; message: string }>();
  private readonly journal: SharedEventJournal;
  private readonly presence: RuntimePresenceRegistry;
  private readonly health: HostHealthRegistry;
  private journalWriteQueue = Promise.resolve();

  constructor(options: { eventJournalPath?: string; health?: HostHealthRegistry } = {}) {
    const journalPath = options.eventJournalPath ?? eventJournalPath();
    this.journal = new SharedEventJournal(journalPath);
    this.presence = new RuntimePresenceRegistry(journalPath, this.runtimeId);
    this.health = options.health ?? new HostHealthRegistry({
      runtimeId: this.runtimeId,
      ...(options.eventJournalPath ? { root: path.join(path.dirname(journalPath), "host-health") } : {}),
    });
  }

  runtimeIdentity(): string {
    return this.runtimeId;
  }

  async readEvents(
    afterSeq: number,
    afterLocalSeq = 0,
    limit = 500,
  ): Promise<{ runtimeId: string; events: TerminalEvent[]; nextSeq: number; nextLocalSeq: number; activeCommandSessionIds?: string[] }> {
    await this.journalWriteQueue;
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const sharedEvents = await this.journal.read(afterSeq, boundedLimit);
    const localEvents = this.localEvents.filter((event) => event.seq > afterLocalSeq).slice(0, boundedLimit);
    const sharedIds = new Set(sharedEvents);
    const localIds = new Set(localEvents);
    const events = [...sharedEvents, ...localEvents]
      .sort((left, right) => left.at.localeCompare(right.at) || left.seq - right.seq)
      .slice(0, boundedLimit);
    let nextSeq = afterSeq;
    let nextLocalSeq = afterLocalSeq;
    for (const event of events) {
      if (sharedIds.has(event)) nextSeq = Math.max(nextSeq, event.seq);
      if (localIds.has(event)) nextLocalSeq = Math.max(nextLocalSeq, event.seq);
    }
    const activeCommandSessionIds = await this.presence.activeCommands()
      .then((commands) => commands.map((command) => command.sessionId))
      .catch(() => undefined);
    return { runtimeId: this.runtimeId, events, nextSeq, nextLocalSeq, activeCommandSessionIds };
  }

  async clearCommandEvents(): Promise<void> {
    await this.journalWriteQueue;
    await this.journal.clear();
  }

  async exec(
    host: RemoteHost,
    command: string,
    options: {
      cwd?: string | null;
      yieldTimeMs?: number;
      timeoutMs?: number;
      stdin?: string;
      keepStdinOpen?: boolean;
    } = {},
  ): Promise<ExecResult> {
    if (!command.trim()) throw new Error("command 不能为空");
    if (command.length > MAX_COMMAND_CHARS) throw new Error(`command 不能超过 ${MAX_COMMAND_CHARS} 个字符`);
    this.assertConnectionAvailable(host);
    const yieldTimeMs = Math.max(0, Math.min(options.yieldTimeMs ?? inferExecYieldTimeMs(command), 12_000));
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30 * 60 * 1000, MAX_TIMEOUT_MS));
    const cwd = options.cwd?.trim() || host.defaultCwd || null;
    const remoteCommand = cwd ? `cd -- ${shellQuote(cwd)} && ${command}` : command;
    const args = sshArgs(host, { tty: false, remoteCommand });
    const process = spawn("ssh", args, {
      env: safeLocalEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    process.stdin.on("error", () => {
      // A remote process may close stdin before the local SSH process exits.
      // Per-write failures are surfaced by writeSessionStdin instead.
    });
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    const sessionId = crypto.randomBytes(18).toString("base64url");
    const session: Session = {
      id: sessionId,
      host,
      command,
      cwd,
      process,
      startedAt: Date.now(),
      stdout: "",
      stderr: "",
      stdoutChars: 0,
      stderrChars: 0,
      stdoutRecent: "",
      stderrRecent: "",
      stdoutRecentStart: 0,
      stderrRecentStart: 0,
      exitCode: null,
      running: true,
      error: null,
      stdinOpen: true,
      stdinCharsWritten: 0,
      timeout: setTimeout(() => {
        if (!session.running) return;
        session.error = `命令超过 ${timeoutMs}ms，SSH 进程已终止`;
        process.kill("SIGTERM");
      }, timeoutMs),
    };
    this.sessions.set(sessionId, session);
    await this.syncPresence();
    this.pushShared({ type: "command.started", sessionId, host: host.alias, cwd, command });
    process.stdout.on("data", (data: string) => {
      session.stdout = this.appendCapture(session.stdout, data);
      const recent = this.appendIncremental(session.stdoutRecent, session.stdoutRecentStart, session.stdoutChars, data);
      session.stdoutChars = recent.total;
      session.stdoutRecent = recent.value;
      session.stdoutRecentStart = recent.start;
      this.pushShared({ type: "stdout", sessionId, host: host.alias, data });
    });
    process.stderr.on("data", (data: string) => {
      session.stderr = this.appendCapture(session.stderr, data);
      const recent = this.appendIncremental(session.stderrRecent, session.stderrRecentStart, session.stderrChars, data);
      session.stderrChars = recent.total;
      session.stderrRecent = recent.value;
      session.stderrRecentStart = recent.start;
      this.pushShared({ type: "stderr", sessionId, host: host.alias, data });
    });
    process.on("error", (error) => {
      session.error = error.message;
    });
    process.on("close", (code) => {
      clearTimeout(session.timeout);
      session.running = false;
      session.stdinOpen = false;
      session.exitCode = code;
      void this.syncPresence();
      this.recordConnectionResult(host, code, session.error ? `${session.stderr}\n${session.error}` : session.stderr);
      const durationMs = Date.now() - session.startedAt;
      if (session.error) {
        this.pushShared({
          type: "command.failed",
          sessionId,
          host: host.alias,
          exitCode: code,
          durationMs,
          message: session.error,
        });
      } else {
        this.pushShared({ type: "command.completed", sessionId, host: host.alias, exitCode: code, durationMs });
      }
      const cleanup = setTimeout(() => this.sessions.delete(sessionId), 10 * 60 * 1000);
      cleanup.unref();
    });

    try {
      if (options.stdin !== undefined && options.stdin.length > 0) {
        await this.writeSessionStdin(session, options.stdin);
      }
      if (!options.keepStdinOpen && session.stdinOpen) {
        session.process.stdin.end();
        session.stdinOpen = false;
      }
    } catch (error) {
      session.error = `stdin 写入失败: ${error instanceof Error ? error.message : String(error)}`;
      session.process.kill("SIGTERM");
      throw error;
    }

    if (yieldTimeMs > 0 && session.running) {
      await Promise.race([
        new Promise<void>((resolve) => process.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, yieldTimeMs)),
      ]);
    }
    return this.result(session);
  }

  async writeStdin(sessionId: string, data: string, eof = false): Promise<StdinWriteResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("sessionId 不存在或已过期");
    if (!session.running) throw new Error("SSH 命令已经结束，不能继续写入 stdin");
    if (!session.stdinOpen) throw new Error("该 SSH 命令的 stdin 已关闭");
    if (data.length > MAX_EXEC_STDIN_CHARS) {
      throw new Error(`单次 stdin 输入不能超过 ${MAX_EXEC_STDIN_CHARS} 个字符`);
    }
    if (session.stdinCharsWritten + data.length > MAX_EXEC_STDIN_TOTAL_CHARS) {
      throw new Error(`单个 SSH session 的 stdin 累计不能超过 ${MAX_EXEC_STDIN_TOTAL_CHARS} 个字符`);
    }

    if (data.length > 0) await this.writeSessionStdin(session, data);
    if (eof && session.stdinOpen) {
      session.process.stdin.end();
      session.stdinOpen = false;
    }
    return {
      ok: true,
      sessionId,
      stdinOpen: session.stdinOpen,
      writtenChars: data.length,
      totalWrittenChars: session.stdinCharsWritten,
    };
  }

  isHandoffSession(sessionId: string): boolean {
    return this.handoffSessions.has(sessionId);
  }

  async execInteractive(
    host: RemoteHost,
    command: string,
    options: { cwd?: string | null; yieldTimeMs?: number; timeoutMs?: number; cols?: number; rows?: number } = {},
  ): Promise<ExecResult> {
    if (!command.trim()) throw new Error("command 不能为空");
    if (command.length > MAX_COMMAND_CHARS) throw new Error(`command 不能超过 ${MAX_COMMAND_CHARS} 个字符`);
    this.assertConnectionAvailable(host);
    const activeHandoffCount = [...this.handoffSessions.values()].filter((session) => session.running).length;
    if (activeHandoffCount >= MAX_HANDOFF_SESSIONS) {
      throw new Error(`Human Takeover 会话最多同时打开 ${MAX_HANDOFF_SESSIONS} 个`);
    }
    ensureNodePtyRuntime();
    const cwd = options.cwd?.trim() || host.defaultCwd || null;
    const cols = Math.max(20, Math.min(options.cols ?? 100, 500));
    const rows = Math.max(5, Math.min(options.rows ?? 30, 200));
    const yieldTimeMs = Math.max(0, Math.min(options.yieldTimeMs ?? 3_000, 12_000));
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30 * 60 * 1000, MAX_TIMEOUT_MS));
    const remoteCommand = cwd ? `cd -- ${shellQuote(cwd)} && ${command}` : command;
    const terminal = pty.spawn("ssh", sshArgs(host, { tty: true, remoteCommand, batchMode: false, multiplex: false }), {
      name: "xterm-256color",
      cols,
      rows,
      cwd: os.homedir(),
      env: safeLocalEnvironment(),
    });
    const sessionId = crypto.randomBytes(18).toString("base64url");
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const session: HandoffSession = {
      id: sessionId,
      host,
      command,
      cwd,
      terminal,
      startedAt: Date.now(),
      stdout: "",
      stdoutChars: 0,
      stdoutRecent: "",
      stdoutRecentStart: 0,
      exitCode: null,
      running: true,
      error: null,
      takeoverState: "agent",
      prompt: null,
      inputCharsWritten: 0,
      redactions: [],
      redactionBuffer: "",
      closed,
      resolveClosed,
    };
    this.handoffSessions.set(sessionId, session);
    this.pushLocal({ type: "handoff.opened", sessionId, host: host.alias, cwd, command, cols, rows, takeoverState: "agent" });

    const timeout = setTimeout(() => {
      if (!session.running) return;
      session.error = `交互命令超过 ${timeoutMs}ms，SSH PTY 已终止`;
      terminal.kill();
    }, timeoutMs);
    timeout.unref();

    terminal.onData((data) => {
      const safeData = this.redactHandoffData(session, data);
      if (!safeData) return;
      this.pushLocal({ type: "handoff.data", sessionId, host: host.alias, data: safeData });
      session.stdout = this.appendCapture(session.stdout, safeData);
      const recent = this.appendIncremental(session.stdoutRecent, session.stdoutRecentStart, session.stdoutChars, safeData);
      session.stdoutChars = recent.total;
      session.stdoutRecent = recent.value;
      session.stdoutRecentStart = recent.start;
      if (session.takeoverState === "agent") {
        const prompt = detectInteractivePrompt(session.stdout);
        if (prompt) {
          session.prompt = prompt;
          session.takeoverState = "awaiting-user";
          this.pushLocal({ type: "handoff.state", sessionId, host: host.alias, takeoverState: "awaiting-user", prompt });
        }
      }
    });

    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (!session.running) return;
      const tail = this.redactHandoffData(session, "", true);
      if (tail) {
        this.pushLocal({ type: "handoff.data", sessionId, host: host.alias, data: tail });
        session.stdout = this.appendCapture(session.stdout, tail);
        const recent = this.appendIncremental(session.stdoutRecent, session.stdoutRecentStart, session.stdoutChars, tail);
        session.stdoutChars = recent.total;
        session.stdoutRecent = recent.value;
        session.stdoutRecentStart = recent.start;
      }
      session.running = false;
      session.exitCode = exitCode;
      this.recordConnectionResult(host, exitCode, session.error ? `${session.stdout}\n${session.error}` : session.stdout);
      session.takeoverState = "agent";
      session.resolveClosed();
      this.pushLocal({
        type: "handoff.closed",
        sessionId,
        host: host.alias,
        exitCode,
        durationMs: Date.now() - session.startedAt,
        message: session.error ?? undefined,
      });
      const cleanup = setTimeout(() => this.handoffSessions.delete(sessionId), 10 * 60 * 1000);
      cleanup.unref();
    });

    if (yieldTimeMs > 0 && session.running) {
      await Promise.race([session.closed, new Promise<void>((resolve) => setTimeout(resolve, yieldTimeMs))]);
    }
    return this.handoffResult(session);
  }

  takeoverHandoff(sessionId: string): HandoffControlResult {
    const session = this.requireHandoffSession(sessionId);
    if (!session.running) throw new Error("交互命令已经结束");
    session.takeoverState = "user";
    this.pushLocal({ type: "handoff.state", sessionId, host: session.host.alias, takeoverState: "user", prompt: session.prompt });
    return { ok: true, sessionId, takeoverState: session.takeoverState };
  }

  releaseHandoff(sessionId: string): HandoffControlResult {
    const session = this.requireHandoffSession(sessionId);
    if (!session.running) throw new Error("交互命令已经结束");
    session.prompt = null;
    session.takeoverState = "agent";
    this.pushLocal({ type: "handoff.state", sessionId, host: session.host.alias, takeoverState: "agent", prompt: null });
    return { ok: true, sessionId, takeoverState: session.takeoverState };
  }

  writeHandoff(sessionId: string, data: string): { ok: true; writtenChars: number; totalWrittenChars: number } {
    const session = this.requireHandoffSession(sessionId);
    if (!session.running) throw new Error("交互命令已经结束");
    if (session.takeoverState !== "user") throw new Error("请先在 Remote SSH 中接管该会话");
    if (!data) return { ok: true, writtenChars: 0, totalWrittenChars: session.inputCharsWritten };
    if (data.length > MAX_HANDOFF_INPUT_CHARS) throw new Error(`单次接管输入不能超过 ${MAX_HANDOFF_INPUT_CHARS} 个字符`);
    if (session.inputCharsWritten + data.length > MAX_HANDOFF_INPUT_TOTAL_CHARS) {
      throw new Error(`单个 Human Takeover session 的累计输入不能超过 ${MAX_HANDOFF_INPUT_TOTAL_CHARS} 个字符`);
    }
    const secret = printableInput(data);
    if (secret) session.redactions = [...session.redactions, secret].slice(-256);
    session.inputCharsWritten += data.length;
    session.terminal.write(data);
    return { ok: true, writtenChars: data.length, totalWrittenChars: session.inputCharsWritten };
  }

  resizeHandoff(sessionId: string, cols: number, rows: number): { ok: true; cols: number; rows: number } {
    const session = this.requireHandoffSession(sessionId);
    const boundedCols = Math.max(20, Math.min(cols, 500));
    const boundedRows = Math.max(5, Math.min(rows, 200));
    session.terminal.resize(boundedCols, boundedRows);
    return { ok: true, cols: boundedCols, rows: boundedRows };
  }

  openTerminal(
    host: RemoteHost,
    options: { cwd?: string | null; cols?: number; rows?: number } = {},
  ): InteractiveSessionResult {
    this.assertConnectionAvailable(host);
    if (this.interactiveSessions.size >= MAX_INTERACTIVE_SESSIONS) {
      throw new Error(`交互终端最多同时打开 ${MAX_INTERACTIVE_SESSIONS} 个会话`);
    }
    ensureNodePtyRuntime();
    const cwd = options.cwd?.trim() || host.defaultCwd || null;
    const cols = Math.max(20, Math.min(options.cols ?? 100, 500));
    const rows = Math.max(5, Math.min(options.rows ?? 30, 200));
    const remoteCommand = cwd
      ? `cd -- ${shellQuote(cwd)} && exec "\${SHELL:-/bin/sh}" -l`
      : undefined;
    const terminal = pty.spawn("ssh", sshArgs(host, { tty: true, remoteCommand, multiplex: false }), {
      name: "xterm-256color",
      cols,
      rows,
      cwd: os.homedir(),
      env: safeLocalEnvironment(),
    });
    const sessionId = crypto.randomBytes(18).toString("base64url");
    const session: InteractiveSession = {
      id: sessionId,
      host,
      cwd,
      terminal,
      startedAt: Date.now(),
    };
    this.interactiveSessions.set(sessionId, session);
    this.pushLocal({ type: "terminal.opened", sessionId, host: host.alias, cwd, cols, rows });
    terminal.onData((data) => {
      this.pushLocal({ type: "terminal.data", sessionId, host: host.alias, data });
    });
    terminal.onExit(({ exitCode }) => {
      if (!this.interactiveSessions.delete(sessionId)) return;
      this.pushLocal({
        type: "terminal.closed",
        sessionId,
        host: host.alias,
        exitCode,
        durationMs: Date.now() - session.startedAt,
      });
    });
    return { sessionId, host: host.alias, cwd, cols, rows };
  }

  writeTerminal(sessionId: string, data: string): { ok: true } {
    const session = this.requireInteractiveSession(sessionId);
    if (!data) return { ok: true };
    if (data.length > MAX_TERMINAL_INPUT_CHARS) {
      throw new Error(`单次终端输入不能超过 ${MAX_TERMINAL_INPUT_CHARS} 个字符`);
    }
    session.terminal.write(data);
    return { ok: true };
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): { ok: true; cols: number; rows: number } {
    const session = this.requireInteractiveSession(sessionId);
    const boundedCols = Math.max(20, Math.min(cols, 500));
    const boundedRows = Math.max(5, Math.min(rows, 200));
    session.terminal.resize(boundedCols, boundedRows);
    return { ok: true, cols: boundedCols, rows: boundedRows };
  }

  closeTerminal(sessionId: string): { ok: true } {
    const session = this.requireInteractiveSession(sessionId);
    session.terminal.kill();
    return { ok: true };
  }

  async poll(sessionId: string, options: { yieldTimeMs?: number; cancel?: boolean; afterStdoutChars?: number; afterStderrChars?: number } = {}): Promise<ExecResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const handoff = this.handoffSessions.get(sessionId);
      if (!handoff) throw new Error("sessionId 不存在或已过期");
      if (options.cancel && handoff.running) {
        handoff.error = "命令已取消";
        handoff.terminal.kill();
      }
      const yieldTimeMs = Math.max(0, Math.min(options.yieldTimeMs ?? 5_000, 12_000));
      if (yieldTimeMs > 0 && handoff.running && handoff.takeoverState === "agent") {
        await Promise.race([handoff.closed, new Promise<void>((resolve) => setTimeout(resolve, yieldTimeMs))]);
      }
      return this.handoffResult(handoff, options.afterStdoutChars, options.afterStderrChars);
    }
    if (options.cancel && session.running) {
      session.error = "命令已取消";
      session.process.kill(os.platform() === "win32" ? undefined : "SIGINT");
    }
    const yieldTimeMs = Math.max(0, Math.min(options.yieldTimeMs ?? 5_000, 12_000));
    if (yieldTimeMs > 0 && session.running) {
      await Promise.race([
        new Promise<void>((resolve) => session.process.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, yieldTimeMs)),
      ]);
    }
    return this.result(session, options.afterStdoutChars, options.afterStderrChars);
  }

  async inspectChangedFiles(
    host: RemoteHost,
    cwd: string,
    since: string,
    maxFiles = 200,
  ): Promise<ChangedFilesResult> {
    this.assertConnectionAvailable(host);
    const timestamp = new Date(since).getTime();
    if (!Number.isFinite(timestamp)) throw new Error("since 不是有效时间");
    const threshold = new Date(timestamp - 1500).toISOString().slice(0, 19).replace("T", " ") + " UTC";
    const boundedMaxFiles = Math.max(1, Math.min(maxFiles, 500));
    const remoteCommand = [
      "command -v find >/dev/null 2>&1 || exit 127",
      `cd -- ${shellQuote(cwd)} || exit 3`,
      `find \"$PWD\" \\( -name .git -o -name node_modules \\) -prune -o -type f -newermt ${shellQuote(threshold)} -print0 2>/dev/null`,
    ].join("; ");
    const process = spawn("ssh", sshArgs(host, { tty: false, remoteCommand }), {
      env: safeLocalEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    process.stdin.end();
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");

    return await new Promise<ChangedFilesResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      const captureLimit = 1024 * 1024;
      const timeout = setTimeout(() => {
        timedOut = true;
        process.kill("SIGTERM");
      }, 12_000);
      timeout.unref();
      process.stdout.on("data", (chunk: string) => {
        if (stdout.length >= captureLimit) {
          truncated = true;
          return;
        }
        const remaining = captureLimit - stdout.length;
        stdout += chunk.slice(0, remaining);
        if (chunk.length > remaining) truncated = true;
      });
      process.stderr.on("data", (chunk: string) => {
        if (stderr.length < 16_000) stderr += chunk.slice(0, 16_000 - stderr.length);
      });
      process.on("error", (error) => {
        clearTimeout(timeout);
        resolve({ host: host.alias, cwd, supported: false, files: [], truncated: false, message: error.message });
      });
      process.on("close", (code) => {
        clearTimeout(timeout);
        const files = stdout
          .split("\0")
          .filter((value) => value.length > 0)
          .slice(0, boundedMaxFiles);
        if (files.length >= boundedMaxFiles) truncated = true;
        resolve({
          host: host.alias,
          cwd,
          supported: !timedOut && code === 0,
          files,
          truncated,
          ...(timedOut ? { message: "变化文件扫描超时" } : code === 0 ? {} : { message: stderr.trim() || `find exit ${code ?? "?"}` }),
        });
      });
    });
  }

  close(): void {
    this.presence.close();
    for (const session of this.sessions.values()) {
      clearTimeout(session.timeout);
      if (session.running) session.process.kill("SIGTERM");
    }
    this.sessions.clear();
    for (const session of this.interactiveSessions.values()) session.terminal.kill();
    this.interactiveSessions.clear();
    for (const session of this.handoffSessions.values()) session.terminal.kill();
    this.handoffSessions.clear();
  }

  private syncPresence(): Promise<void> {
    return this.presence.setCommands(
      [...this.sessions.values()]
        .filter((session) => session.running)
        .map((session) => ({
          sessionId: session.id,
          startedAt: session.startedAt,
        })),
    );
  }

  private result(session: Session, afterStdoutChars?: number, afterStderrChars?: number): ExecResult {
    const stdout = this.incrementalOutput(session.stdout, session.stdoutRecent, session.stdoutRecentStart, session.stdoutChars, afterStdoutChars);
    const stderr = this.incrementalOutput(session.stderr, session.stderrRecent, session.stderrRecentStart, session.stderrChars, afterStderrChars);
    return {
      sessionId: session.running ? session.id : null,
      running: session.running,
      stdout: stdout.value,
      stderr: stderr.value,
      exitCode: session.exitCode,
      stdinOpen: session.running && session.stdinOpen,
      stdinCharsWritten: session.stdinCharsWritten,
      stdoutChars: session.stdoutChars,
      stderrChars: session.stderrChars,
      stdoutFrom: stdout.from,
      stderrFrom: stderr.from,
      outputGap: stdout.gap || stderr.gap,
    };
  }

  private handoffResult(session: HandoffSession, afterStdoutChars?: number, afterStderrChars?: number): ExecResult {
    const stdout = this.incrementalOutput(session.stdout, session.stdoutRecent, session.stdoutRecentStart, session.stdoutChars, afterStdoutChars);
    const errorText = session.error ?? "";
    const stderrAfter = afterStderrChars === undefined ? undefined : Math.max(0, Math.min(afterStderrChars, errorText.length));
    return {
      sessionId: session.running ? session.id : null,
      running: session.running,
      stdout: stdout.value,
      stderr: stderrAfter === undefined ? errorText : errorText.slice(stderrAfter),
      exitCode: session.exitCode,
      stdinOpen: false,
      stdinCharsWritten: 0,
      stdoutChars: session.stdoutChars,
      stderrChars: errorText.length,
      stdoutFrom: stdout.from,
      stderrFrom: stderrAfter ?? 0,
      outputGap: stdout.gap,
      interactive: true,
      takeoverState: session.takeoverState,
      waitingForUser: session.running && session.takeoverState === "awaiting-user",
      prompt: session.prompt,
    };
  }

  private async writeSessionStdin(session: Session, data: string): Promise<void> {
    if (data.length > MAX_EXEC_STDIN_CHARS) {
      throw new Error(`单次 stdin 输入不能超过 ${MAX_EXEC_STDIN_CHARS} 个字符`);
    }
    if (session.stdinCharsWritten + data.length > MAX_EXEC_STDIN_TOTAL_CHARS) {
      throw new Error(`单个 SSH session 的 stdin 累计不能超过 ${MAX_EXEC_STDIN_TOTAL_CHARS} 个字符`);
    }
    await new Promise<void>((resolve, reject) => {
      session.process.stdin.write(data, (error) => error ? reject(error) : resolve());
    });
    session.stdinCharsWritten += data.length;
  }

  private appendCapture(current: string, chunk: string): string {
    const markerIndex = current.indexOf(CAPTURE_TRUNCATION_MARKER);
    if (markerIndex >= 0) {
      const head = current.slice(0, markerIndex);
      const tail = current.slice(markerIndex + CAPTURE_TRUNCATION_MARKER.length);
      const tailLimit = Math.max(1, MAX_CAPTURE_CHARS - head.length - CAPTURE_TRUNCATION_MARKER.length);
      return `${head}${CAPTURE_TRUNCATION_MARKER}${(tail + chunk).slice(-tailLimit)}`;
    }
    const combined = current + chunk;
    if (combined.length <= MAX_CAPTURE_CHARS) return combined;
    const available = MAX_CAPTURE_CHARS - CAPTURE_TRUNCATION_MARKER.length;
    const headLimit = Math.floor(available / 2);
    const tailLimit = available - headLimit;
    return `${combined.slice(0, headLimit)}${CAPTURE_TRUNCATION_MARKER}${combined.slice(-tailLimit)}`;
  }

  private appendIncremental(current: string, start: number, totalBefore: number, chunk: string): { value: string; start: number; total: number } {
    const total = totalBefore + chunk.length;
    const combined = current + chunk;
    if (combined.length <= MAX_INCREMENTAL_CAPTURE_CHARS) return { value: combined, start, total };
    const value = combined.slice(-MAX_INCREMENTAL_CAPTURE_CHARS);
    return { value, start: total - value.length, total };
  }

  private incrementalOutput(capture: string, recent: string, recentStart: number, total: number, after?: number): { value: string; from: number; gap: boolean } {
    if (after === undefined) return { value: capture, from: 0, gap: false };
    const cursor = Math.max(0, Math.min(after, total));
    if (cursor < recentStart) {
      return { value: `${INCREMENTAL_GAP_MARKER}${recent}`, from: recentStart, gap: true };
    }
    return { value: recent.slice(cursor - recentStart), from: cursor, gap: false };
  }

  private assertConnectionAvailable(host: RemoteHost): void {
    const key = connectionCacheKey(host);
    const failure = this.connectionFailures.get(key);
    if (!failure) return;
    if (failure.until <= Date.now()) {
      this.connectionFailures.delete(key);
      return;
    }
    const remainingSeconds = Math.max(1, Math.ceil((failure.until - Date.now()) / 1000));
    throw new Error(`SSH 主机 ${host.alias} 刚刚连接失败，${remainingSeconds}s 内快速失败：${failure.message}`);
  }

  private recordConnectionResult(host: RemoteHost, code: number | null, stderr: string): void {
    const key = connectionCacheKey(host);
    const transportFailure = code === null ? stderr.trim() || "SSH 进程未返回退出码" : code === 255 ? sshTransportFailureMessage(stderr) : null;
    if (!transportFailure) {
      this.connectionFailures.delete(key);
      void this.health.recordSuccess(host, "exec").catch(() => {});
      return;
    }
    const message = connectionFailureMessage(stderr);
    if (message) this.connectionFailures.set(key, { until: Date.now() + CONNECTION_FAILURE_TTL_MS, message });
    void this.health.recordFailure(host, transportFailure, "exec").catch(() => {});
  }

  private redactHandoffData(session: HandoffSession, data: string, flush = false): string {
    if (session.redactions.length === 0) {
      const output = session.redactionBuffer + data;
      session.redactionBuffer = "";
      return output;
    }

    let buffer = session.redactionBuffer + data;
    let output = "";
    const secrets = session.redactions.filter(Boolean).slice(-256);
    while (buffer.length > 0) {
      const fullSecret = secrets.find((secret) => buffer.startsWith(secret));
      if (fullSecret) {
        output += "[user input redacted]";
        buffer = buffer.slice(fullSecret.length);
        continue;
      }
      if (!flush && secrets.some((secret) => secret.startsWith(buffer))) break;
      output += buffer[0];
      buffer = buffer.slice(1);
    }
    session.redactionBuffer = flush ? "" : buffer;
    return output;
  }

  private requireInteractiveSession(sessionId: string): InteractiveSession {
    const session = this.interactiveSessions.get(sessionId);
    if (!session) throw new Error("交互终端 sessionId 不存在或已关闭");
    return session;
  }

  private requireHandoffSession(sessionId: string): HandoffSession {
    const session = this.handoffSessions.get(sessionId);
    if (!session) throw new Error("Human Takeover sessionId 不存在或已关闭");
    return session;
  }

  private pushShared(event: Omit<TerminalEvent, "seq" | "at">): void {
    this.journalWriteQueue = this.journalWriteQueue
      .then(async () => {
        await this.journal.append(event);
      })
      .catch(() => {});
  }

  private pushLocal(event: Omit<TerminalEvent, "seq" | "at">): void {
    this.localEvents.push({ ...event, seq: ++this.localSeq, at: new Date().toISOString() });
    if (this.localEvents.length > MAX_EVENTS) this.localEvents.splice(0, this.localEvents.length - MAX_EVENTS);
  }
}
