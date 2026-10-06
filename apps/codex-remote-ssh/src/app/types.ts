export type Host = {
  id: string;
  alias: string;
  hostname: string;
  user: string;
  port: number;
  resolved: boolean;
  source: "ssh-config" | "managed";
  identityConfigured: boolean;
  proxyJump?: string | null;
  defaultCwd?: string | null;
};

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
  at?: string;
  cwd?: string | null;
  command?: string;
  data?: string;
  exitCode?: number | null;
  durationMs?: number;
  message?: string;
  cols?: number;
  rows?: number;
  takeoverState?: "agent" | "awaiting-user" | "user";
  prompt?: string | null;
};

export type CommandRun = {
  sessionId: string;
  host: string;
  cwd: string | null;
  command: string;
  startedAt: string | null;
  status: "running" | "success" | "error" | "interrupted";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number | null;
  message: string | null;
};

export type ExecResult = {
  sessionId?: string | null;
  running?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  stdinOpen?: boolean;
  stdinCharsWritten?: number;
  interactive?: boolean;
  takeoverState?: "agent" | "awaiting-user" | "user";
  waitingForUser?: boolean;
  prompt?: string | null;
};

export type HandoffView = {
  sessionId: string;
  host: string;
  cwd: string | null;
  command: string;
  running: boolean;
  takeoverState: "agent" | "awaiting-user" | "user";
  prompt: string | null;
};

export type ToolResult = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

export type HostContext = {
  theme?: "light" | "dark";
  displayMode?: "inline" | "fullscreen" | "pip";
  containerDimensions?: { width?: number; maxWidth?: number; height?: number; maxHeight?: number };
  toolInfo?: { tool?: { name?: string; title?: string } };
};

export type ViewMode = "loading" | "command" | "workspace";
export type ConnectionState = "connecting" | "connected" | "error";

export type HostHealthInfo = {
  host: string;
  status: "unknown" | "online" | "unreachable" | "error";
  source: string | null;
  message: string | null;
  checkedAt: string | null;
  lastSuccessAt: string | null;
  stale: boolean;
};

export type RemoteWorkspace = {
  id: string;
  host: string;
  path: string;
  name: string;
  kinds: string[];
  recognized: boolean;
  git: {
    repo: boolean;
    root: string | null;
    branch: string | null;
    dirty: boolean;
    ahead: number;
    behind: number;
  };
  inspectedAt: string;
};

export type RemoteWorkspaceService = {
  id: string;
  host: string;
  workspacePath: string;
  cwd: string;
  bindAddress: string;
  remoteHost: string;
  port: number;
  pid: number;
  process: string;
  kind: string;
  label: string;
  protocol: "http" | "tcp";
};

export type SftpEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  permissions: string;
  owner: string;
  group: string;
  modified: string;
  linkTarget?: string | null;
};

export type SftpDirectory = {
  host: string;
  path: string;
  entries: SftpEntry[];
};

export type SftpDownloadStatus = {
  downloadId: string;
  host: string;
  path: string;
  localPath: string;
  status: "running" | "completed" | "error" | "cancelled";
  received: number;
  total: number | null;
  startedAt: string;
  error: string | null;
};

export type PortForwardInfo = {
  id: string;
  host: string;
  localHost: "127.0.0.1";
  localPort: number;
  remoteHost: string;
  remotePort: number;
  status: "starting" | "running" | "error";
  startedAt: string;
  error?: string | null;
};

export type ServerSnapshot = {
  host: string;
  hostname: string;
  platform: string;
  supported: boolean;
  cpuPercent: number | null;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  uptimeSeconds: number | null;
  gpuCount: number | null;
  gpuPercent: number | null;
  gpuMemoryUsedBytes: number | null;
  gpuMemoryTotalBytes: number | null;
  gpuPending: boolean;
  capturedAt: string;
};
