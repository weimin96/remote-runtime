import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertDialog,
  Badge,
  Box,
  Button,
  Card,
  ContextMenu,
  Dialog,
  Flex,
  Grid,
  Heading,
  IconButton,
  ScrollArea,
  Select,
  Text,
  TextField,
  Theme,
  Tooltip,
} from "@radix-ui/themes";
import {
  ActivityLogIcon,
  ArrowLeftIcon,
  CheckCircledIcon,
  CodeIcon,
  Cross1Icon,
  CrossCircledIcon,
  DesktopIcon,
  EnterFullScreenIcon,
  GearIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { createAppTransport } from "@openai/mcp-extensions/app/transport";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import "@radix-ui/themes/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { CommandCard } from "./command-card.js";
import { formatDuration } from "./format.js";
import { PortForwardDialog } from "./port-forward-dialog.js";
import { capOutput, createTerminal, request, requestReadOnly, teardownCallbacks, transport, userFacingError } from "./runtime.js";
import { ServerMonitorDialog } from "./server-monitor-dialog.js";
import { SftpPanel } from "./sftp-panel.js";
import type { CommandRun, ConnectionState, HandoffView, Host, HostContext, RemoteWorkspace, TerminalEvent, ToolResult, ViewMode } from "./types.js";
import { WorkspaceSwitcher } from "./workspace-switcher.js";

function StatusDot({ state }: { state: ConnectionState }) {
  return <span className={`connection-dot ${state}`} aria-hidden="true" />;
}

function LoadingView() {
  return (
    <div className="loading-view">
      <Card size="2" className="loading-card">
        <Flex align="center" gap="3">
          <span className="loading-spinner" />
          <Box>
            <Text size="2" weight="medium">Remote SSH</Text>
            <Text as="div" size="1" color="gray">正在连接 Codex…</Text>
          </Box>
        </Flex>
      </Card>
    </div>
  );
}

type HostDraft = {
  id: string;
  hostname: string;
  user: string;
  port: string;
  identityFile: string;
  connectionMode: "direct" | "jump";
  proxyJump: string;
  defaultCwd: string;
};

const EMPTY_HOST: HostDraft = {
  id: "",
  hostname: "",
  user: "root",
  port: "22",
  identityFile: "",
  connectionMode: "direct",
  proxyJump: "",
  defaultCwd: "",
};

const MAX_COMMAND_RUNNING_MS = 61 * 60 * 1000;
const ACTIVE_SESSION_RECONCILE_GRACE_MS = 5_000;
const WORKSPACE_RECENTS_KEY = "remote-ssh:workspace-recents:v1";
const WORKSPACE_ACTIVE_KEY = "remote-ssh:workspace-active:v1";
const WORKSPACE_FOLLOW_KEY = "remote-ssh:workspace-follow:v1";
const MAX_RECENT_WORKSPACES = 10;

function loadRecentWorkspaces(): RemoteWorkspace[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WORKSPACE_RECENTS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is RemoteWorkspace => Boolean(
      item && typeof item === "object"
      && typeof (item as RemoteWorkspace).host === "string"
      && typeof (item as RemoteWorkspace).path === "string"
      && typeof (item as RemoteWorkspace).name === "string",
    )).slice(0, MAX_RECENT_WORKSPACES);
  } catch {
    return [];
  }
}

function loadActiveWorkspace(): RemoteWorkspace | null {
  try {
    const item = JSON.parse(window.localStorage.getItem(WORKSPACE_ACTIVE_KEY) ?? "null") as unknown;
    if (!item || typeof item !== "object") return null;
    const workspace = item as RemoteWorkspace;
    return typeof workspace.host === "string"
      && typeof workspace.path === "string"
      && typeof workspace.name === "string"
      ? workspace
      : null;
  } catch {
    return null;
  }
}

function loadWorkspaceFollowMode(): boolean {
  try {
    return window.localStorage.getItem(WORKSPACE_FOLLOW_KEY) !== "pinned";
  } catch {
    return true;
  }
}

function isStaleRunningStart(startedAt: string | null, now = Date.now()): boolean {
  if (!startedAt) return false;
  const started = new Date(startedAt).getTime();
  return Number.isFinite(started) && now - started > MAX_COMMAND_RUNNING_MS;
}

function reconcileRunningRuns(current: CommandRun[], activeSessionIds?: ReadonlySet<string>, now = Date.now()): CommandRun[] {
  let changed = false;
  const next = current.map((run) => {
    if (run.status !== "running") return run;
    const started = run.startedAt ? new Date(run.startedAt).getTime() : Number.NaN;
    const oldEnoughToReconcile = Number.isFinite(started) && now - started > ACTIVE_SESSION_RECONCILE_GRACE_MS;
    const missingFromRuntime = activeSessionIds !== undefined && oldEnoughToReconcile && !activeSessionIds.has(run.sessionId);
    if (!missingFromRuntime && !isStaleRunningStart(run.startedAt, now)) return run;
    changed = true;
    return {
      ...run,
      status: "interrupted" as const,
      message: run.message ?? "Remote SSH runtime 已结束，未收到该命令的完成事件",
    };
  });
  return changed ? next : current;
}

function Workspace() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [connectionText, setConnectionText] = useState("正在连接 Codex…");
  const [activeMode, setActiveMode] = useState<"agent" | "terminal">(() => {
    if (parent !== window) return "agent";
    return new URLSearchParams(window.location.search).get("mode") === "terminal" ? "terminal" : "agent";
  });
  const [hostFilter, setHostFilter] = useState("__all__");
  const [search, setSearch] = useState("");
  const [runs, setRuns] = useState<CommandRun[]>([]);
  const [shellHost, setShellHost] = useState("");
  const [shellCwd, setShellCwd] = useState("");
  const [shellState, setShellState] = useState<{ label: string; state: "idle" | "connecting" | "connected" | "error" }>({
    label: "未连接",
    state: "idle",
  });
  const [handoff, setHandoff] = useState<HandoffView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"hosts" | "editor">("hosts");
  const [hostDraft, setHostDraft] = useState<HostDraft>(EMPTY_HOST);
  const [hostFormError, setHostFormError] = useState("");
  const [hostSaving, setHostSaving] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [sftpCollapsed, setSftpCollapsed] = useState(true);
  const [activeWorkspace, setActiveWorkspace] = useState<RemoteWorkspace | null>(loadActiveWorkspace);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RemoteWorkspace[]>(loadRecentWorkspaces);
  const [workspaceFollowAgent, setWorkspaceFollowAgent] = useState(loadWorkspaceFollowMode);
  const [workspaceRefreshing, setWorkspaceRefreshing] = useState(false);

  const shellContainerRef = useRef<HTMLDivElement>(null);
  const shellFrameRef = useRef<HTMLDivElement>(null);
  const shellTerminalRef = useRef<Terminal | null>(null);
  const shellFitRef = useRef<FitAddon | null>(null);
  const cursorRef = useRef(0);
  const localCursorRef = useRef(0);
  const runtimeIdRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const interactiveSessionRef = useRef<string | null>(null);
  const handoffSessionRef = useRef<string | null>(null);
  const handoffTakeoverStateRef = useRef<"agent" | "awaiting-user" | "user">("agent");
  const handoffOutputBufferRef = useRef("");
  const deferredTerminalEvents = useRef(new Map<string, TerminalEvent[]>());
  const shellInputBufferRef = useRef("");
  const shellInputTimerRef = useRef<number | null>(null);
  const shellWriteChainRef = useRef(Promise.resolve());
  const shellResizeTimerRef = useRef<number | null>(null);
  const agentConsoleEndRef = useRef<HTMLDivElement>(null);
  const workspaceInspectCacheRef = useRef(new Map<string, RemoteWorkspace>());

  const runningCount = useMemo(() => runs.filter((run) => run.status === "running").length, [runs]);
  const visibleRuns = useMemo(() => {
    const query = search.trim().toLowerCase();
    return runs.filter((run) => {
      if (hostFilter !== "__all__" && run.host !== hostFilter) return false;
      if (!query) return true;
      return `${run.host} ${run.cwd ?? ""} ${run.command} ${run.stdout} ${run.stderr} ${run.message ?? ""}`.toLowerCase().includes(query);
    });
  }, [hostFilter, runs, search]);
  const consoleRuns = useMemo(() => [...visibleRuns].reverse(), [visibleRuns]);
  const latestRun = runs[0] ?? null;

  const rememberWorkspace = useCallback((workspace: RemoteWorkspace) => {
    setActiveWorkspace(workspace);
    try {
      window.localStorage.setItem(WORKSPACE_ACTIVE_KEY, JSON.stringify(workspace));
    } catch {
      // Active workspace persistence is best-effort only.
    }
    setRecentWorkspaces((current) => {
      const next = [workspace, ...current.filter((item) => item.host !== workspace.host || item.path !== workspace.path)].slice(0, MAX_RECENT_WORKSPACES);
      try {
        window.localStorage.setItem(WORKSPACE_RECENTS_KEY, JSON.stringify(next));
      } catch {
        // Recent workspace persistence is best-effort only.
      }
      return next;
    });
  }, []);

  const setWorkspaceFollowMode = useCallback((follow: boolean) => {
    setWorkspaceFollowAgent(follow);
    try {
      window.localStorage.setItem(WORKSPACE_FOLLOW_KEY, follow ? "follow" : "pinned");
    } catch {
      // Workspace follow mode persistence is best-effort only.
    }
  }, []);

  const clearActiveWorkspace = useCallback(() => {
    setActiveWorkspace(null);
    try {
      window.localStorage.removeItem(WORKSPACE_ACTIVE_KEY);
    } catch {
      // Active workspace persistence is best-effort only.
    }
  }, []);

  useEffect(() => {
    if (activeMode !== "agent" || consoleRuns.length === 0) return;
    requestAnimationFrame(() => agentConsoleEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }));
  }, [activeMode, consoleRuns.length]);

  const selectWorkspace = useCallback((workspace: RemoteWorkspace) => {
    setWorkspaceFollowMode(false);
    rememberWorkspace(workspace);
    if (!interactiveSessionRef.current && !handoffSessionRef.current) {
      setShellHost(workspace.host);
      setShellCwd(workspace.path);
    }
  }, [rememberWorkspace, setWorkspaceFollowMode]);

  const refreshActiveWorkspace = useCallback(async () => {
    if (!activeWorkspace || workspaceRefreshing) return;
    setWorkspaceRefreshing(true);
    try {
      const response = await requestReadOnly<{
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: { workspace?: RemoteWorkspace };
      }>("tools/call", {
        name: "workspace.inspect",
        arguments: { host: activeWorkspace.host, cwd: activeWorkspace.path },
      }, 30_000);
      if (response.isError || !response.structuredContent?.workspace) {
        throw new Error(response.content?.[0]?.text ?? "刷新远程项目失败");
      }
      const workspace = response.structuredContent.workspace;
      workspaceInspectCacheRef.current.set(`${workspace.host}\0${activeWorkspace.path}`, workspace);
      rememberWorkspace(workspace);
    } finally {
      setWorkspaceRefreshing(false);
    }
  }, [activeWorkspace, rememberWorkspace, workspaceRefreshing]);

  const removeRecentWorkspace = useCallback((workspace: RemoteWorkspace) => {
    setRecentWorkspaces((current) => {
      const next = current.filter((item) => item.host !== workspace.host || item.path !== workspace.path);
      try {
        window.localStorage.setItem(WORKSPACE_RECENTS_KEY, JSON.stringify(next));
      } catch {
        // Recent workspace persistence is best-effort only.
      }
      return next;
    });
  }, []);

  const clearRecentWorkspaces = useCallback(() => {
    setRecentWorkspaces([]);
    try {
      window.localStorage.removeItem(WORKSPACE_RECENTS_KEY);
    } catch {
      // Recent workspace persistence is best-effort only.
    }
  }, []);

  useEffect(() => {
    if (!workspaceFollowAgent) return;
    const host = latestRun?.host;
    const cwd = latestRun?.cwd?.trim();
    if (!host || !cwd) return;
    const key = `${host}\0${cwd}`;
    const cached = workspaceInspectCacheRef.current.get(key);
    if (cached) {
      rememberWorkspace(cached);
      return;
    }
    let disposed = false;
    void requestReadOnly<{
      isError?: boolean;
      content?: Array<{ text?: string }>;
      structuredContent?: { workspace?: RemoteWorkspace };
    }>("tools/call", {
      name: "workspace.inspect",
      arguments: { host, cwd },
    }, 30_000).then((response) => {
      if (disposed || response.isError || !response.structuredContent?.workspace) return;
      const workspace = response.structuredContent.workspace;
      workspaceInspectCacheRef.current.set(key, workspace);
      rememberWorkspace(workspace);
      if (!interactiveSessionRef.current && !handoffSessionRef.current) {
        setShellHost(workspace.host);
        setShellCwd(workspace.path);
      }
    }).catch(() => {
      // Workspace inference is advisory; command execution must not depend on it.
    });
    return () => { disposed = true; };
  }, [latestRun?.cwd, latestRun?.host, rememberWorkspace, workspaceFollowAgent]);

  const loadHosts = useCallback(async () => {
    const response = await requestReadOnly<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { hosts?: Host[] } }>(
      "tools/call",
      { name: "ssh.listHosts", arguments: {} },
    );
    if (response.isError) throw new Error(response.content?.[0]?.text ?? "无法读取 SSH 主机");
    const nextHosts = response.structuredContent?.hosts ?? [];
    setHosts(nextHosts);
    setShellHost((current) => {
      if (current && nextHosts.some((host) => host.id === current && host.resolved)) return current;
      return nextHosts.find((host) => host.resolved)?.id ?? "";
    });
  }, []);

  useEffect(() => {
    if (!activeWorkspace || interactiveSessionRef.current || handoffSessionRef.current) return;
    if (!hosts.some((host) => host.id === activeWorkspace.host && host.resolved)) return;
    setShellHost(activeWorkspace.host);
    setShellCwd(activeWorkspace.path);
  }, [activeWorkspace, hosts]);

  const handleInteractiveEvent = useCallback((event: TerminalEvent) => {
    const terminal = shellTerminalRef.current;
    if (!terminal) return;
    if (event.type === "terminal.opened") {
      setShellState({ label: `已连接 · ${event.host}`, state: "connected" });
    } else if (event.type === "terminal.data") {
      terminal.write(event.data ?? "");
    } else if (event.type === "terminal.closed") {
      terminal.write(`\r\n\x1b[90m[SSH 会话已关闭 · exit ${event.exitCode ?? "?"} · ${formatDuration(event.durationMs)}]\x1b[0m\r\n`);
      interactiveSessionRef.current = null;
      setShellState({ label: "未连接", state: "idle" });
      if (handoffSessionRef.current && handoffOutputBufferRef.current) {
        terminal.clear();
        terminal.write(handoffOutputBufferRef.current);
        handoffOutputBufferRef.current = "";
      }
    }
  }, []);

  const handleHandoffEvent = useCallback((event: TerminalEvent) => {
    const terminal = shellTerminalRef.current;
    if (event.type === "handoff.opened") {
      handoffSessionRef.current = event.sessionId;
      handoffTakeoverStateRef.current = event.takeoverState ?? "agent";
      handoffOutputBufferRef.current = "";
      setHandoff({
        sessionId: event.sessionId,
        host: event.host,
        cwd: event.cwd ?? null,
        command: event.command ?? "",
        running: true,
        takeoverState: event.takeoverState ?? "agent",
        prompt: event.prompt ?? null,
      });
      if (!interactiveSessionRef.current && terminal) {
        terminal.clear();
        terminal.write(`\x1b[90m[Agent 交互会话 · ${event.host}]\x1b[0m\r\n`);
      }
      return;
    }
    if (event.sessionId !== handoffSessionRef.current) return;
    if (event.type === "handoff.data") {
      if (interactiveSessionRef.current) {
        handoffOutputBufferRef.current = capOutput(`${handoffOutputBufferRef.current}${event.data ?? ""}`, 180_000);
      } else {
        terminal?.write(event.data ?? "");
      }
      return;
    }
    if (event.type === "handoff.state") {
      const takeoverState = event.takeoverState ?? "agent";
      handoffTakeoverStateRef.current = takeoverState;
      setHandoff((current) => current ? { ...current, takeoverState, prompt: event.prompt !== undefined ? event.prompt : current.prompt } : current);
      if (takeoverState === "awaiting-user") setActiveMode("terminal");
      if (takeoverState === "user") terminal?.focus();
      return;
    }
    if (event.type === "handoff.closed") {
      terminal?.write(`\r\n\x1b[90m[Agent 交互会话已结束 · exit ${event.exitCode ?? "?"}]\x1b[0m\r\n`);
      handoffSessionRef.current = null;
      handoffTakeoverStateRef.current = "agent";
      handoffOutputBufferRef.current = "";
      setHandoff((current) => current ? { ...current, running: false, takeoverState: "agent", prompt: null } : current);
    }
  }, []);

  const applyEvent = useCallback((event: TerminalEvent) => {
    if (event.type.startsWith("handoff.")) {
      handleHandoffEvent(event);
      return;
    }
    if (event.type.startsWith("terminal.")) {
      if (event.sessionId === interactiveSessionRef.current) {
        handleInteractiveEvent(event);
      } else if (!interactiveSessionRef.current) {
        const queued = deferredTerminalEvents.current.get(event.sessionId) ?? [];
        queued.push(event);
        if (queued.length > 100) queued.splice(0, queued.length - 100);
        deferredTerminalEvents.current.set(event.sessionId, queued);
      }
      return;
    }

    setRuns((current) => {
      if (event.type === "command.started") {
        const existing = current.findIndex((run) => run.sessionId === event.sessionId);
        if (existing >= 0) return current;
        const startedAt = event.at ?? new Date().toISOString();
        const stale = isStaleRunningStart(startedAt);
        const next: CommandRun = {
          sessionId: event.sessionId,
          host: event.host,
          cwd: event.cwd ?? null,
          command: event.command ?? "",
          startedAt,
          status: stale ? "interrupted" : "running",
          stdout: "",
          stderr: "",
          exitCode: null,
          durationMs: null,
          message: stale ? "Remote SSH runtime 已结束，未收到该命令的完成事件" : null,
        };
        return [next, ...current].slice(0, 120);
      }

      const index = current.findIndex((run) => run.sessionId === event.sessionId);
      if (index < 0) return current;
      const next = [...current];
      const run = { ...next[index] };
      if (event.type === "stdout") run.stdout = capOutput(`${run.stdout}${event.data ?? ""}`, 180_000);
      if (event.type === "stderr") run.stderr = capOutput(`${run.stderr}${event.data ?? ""}`, 80_000);
      if (event.type === "command.completed") {
        run.status = event.exitCode === 0 ? "success" : "error";
        run.exitCode = event.exitCode ?? null;
        run.durationMs = event.durationMs ?? null;
      }
      if (event.type === "command.failed") {
        run.status = "error";
        run.exitCode = event.exitCode ?? null;
        run.durationMs = event.durationMs ?? null;
        run.message = event.message ?? "SSH command failed";
      }
      next[index] = run;
      return next;
    });
  }, [handleHandoffEvent, handleInteractiveEvent]);

  useEffect(() => {
    const reconcile = () => setRuns((current) => reconcileRunningRuns(current));
    reconcile();
    const timer = window.setInterval(reconcile, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!shellContainerRef.current || !shellFrameRef.current) return;
    const shell = createTerminal(false, true);
    shell.instance.open(shellContainerRef.current);
    shellTerminalRef.current = shell.instance;
    shellFitRef.current = shell.addon;

    const flushShellInput = () => {
      if (shellInputTimerRef.current !== null) window.clearTimeout(shellInputTimerRef.current);
      shellInputTimerRef.current = null;
      const data = shellInputBufferRef.current;
      shellInputBufferRef.current = "";
      const manualSessionId = interactiveSessionRef.current;
      const handoffSessionId = handoffSessionRef.current;
      const useHandoff = !manualSessionId && Boolean(handoffSessionId) && handoffTakeoverStateRef.current === "user";
      const sessionId = manualSessionId ?? (useHandoff ? handoffSessionId : null);
      if (!sessionId || !data) return;
      shellWriteChainRef.current = shellWriteChainRef.current
        .then(async () => {
          const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
            name: useHandoff ? "handoff.write" : "terminal.write",
            arguments: { sessionId, data },
          });
          if (response.isError) throw new Error(response.content?.[0]?.text ?? "终端输入失败");
        })
        .catch((nextError) => {
          setShellState({ label: userFacingError(nextError, "终端输入失败"), state: "error" });
        });
    };

    const inputDisposable = shell.instance.onData((data) => {
      if (!interactiveSessionRef.current && !(handoffSessionRef.current && handoffTakeoverStateRef.current === "user")) return;
      shellInputBufferRef.current += data;
      if (shellInputBufferRef.current.length >= 64 * 1024) flushShellInput();
      else if (shellInputTimerRef.current === null) shellInputTimerRef.current = window.setTimeout(flushShellInput, 16);
    });

    const resizeDisposable = shell.instance.onResize(({ cols, rows }) => {
      if (!interactiveSessionRef.current && !handoffSessionRef.current) return;
      if (shellResizeTimerRef.current !== null) window.clearTimeout(shellResizeTimerRef.current);
      shellResizeTimerRef.current = window.setTimeout(async () => {
        shellResizeTimerRef.current = null;
        const useHandoff = !interactiveSessionRef.current && Boolean(handoffSessionRef.current);
        const sessionId = interactiveSessionRef.current ?? handoffSessionRef.current;
        if (!sessionId) return;
        try {
          const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
            name: useHandoff ? "handoff.resize" : "terminal.resize",
            arguments: { sessionId, cols, rows },
          });
          if (response.isError) throw new Error(response.content?.[0]?.text ?? "终端尺寸同步失败");
        } catch (nextError) {
          setShellState({ label: userFacingError(nextError, "终端尺寸同步失败"), state: "error" });
        }
      }, 80);
    });

    const observer = new ResizeObserver(() => requestAnimationFrame(() => shell.addon.fit()));
    observer.observe(shellFrameRef.current);
    requestAnimationFrame(() => shell.addon.fit());

    return () => {
      inputDisposable.dispose();
      resizeDisposable.dispose();
      observer.disconnect();
      shell.instance.dispose();
      shellTerminalRef.current = null;
      shellFitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (activeMode === "terminal") requestAnimationFrame(() => shellFitRef.current?.fit());
  }, [activeMode]);

  useEffect(() => {
    disposedRef.current = false;
    void loadHosts().catch((nextError) => {
      setConnectionState("error");
      setConnectionText(userFacingError(nextError, "读取 SSH 主机失败"));
    });

    let polling = false;
    let timer: number | undefined;
    const poll = async () => {
      if (disposedRef.current || polling) return;
      polling = true;
      try {
        const response = await requestReadOnly<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { runtimeId?: string; events?: TerminalEvent[]; nextSeq?: number; nextLocalSeq?: number; activeCommandSessionIds?: string[] } }>(
          "tools/call",
          { name: "terminal.events", arguments: { afterSeq: cursorRef.current, afterLocalSeq: localCursorRef.current, limit: 500 } },
        );
        if (response.isError) throw new Error(response.content?.[0]?.text ?? "终端事件读取失败");
        const nextRuntimeId = response.structuredContent?.runtimeId ?? null;
        const runtimeChanged = Boolean(runtimeIdRef.current && nextRuntimeId && runtimeIdRef.current !== nextRuntimeId);
        if (runtimeChanged) {
          const sessionId = interactiveSessionRef.current;
          if (sessionId) {
            interactiveSessionRef.current = null;
            deferredTerminalEvents.current.clear();
            shellTerminalRef.current?.write("\r\n\x1b[90m[Remote SSH runtime 已重启，原交互会话已关闭]\x1b[0m\r\n");
            setShellState({ label: "未连接", state: "idle" });
          }
          if (handoffSessionRef.current) {
            handoffSessionRef.current = null;
            handoffTakeoverStateRef.current = "agent";
            handoffOutputBufferRef.current = "";
            setHandoff(null);
            shellTerminalRef.current?.write("\r\n\x1b[90m[Remote SSH runtime 已重启，Human Takeover 会话已关闭]\x1b[0m\r\n");
          }
        }
        if (nextRuntimeId) runtimeIdRef.current = nextRuntimeId;
        for (const event of response.structuredContent?.events ?? []) applyEvent(event);
        const activeCommandSessionIds = response.structuredContent?.activeCommandSessionIds;
        if (activeCommandSessionIds) {
          const active = new Set(activeCommandSessionIds);
          setRuns((current) => reconcileRunningRuns(current, active));
        }
        cursorRef.current = Number(response.structuredContent?.nextSeq ?? cursorRef.current);
        localCursorRef.current = runtimeChanged
          ? 0
          : Number(response.structuredContent?.nextLocalSeq ?? localCursorRef.current);
        setConnectionState("connected");
        setConnectionText("已连接");
      } catch (nextError) {
        setConnectionState("error");
        setConnectionText(userFacingError(nextError, "Remote SSH 连接异常"));
      } finally {
        polling = false;
        if (!disposedRef.current) timer = window.setTimeout(poll, 300);
      }
    };
    void poll();
    return () => {
      disposedRef.current = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyEvent, loadHosts]);

  useEffect(() => {
    const teardown = () => {
      const sessionId = interactiveSessionRef.current;
      if (sessionId) void request("tools/call", { name: "terminal.closeSession", arguments: { sessionId } }).catch(() => {});
    };
    teardownCallbacks.add(teardown);
    return () => void teardownCallbacks.delete(teardown);
  }, []);

  const openInteractive = async () => {
    if (interactiveSessionRef.current || !shellHost || !shellTerminalRef.current) return;
    if (handoffSessionRef.current) {
      setShellState({ label: "当前有 Agent 交互会话，请先等待其结束", state: "error" });
      return;
    }
    setShellState({ label: "连接中…", state: "connecting" });
    shellTerminalRef.current.clear();
    shellTerminalRef.current.write(`\x1b[90m正在连接 ${shellHost}${shellCwd.trim() ? ` · ${shellCwd.trim()}` : ""}…\x1b[0m\r\n`);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { sessionId?: string } }>("tools/call", {
        name: "terminal.openSession",
        arguments: {
          host: shellHost,
          ...(shellCwd.trim() ? { cwd: shellCwd.trim() } : {}),
          cols: shellTerminalRef.current.cols,
          rows: shellTerminalRef.current.rows,
        },
      });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "SSH 终端连接失败");
      const sessionId = String(response.structuredContent?.sessionId ?? "");
      if (!sessionId) throw new Error("SSH 终端未返回 sessionId");
      interactiveSessionRef.current = sessionId;
      for (const event of deferredTerminalEvents.current.get(sessionId) ?? []) handleInteractiveEvent(event);
      deferredTerminalEvents.current.delete(sessionId);
      setShellState({ label: `已连接 · ${shellHost}`, state: "connected" });
      shellTerminalRef.current.focus();
    } catch (nextError) {
      setShellState({ label: userFacingError(nextError, "终端连接失败"), state: "error" });
    }
  };

  const closeInteractive = async () => {
    const sessionId = interactiveSessionRef.current;
    if (!sessionId) return;
    setShellState({ label: "断开中…", state: "connecting" });
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "terminal.closeSession",
        arguments: { sessionId },
      });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "SSH 终端断开失败");
    } catch (nextError) {
      setShellState({ label: userFacingError(nextError, "终端断开失败"), state: "error" });
    }
  };

  const takeoverHandoff = async () => {
    const sessionId = handoffSessionRef.current;
    if (!sessionId) return;
    if (interactiveSessionRef.current) {
      setShellState({ label: "请先断开当前人工终端，再接管 Agent 会话", state: "error" });
      return;
    }
    const response = await request<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { takeoverState?: "user" } }>("tools/call", {
      name: "handoff.takeover",
      arguments: { sessionId },
    });
    if (response.isError) {
      setShellState({ label: response.content?.[0]?.text ?? "接管失败", state: "error" });
      return;
    }
    handoffTakeoverStateRef.current = "user";
    setHandoff((current) => current ? { ...current, takeoverState: "user" } : current);
    shellTerminalRef.current?.focus();
  };

  const releaseHandoff = async () => {
    const sessionId = handoffSessionRef.current;
    if (!sessionId) return;
    const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
      name: "handoff.release",
      arguments: { sessionId },
    });
    if (response.isError) {
      setShellState({ label: response.content?.[0]?.text ?? "交回 Agent 失败", state: "error" });
      return;
    }
    handoffTakeoverStateRef.current = "agent";
    setHandoff((current) => current ? { ...current, takeoverState: "agent", prompt: null } : current);
  };

  const cancelHandoff = async () => {
    const sessionId = handoffSessionRef.current;
    if (!sessionId) return;
    const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
      name: "ssh.poll",
      arguments: { sessionId, yieldTimeMs: 0, cancel: true },
    });
    if (response.isError) {
      setShellState({ label: response.content?.[0]?.text ?? "取消 Agent 交互会话失败", state: "error" });
    }
  };

  const shellHostInfo = hosts.find((host) => host.id === shellHost);
  const shellPlaceholder = shellHostInfo?.defaultCwd ? `默认 ${shellHostInfo.defaultCwd}` : "远端登录目录";

  const saveHost = async (event: React.FormEvent) => {
    event.preventDefault();
    setHostFormError("");
    const port = Number(hostDraft.port);
    if (!hostDraft.id.match(/^[A-Za-z0-9._-]+$/)) return setHostFormError("主机 ID 只能包含字母、数字、点、下划线和短横线");
    if (!hostDraft.hostname.trim() || !hostDraft.user.trim()) return setHostFormError("地址和用户不能为空");
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setHostFormError("端口必须在 1–65535 之间");
    if (hostDraft.connectionMode === "jump" && !hostDraft.proxyJump.trim()) return setHostFormError("请选择或填写跳板机");
    setHostSaving(true);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "hosts.save",
        arguments: {
          id: hostDraft.id.trim(),
          hostname: hostDraft.hostname.trim(),
          user: hostDraft.user.trim(),
          port,
          ...(hostDraft.identityFile.trim() ? { identityFile: hostDraft.identityFile.trim() } : {}),
          ...(hostDraft.connectionMode === "jump" ? { proxyJump: hostDraft.proxyJump.trim() } : {}),
          ...(hostDraft.defaultCwd.trim() ? { defaultCwd: hostDraft.defaultCwd.trim() } : {}),
        },
      });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "保存失败");
      setHostDraft(EMPTY_HOST);
      setSettingsPage("hosts");
      await loadHosts();
    } catch (nextError) {
      setHostFormError(userFacingError(nextError, "保存主机失败"));
    } finally {
      setHostSaving(false);
    }
  };

  const removeHost = async (id: string) => {
    const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
      name: "hosts.remove",
      arguments: { id },
    });
    if (response.isError) throw new Error(response.content?.[0]?.text ?? "删除失败");
    await loadHosts();
  };

  const resetHostEditor = () => {
    setHostDraft(EMPTY_HOST);
    setHostFormError("");
    setSettingsPage("editor");
  };

  const formatTime = (value: string | null) => {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const handoffActive = Boolean(handoff?.running && handoffSessionRef.current);
  const shellConnected = shellState.state === "connected";
  const terminalLive = shellConnected || handoffActive;
  const shellIdentity = handoffActive
    ? `${handoff?.host ?? "SSH"} · Agent 交互命令`
    : shellHostInfo
      ? `${shellHostInfo.user ? `${shellHostInfo.user}@` : ""}${shellHostInfo.hostname}`
      : "无活动会话";
  const sftpContextHost = handoffActive
    ? handoff?.host ?? null
    : activeWorkspace?.host
      ?? (activeMode === "terminal"
        ? shellHost || null
        : latestRun?.host ?? (hostFilter !== "__all__" ? hostFilter : null));
  const sftpContextCwd = handoffActive
    ? handoff?.cwd ?? null
    : activeWorkspace?.path
      ?? (activeMode === "terminal"
        ? shellCwd.trim() || shellHostInfo?.defaultCwd || null
        : latestRun?.cwd ?? null);
  const sftpRefreshKey = latestRun
    ? `${latestRun.sessionId}:${latestRun.status}:${latestRun.durationMs ?? ""}`
    : "";

  const clearRuns = async () => {
    setRuns([]);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "terminal.clearCommandEvents",
        arguments: {},
      });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "清空运行记录失败");
    } catch (nextError) {
      setConnectionState("error");
      setConnectionText(userFacingError(nextError, "清空运行记录失败"));
    }
  };

  return (
    <div className="workspace-shell">
      <header className="control-deck">
        <div className="fabric-status" aria-live="polite">
          <Tooltip content={`服务器状态 · ${connectionText}`}>
            <button
              type="button"
              className={`fabric-orb ${connectionState}`}
              aria-label="打开服务器状态"
              onClick={() => setMonitorOpen(true)}
            >
              <span />
            </button>
          </Tooltip>
          <div className="fabric-copy">
            <span className="fabric-kicker">REMOTE SSH</span>
            <span className="fabric-meta">
              {connectionState === "connected" ? "在线" : connectionState === "connecting" ? "连接中" : "离线"}
              <span aria-hidden="true">·</span>
              {hosts.length} 台主机
              {runningCount > 0 && <><span aria-hidden="true">·</span>{runningCount} 执行中</>}
            </span>
          </div>
        </div>

        <WorkspaceSwitcher
          hosts={hosts}
          active={activeWorkspace}
          recents={recentWorkspaces}
          contextHost={latestRun?.host ?? (shellHost || null)}
          contextCwd={latestRun?.cwd ?? (shellCwd.trim() || null)}
          followAgent={workspaceFollowAgent}
          refreshing={workspaceRefreshing}
          onSelect={selectWorkspace}
          onFollowAgentChange={setWorkspaceFollowMode}
          onRefreshActive={refreshActiveWorkspace}
          onRemoveRecent={removeRecentWorkspace}
          onClearRecents={clearRecentWorkspaces}
        />

        <div className={`mode-switch mode-${activeMode}`} role="tablist" aria-label="Remote SSH workspace mode">
          <button type="button" role="tab" aria-label="Agent" aria-selected={activeMode === "agent"} className={activeMode === "agent" ? "is-active" : ""} onClick={() => setActiveMode("agent")}>
            <ActivityLogIcon />
            <span>Agent</span>
          </button>
          <button type="button" role="tab" aria-label="Terminal" aria-selected={activeMode === "terminal"} className={activeMode === "terminal" ? "is-active" : ""} onClick={() => setActiveMode("terminal")}>
            <CodeIcon />
            <span>Terminal</span>
          </button>
        </div>

        <div className="deck-actions">
          <PortForwardDialog hosts={hosts} />
          <Dialog.Root open={settingsOpen} onOpenChange={(open) => { setSettingsOpen(open); if (!open) setSettingsPage("hosts"); }}>
          <Dialog.Trigger>
            <IconButton className="deck-icon-button" size="2" variant="ghost" color="gray" aria-label="Remote SSH 设置"><GearIcon /></IconButton>
          </Dialog.Trigger>
          <Dialog.Content maxWidth="620px" className="settings-dialog">
              {settingsPage === "hosts" ? (
                <>
                  <Flex justify="between" align="start" gap="3" mb="4">
                    <Box>
                      <Dialog.Title>SSH 主机</Dialog.Title>
                      <Dialog.Description size="2" color="gray">自动合并 OpenSSH 配置和插件管理的主机。</Dialog.Description>
                    </Box>
                    <Flex align="center" gap="2" flexShrink="0">
                      <Button size="2" onClick={resetHostEditor}><PlusIcon /> 添加 / 更新</Button>
                      <Dialog.Close>
                        <IconButton size="2" variant="ghost" color="gray" aria-label="关闭设置"><Cross1Icon /></IconButton>
                      </Dialog.Close>
                    </Flex>
                  </Flex>
                  <ScrollArea type="auto" scrollbars="vertical" className="settings-hosts-scroll">
                    <Flex direction="column" gap="2" pr="2">
                      {hosts.map((host) => (
                        <Card key={host.id} size="2" className="settings-host-card">
                          <Flex justify="between" align="center" gap="3">
                            <Box minWidth="0">
                              <Flex align="center" gap="2" mb="1">
                                <Text size="2" weight="medium" truncate>{host.alias}</Text>
                                <Badge size="1" variant="soft" color={host.source === "managed" ? "blue" : "gray"}>{host.source === "managed" ? "插件" : "OpenSSH"}</Badge>
                              </Flex>
                              <Text as="div" size="1" color="gray" truncate>{host.user ? `${host.user}@` : ""}{host.hostname}:{host.port}</Text>
                              {host.proxyJump && <Text as="div" size="1" color="gray" truncate>经跳板机 {host.proxyJump}</Text>}
                            </Box>
                            {host.source === "managed" && (
                              <AlertDialog.Root>
                                <AlertDialog.Trigger><IconButton size="1" variant="ghost" color="red" aria-label={`删除 ${host.alias}`}><TrashIcon /></IconButton></AlertDialog.Trigger>
                                <AlertDialog.Content maxWidth="420px">
                                  <AlertDialog.Title>删除主机 {host.alias}？</AlertDialog.Title>
                                  <AlertDialog.Description size="2">只删除插件配置，不会删除 SSH 密钥。</AlertDialog.Description>
                                  <Flex justify="end" gap="2" mt="4">
                                    <AlertDialog.Cancel><Button variant="soft" color="gray">取消</Button></AlertDialog.Cancel>
                                    <AlertDialog.Action><Button color="red" onClick={() => void removeHost(host.id)}>删除</Button></AlertDialog.Action>
                                  </Flex>
                                </AlertDialog.Content>
                              </AlertDialog.Root>
                            )}
                          </Flex>
                        </Card>
                      ))}
                    </Flex>
                  </ScrollArea>
                </>
              ) : (
                <>
                  <Flex align="center" gap="2" mb="3">
                    <IconButton size="2" variant="ghost" color="gray" onClick={() => setSettingsPage("hosts")} aria-label="返回主机列表"><ArrowLeftIcon /></IconButton>
                    <Box flexGrow="1" minWidth="0">
                      <Dialog.Title>添加 / 更新主机</Dialog.Title>
                      <Dialog.Description size="2" color="gray">只保存密钥文件路径，不读取私钥内容。</Dialog.Description>
                    </Box>
                    <Dialog.Close>
                      <IconButton size="2" variant="ghost" color="gray" aria-label="关闭设置"><Cross1Icon /></IconButton>
                    </Dialog.Close>
                  </Flex>
                  <form onSubmit={(event) => void saveHost(event)}>
                    <Grid columns="2" gap="3">
                      <Box gridColumn="1 / -1"><Text as="label" size="2" weight="medium">主机 ID</Text><TextField.Root mt="1" value={hostDraft.id} onChange={(event) => setHostDraft((draft) => ({ ...draft, id: event.target.value }))} placeholder="drama-prod" /></Box>
                      <Box gridColumn="1 / -1"><Text as="label" size="2" weight="medium">地址</Text><TextField.Root mt="1" value={hostDraft.hostname} onChange={(event) => setHostDraft((draft) => ({ ...draft, hostname: event.target.value }))} placeholder="server.example.com" /></Box>
                      <Box><Text as="label" size="2" weight="medium">用户</Text><TextField.Root mt="1" value={hostDraft.user} onChange={(event) => setHostDraft((draft) => ({ ...draft, user: event.target.value }))} /></Box>
                      <Box><Text as="label" size="2" weight="medium">端口</Text><TextField.Root mt="1" type="number" value={hostDraft.port} onChange={(event) => setHostDraft((draft) => ({ ...draft, port: event.target.value }))} /></Box>
                      <Box gridColumn="1 / -1"><Text as="label" size="2" weight="medium">IdentityFile</Text><TextField.Root mt="1" value={hostDraft.identityFile} onChange={(event) => setHostDraft((draft) => ({ ...draft, identityFile: event.target.value }))} placeholder="~/.ssh/id_drama_prod" /></Box>
                      <Box gridColumn="1 / -1">
                        <Text as="label" size="2" weight="medium">连接方式</Text>
                        <Select.Root
                          value={hostDraft.connectionMode}
                          onValueChange={(value) => setHostDraft((draft) => ({
                            ...draft,
                            connectionMode: value === "jump" ? "jump" : "direct",
                            ...(value === "direct" ? { proxyJump: "" } : {}),
                          }))}
                        >
                          <Select.Trigger mt="1" style={{ width: "100%" }} />
                          <Select.Content>
                            <Select.Item value="direct">直连</Select.Item>
                            <Select.Item value="jump">经跳板机</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      </Box>
                      {hostDraft.connectionMode === "jump" && (
                        <Box gridColumn="1 / -1">
                          <Text as="label" size="2" weight="medium">跳板机</Text>
                          <TextField.Root mt="1" value={hostDraft.proxyJump} onChange={(event) => setHostDraft((draft) => ({ ...draft, proxyJump: event.target.value }))} placeholder="bastion 或 user@bastion.example.com" />
                          <Text as="div" size="1" color="gray" mt="1">使用 OpenSSH ProxyJump；可填写 ~/.ssh/config 中的 Host 别名或 user@host。</Text>
                        </Box>
                      )}
                      <Box gridColumn="1 / -1"><Text as="label" size="2" weight="medium">默认目录</Text><TextField.Root mt="1" value={hostDraft.defaultCwd} onChange={(event) => setHostDraft((draft) => ({ ...draft, defaultCwd: event.target.value }))} placeholder="/opt/project（可选）" /></Box>
                    </Grid>
                    {hostFormError && <Text as="div" size="1" color="red" mt="3">{hostFormError}</Text>}
                    <Flex justify="end" gap="2" mt="4"><Button type="button" variant="soft" color="gray" onClick={() => setSettingsPage("hosts")}>取消</Button><Button type="submit" loading={hostSaving}>保存主机</Button></Flex>
                  </form>
                </>
              )}
            </Dialog.Content>
          </Dialog.Root>
        </div>
      </header>

      <ServerMonitorDialog hosts={hosts} open={monitorOpen} onOpenChange={setMonitorOpen} />

      <div className={`workspace-body ${sftpCollapsed ? "sftp-collapsed" : ""}`}>
        <SftpPanel
          hosts={hosts}
          contextHost={sftpContextHost}
          contextCwd={sftpContextCwd}
          refreshKey={sftpRefreshKey}
          agentRun={latestRun}
          collapsed={sftpCollapsed}
          onCollapsedChange={setSftpCollapsed}
        />
        <div className="workspace-main">
          <section className={`workspace-pane agent-pane ${activeMode === "agent" ? "is-active" : "is-hidden"}`} aria-hidden={activeMode !== "agent"}>
          <Flex align="center" gap="2" className="agent-toolbar glass-toolbar">
            <Select.Root value={hostFilter} onValueChange={setHostFilter}>
              <Select.Trigger className="host-select" variant="surface" />
              <Select.Content><Select.Item value="__all__">全部主机</Select.Item>{hosts.map((host) => <Select.Item key={host.id} value={host.id}>{host.alias}</Select.Item>)}</Select.Content>
            </Select.Root>
            <TextField.Root className="run-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索命令或输出"><TextField.Slot><MagnifyingGlassIcon /></TextField.Slot></TextField.Root>
            <span className={`activity-pill agent-toolbar-status ${runningCount ? "running" : "idle"}`}>
              <span className="activity-dot" />
              {runningCount ? `${runningCount} 执行中` : "待命"}
            </span>
            <Tooltip content="清空运行记录"><IconButton className="agent-toolbar-clear" size="1" variant="ghost" color="gray" onClick={() => void clearRuns()} aria-label="清空运行记录"><TrashIcon /></IconButton></Tooltip>
          </Flex>

          <div className={`agent-console-shell ${runningCount ? "is-live" : ""}`}>
            <div className="agent-console-chrome">
              <div className="agent-console-identity">
                <span className="agent-console-led" />
                <span>Codex Remote Console</span>
              </div>
              <span className="agent-console-mode">{runningCount ? "LIVE" : "HISTORY"}</span>
            </div>
            <ScrollArea type="auto" scrollbars="vertical" className="runs-scroll">
              <div className="agent-console">
                {consoleRuns.length === 0 ? (
                <div className="agent-empty">
                  <div className="empty-route" aria-hidden="true">
                    <span className="empty-route-node local"><CodeIcon /></span>
                    <span className="empty-route-line"><i /></span>
                    <span className="empty-route-node remote"><DesktopIcon /></span>
                  </div>
                  <span className="empty-kicker">READY</span>
                  <h3>等待远程任务</h3>
                  <p>执行 SSH 工具后，命令、输出和耗时会实时汇入这里。</p>
                  <span className="empty-host-count"><span />{hosts.length} 台主机已就绪</span>
                </div>
                ) : consoleRuns.map((run, index) => {
                const previous = consoleRuns[index - 1];
                const cwd = run.cwd?.trim() || "~";
                const previousCwd = previous?.cwd?.trim() || "~";
                const contextChanged = !previous || previous.host !== run.host || previousCwd !== cwd;
                return (
                  <React.Fragment key={run.sessionId}>
                    {contextChanged && (
                      <div className="console-context">
                        <span className="console-agent">Codex</span>
                        <span className="console-host">{run.host}</span>
                        <span className="console-cwd">{cwd}</span>
                      </div>
                    )}
                    <section className={`console-entry ${run.status}`}>
                      <div className="console-command-line">
                        <span className="prompt-token">❯</span>
                        <code>{run.command}</code>
                      </div>
                      {run.stdout && <pre className="console-output">{run.stdout}</pre>}
                      {(run.stderr || run.message) && (
                        <pre className="console-output error">{run.stderr}{run.message ? `${run.stderr ? "\n" : ""}${run.message}` : ""}</pre>
                      )}
                      <div className="console-result-line">
                        <span className={`console-result ${run.status}`}>
                          {run.status === "running" ? <ActivityLogIcon /> : run.status === "success" ? <CheckCircledIcon /> : <CrossCircledIcon />}
                          {run.status === "running" ? "运行中" : run.status === "success" ? `exit ${run.exitCode ?? 0}` : run.status === "interrupted" ? "已中断" : `exit ${run.exitCode ?? "?"}`}
                        </span>
                        <span title={run.durationMs !== null ? `${run.durationMs.toLocaleString()} ms` : undefined}>{run.durationMs !== null ? formatDuration(run.durationMs) : run.status === "running" ? "live" : run.status === "interrupted" ? ">1h" : ""}</span>
                        {run.startedAt && <time>{formatTime(run.startedAt)}</time>}
                      </div>
                    </section>
                  </React.Fragment>
                );
                })}
                <div ref={agentConsoleEndRef} className="agent-console-end" />
              </div>
            </ScrollArea>
          </div>
          </section>

          <section className={`workspace-pane terminal-pane ${activeMode === "terminal" ? "is-active" : "is-hidden"}`} aria-hidden={activeMode !== "terminal"}>
          {handoffActive ? (
            <div className={`connection-dock terminal-connection-bar handoff-bar is-${handoff?.takeoverState ?? "agent"}`}>
              <span className={`terminal-connection-state handoff-${handoff?.takeoverState ?? "agent"}`}>
                <span className="activity-dot" />
                {handoff?.takeoverState === "user" ? "你正在控制" : handoff?.takeoverState === "awaiting-user" ? "等待你的输入" : "Agent 执行中"}
              </span>
              <div className="handoff-context" title={handoff?.command}>
                <strong>{handoff?.host}</strong>
                <code>{handoff?.prompt || handoff?.command}</code>
              </div>
              <Flex align="center" gap="2" className="handoff-actions">
                {interactiveSessionRef.current ? (
                  <Button className="dock-action handoff-action" size="2" variant="soft" color="red" onClick={() => void closeInteractive()}>先断开终端</Button>
                ) : handoff?.takeoverState === "user" ? (
                  <Button className="dock-action handoff-action" size="2" variant="soft" onClick={() => void releaseHandoff()}>交回 Agent</Button>
                ) : (
                  <Button className="dock-action handoff-action" size="2" onClick={() => void takeoverHandoff()}>接管</Button>
                )}
                <Button className="dock-action handoff-cancel" size="2" variant="ghost" color="red" onClick={() => void cancelHandoff()}>取消</Button>
              </Flex>
            </div>
          ) : (
            <div className="connection-dock terminal-connection-bar">
              <span className={`terminal-connection-state ${shellState.state}`}>
                <span className="activity-dot" />
                {shellState.state === "connected" ? "已连接" : shellState.state === "connecting" ? "连接中" : shellState.state === "error" ? "连接失败" : "未连接"}
              </span>
              <Select.Root value={shellHost || undefined} onValueChange={(value) => {
                clearActiveWorkspace();
                setWorkspaceFollowMode(false);
                setShellHost(value);
              }} disabled={Boolean(interactiveSessionRef.current)}>
                <Select.Trigger className="terminal-host-select" placeholder="选择主机" variant="surface" />
                <Select.Content>{hosts.filter((host) => host.resolved).map((host) => <Select.Item key={host.id} value={host.id}>{host.alias} · {host.user}@{host.hostname}</Select.Item>)}</Select.Content>
              </Select.Root>
              <TextField.Root className="terminal-cwd" value={shellCwd} onChange={(event) => {
                clearActiveWorkspace();
                setWorkspaceFollowMode(false);
                setShellCwd(event.target.value);
              }} placeholder={shellPlaceholder} disabled={Boolean(interactiveSessionRef.current)} />
              {interactiveSessionRef.current ? (
                <Button className="dock-action" size="2" variant="soft" color="red" onClick={() => void closeInteractive()}>断开</Button>
              ) : (
                <Button className="dock-action" size="2" onClick={() => void openInteractive()} disabled={!shellHost}>连接</Button>
              )}
            </div>
          )}

          <div className={`terminal-surface ${terminalLive ? "is-live" : "is-idle"}`}>
            {terminalLive && (
              <div className="terminal-chrome">
                <div className="terminal-identity">
                  <span className="terminal-identity-dot" />
                  <span>{shellIdentity}</span>
                  {(handoffActive ? handoff?.cwd : shellCwd.trim()) && <span className="terminal-path">{handoffActive ? handoff?.cwd : shellCwd.trim()}</span>}
                </div>
              </div>
            )}
            <div ref={shellFrameRef} className="terminal-frame" aria-label="交互 SSH 终端">
              <div ref={shellContainerRef} className="xterm-host" />
              {!terminalLive && shellState.state !== "connecting" && (
                <div className="terminal-idle-overlay" aria-hidden="true">
                  <span>选择主机并连接后，即可直接操作远端 Shell。</span>
                </div>
              )}
            </div>
          </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function AppRoot() {
  const [mode, setMode] = useState<ViewMode>("loading");
  const [toolName, setToolName] = useState("");
  const [toolInput, setToolInput] = useState<Record<string, unknown>>({});
  const [toolResult, setToolResult] = useState<ToolResult | null>(null);
  const [hostContext, setHostContext] = useState<HostContext>({});

  useEffect(() => {
    const bootstrapMode = document.body.dataset.viewMode;
    const offInput = transport.on("ui/notifications/tool-input", (params) => {
      setToolInput((params.arguments ?? {}) as Record<string, unknown>);
    });
    const offResult = transport.on("ui/notifications/tool-result", (params) => {
      setToolResult(params as ToolResult);
    });
    const offHost = transport.on("ui/notifications/host-context-changed", (params) => {
      setHostContext((current) => ({ ...current, ...(params as HostContext) }));
    });

    if (parent !== window) {
      request<{
        protocolVersion: string;
        hostContext?: HostContext;
      }>("ui/initialize", {
        protocolVersion: "2026-01-26",
        appInfo: { name: "remote-ssh", version: "0.99.6" },
        appCapabilities: { tools: {}, availableDisplayModes: ["inline", "fullscreen"] },
      })
        .then((response) => {
          if (response.protocolVersion !== "2026-01-26") throw new Error(`Unsupported UI protocol: ${response.protocolVersion}`);
          const context = response.hostContext ?? {};
          const name = context.toolInfo?.tool?.name ?? "";
          setHostContext(context);
          setToolName(name);
          setMode(
            bootstrapMode === "command" || bootstrapMode === "workspace"
              ? bootstrapMode
              : name === "ssh.exec" || name === "ssh.execInteractive" || name === "ssh.testConnection"
                ? "command"
                : "workspace",
          );
          transport.notify("ui/notifications/initialized", {});
        })
        .catch(() => setMode("workspace"));
    } else {
      setMode("workspace");
    }

    return () => {
      offInput();
      offResult();
      offHost();
    };
  }, []);

  const standaloneTheme = parent === window ? new URLSearchParams(window.location.search).get("theme") : null;
  const appearance = hostContext.theme === "dark"
    ? "dark"
    : hostContext.theme === "light"
      ? "light"
      : standaloneTheme === "dark" || standaloneTheme === "light"
        ? standaloneTheme
        : undefined;

  return (
    <Theme appearance={appearance} accentColor="jade" grayColor="slate" radius="large" scaling="100%" className={mode === "command" ? "inline-theme" : "workspace-theme"}>
      {mode === "loading" ? <LoadingView /> : mode === "command" ? <CommandCard toolName={toolName} toolInput={toolInput} toolResult={toolResult} /> : <Workspace />}
    </Theme>
  );
}

transport.handle("ui/resource-teardown", () => {
  for (const callback of teardownCallbacks) callback();
  setTimeout(() => transport.dispose(), 0);
  return {};
});

createRoot(document.getElementById("root")!).render(<AppRoot />);
