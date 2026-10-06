import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";

import type { RemoteHost } from "./host-registry.js";
import { sshConfigPath } from "./ssh-config.js";
import { sshMultiplexingArgs } from "./ssh-performance.js";

const WORKSPACE_TIMEOUT_MS = 25_000;
const MAX_OUTPUT_CHARS = 512_000;

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

export type RemoteWorkspaceRoot = {
  path: string;
  source: "context" | "default" | "home" | "top-level";
};

function safeLocalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "SSH_AUTH_SOCK", "TMPDIR"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.LANG = "C";
  env.LC_ALL = "C";
  return env;
}

function sshArgs(host: RemoteHost, command: string): string[] {
  const args = [
    "-T",
    "-F", sshConfigPath(),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    ...sshMultiplexingArgs(),
  ];
  if (host.source === "managed") {
    args.push("-p", String(host.port));
    if (host.identityFile) args.push("-i", host.identityFile, "-o", "IdentitiesOnly=yes");
    if (host.proxyJump) args.push("-J", host.proxyJump);
    args.push("--", `${host.user}@${host.hostname}`);
  } else {
    args.push("--", host.alias);
  }
  args.push(command);
  return args;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function runWorkspaceProbe(host: RemoteHost, command: string, timeoutMs = WORKSPACE_TIMEOUT_MS): Promise<string> {
  const child = spawn("ssh", sshArgs(host, command), {
    env: safeLocalEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_CHARS); });
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64_000); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error(`远程项目探测超过 ${timeoutMs}ms`);
  if (code !== 0) throw new Error((stderr || stdout || `ssh exit ${code ?? "?"}`).trim());
  return stdout;
}

function workspaceId(host: string, remotePath: string): string {
  return crypto.createHash("sha256").update(`${host}\0${remotePath}`).digest("base64url").slice(0, 18);
}

function nameOf(remotePath: string): string {
  const normalized = remotePath.replace(/\/+$/, "") || "/";
  return normalized === "/" ? "/" : path.posix.basename(normalized);
}

function numberOrZero(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function serviceId(host: string, workspacePath: string, pid: number, port: number): string {
  return crypto.createHash("sha256").update(`${host}\0${workspacePath}\0${pid}\0${port}`).digest("base64url").slice(0, 18);
}

function workspaceRootSource(value: string): RemoteWorkspaceRoot["source"] | null {
  if (value === "context" || value === "default" || value === "home" || value === "top-level") return value;
  return null;
}

export async function discoverRemoteWorkspaceRoots(
  host: RemoteHost,
  contextCwd?: string | null,
): Promise<{ roots: RemoteWorkspaceRoot[] }> {
  const context = contextCwd?.trim() || "";
  const defaultCwd = host.defaultCwd?.trim() || "";
  const command = String.raw`
set -eu
emit_root() {
  kind="$1"
  candidate="$2"
  [ -n "$candidate" ] || return 0
  resolved=$(cd -- "$candidate" 2>/dev/null && pwd -P) || return 0
  printf '__WORKSPACE_ROOT__\t%s\t%s\n' "$kind" "$resolved"
}
emit_root context ${shellQuote(context)}
emit_root default ${shellQuote(defaultCwd)}
home=$(cd ~ 2>/dev/null && pwd -P || printf '')
emit_root home "$home"
for candidate in /*; do
  [ -d "$candidate" ] || continue
  [ -r "$candidate" ] && [ -x "$candidate" ] || continue
  case "$candidate" in
    /bin|/boot|/dev|/etc|/lib|/lib64|/lost+found|/proc|/run|/sbin|/snap|/sys|/usr) continue ;;
  esac
  emit_root top-level "$candidate"
done
`;
  const stdout = await runWorkspaceProbe(host, command, 12_000);
  const roots: RemoteWorkspaceRoot[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("__WORKSPACE_ROOT__\t")) continue;
    const [, sourceText = "", remotePath = ""] = line.split("\t");
    const source = workspaceRootSource(sourceText);
    if (!source || !remotePath || seen.has(remotePath)) continue;
    seen.add(remotePath);
    roots.push({ path: remotePath, source });
  }
  return { roots };
}

function classifyWorkspaceService(port: number, processName: string, hint: string): Pick<RemoteWorkspaceService, "kind" | "label" | "protocol"> {
  const text = `${processName} ${hint}`.toLowerCase();
  if (text.includes("comfyui") || port === 8188) return { kind: "comfyui", label: "ComfyUI", protocol: "http" };
  if (text.includes("jupyter") || port === 8888) return { kind: "jupyter", label: "Jupyter", protocol: "http" };
  if (text.includes("vite") || port === 5173 || port === 4173) return { kind: "vite", label: "Vite", protocol: "http" };
  if (hint === "next" || text.includes("next-server") || text.includes("next dev") || text.includes("next start")) return { kind: "next", label: "Next.js", protocol: "http" };
  if (text.includes("nuxt")) return { kind: "nuxt", label: "Nuxt", protocol: "http" };
  if (text.includes("spring") || (processName.toLowerCase().includes("java") && [8080, 8081, 8181].includes(port))) return { kind: "spring", label: "Spring Boot", protocol: "http" };
  if (text.includes("uvicorn") || text.includes("fastapi")) return { kind: "fastapi", label: "FastAPI", protocol: "http" };
  if (text.includes("flask")) return { kind: "flask", label: "Flask", protocol: "http" };
  if (text.includes("gunicorn")) return { kind: "gunicorn", label: "Gunicorn", protocol: "http" };
  if (text.includes("postgres") || port === 5432) return { kind: "postgres", label: "PostgreSQL", protocol: "tcp" };
  if (text.includes("mysqld") || port === 3306) return { kind: "mysql", label: "MySQL", protocol: "tcp" };
  if (text.includes("redis-server") || port === 6379) return { kind: "redis", label: "Redis", protocol: "tcp" };
  if (text.includes("opensearch") || port === 9200) return { kind: "opensearch", label: "OpenSearch", protocol: "http" };
  if (text.includes("qdrant") || port === 6333) return { kind: "qdrant", label: "Qdrant", protocol: "http" };
  if (text.includes("node") || [3000, 3001, 4000].includes(port)) return { kind: "node", label: "Node.js", protocol: "http" };
  if (text.includes("python") || [5000, 8000, 8001].includes(port)) return { kind: "python", label: "Python Web", protocol: "http" };
  if ([80, 443, 3000, 4173, 5000, 5173, 8000, 8080, 8081, 8181, 8188, 8888, 9200].includes(port)) {
    return { kind: "web", label: processName || `Web ${port}`, protocol: "http" };
  }
  return { kind: "tcp", label: processName || `TCP ${port}`, protocol: "tcp" };
}

function remoteConnectHost(bindAddress: string): string | null {
  const normalized = bindAddress.replace(/^\[|\]$/g, "");
  if (!normalized || normalized === "*" || normalized === "0.0.0.0" || normalized === "::" || normalized === "::1" || normalized === "localhost" || normalized.startsWith("127.")) {
    return "127.0.0.1";
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return normalized;
  return null;
}

function parseServiceRecord(host: RemoteHost, workspacePath: string, line: string): RemoteWorkspaceService | null {
  if (!line.startsWith("__SERVICE__\t")) return null;
  const [, bindAddress = "", portText = "", pidText = "", processName = "", cwd = "", hint = ""] = line.split("\t");
  const port = Number(portText);
  const pid = Number(pidText);
  const remoteHost = remoteConnectHost(bindAddress);
  if (!remoteHost || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid <= 0 || !cwd) return null;
  const classified = classifyWorkspaceService(port, processName, hint);
  return {
    id: serviceId(host.alias, workspacePath, pid, port),
    host: host.alias,
    workspacePath,
    cwd,
    bindAddress,
    remoteHost,
    port,
    pid,
    process: processName || "process",
    ...classified,
  };
}

function parseRecord(host: RemoteHost, line: string): RemoteWorkspace | null {
  const fields = line.split("\t");
  if (fields.length < 7) return null;
  const [remotePath, kindsText, gitRepo, gitRoot, branch, dirty, counts] = fields;
  if (!remotePath) return null;
  const [behindText, aheadText] = (counts ?? "0 0").trim().split(/\s+/);
  const kinds = kindsText ? kindsText.split(",").filter(Boolean) : [];
  return {
    id: workspaceId(host.alias, remotePath),
    host: host.alias,
    path: remotePath,
    name: nameOf(remotePath),
    kinds,
    recognized: kinds.length > 0,
    git: {
      repo: gitRepo === "1",
      root: gitRoot || null,
      branch: branch || null,
      dirty: dirty === "1",
      ahead: numberOrZero(aheadText),
      behind: numberOrZero(behindText),
    },
    inspectedAt: new Date().toISOString(),
  };
}

function recordScript(pathExpression: string): string {
  return String.raw`
p=${pathExpression}
if [ -z "$p" ] || [ ! -d "$p" ]; then exit 0; fi
kinds=""
add_kind() { if [ -z "$kinds" ]; then kinds="$1"; else kinds="$kinds,$1"; fi; }
[ -e "$p/.git" ] && add_kind git
[ -f "$p/package.json" ] && add_kind node
[ -f "$p/pom.xml" ] && add_kind maven
{ [ -f "$p/build.gradle" ] || [ -f "$p/build.gradle.kts" ]; } && add_kind gradle
[ -f "$p/pyproject.toml" ] && add_kind python
[ -f "$p/Cargo.toml" ] && add_kind rust
[ -f "$p/go.mod" ] && add_kind go
git_repo=0; git_root=""; branch=""; dirty=0; counts="0 0"
if command -v git >/dev/null 2>&1 && git -C "$p" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git_repo=1
  git_root=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null || printf '')
  branch=$(git -C "$p" symbolic-ref --short -q HEAD 2>/dev/null || git -C "$p" rev-parse --short HEAD 2>/dev/null || printf '')
  [ -n "$(git -C "$p" status --porcelain --untracked-files=normal 2>/dev/null)" ] && dirty=1
  counts=$(git -C "$p" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null || printf '0 0')
fi
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$p" "$kinds" "$git_repo" "$git_root" "$branch" "$dirty" "$counts"
`;
}

export async function inspectRemoteWorkspace(host: RemoteHost, cwd: string): Promise<RemoteWorkspace> {
  const target = cwd.trim() || host.defaultCwd || ".";
  const command = String.raw`
set -eu
start=${shellQuote(target)}
current=$(cd -- "$start" 2>/dev/null && pwd -P) || exit 3
p="$current"
while :; do
  if [ -e "$p/.git" ] || [ -f "$p/package.json" ] || [ -f "$p/pom.xml" ] || [ -f "$p/build.gradle" ] || [ -f "$p/build.gradle.kts" ] || [ -f "$p/pyproject.toml" ] || [ -f "$p/Cargo.toml" ] || [ -f "$p/go.mod" ]; then
    break
  fi
  parent=$(dirname -- "$p")
  [ "$parent" = "$p" ] && break
  p="$parent"
done
${recordScript('"$p"')}
`;
  const stdout = await runWorkspaceProbe(host, command);
  const record = stdout.split(/\r?\n/).map((line) => parseRecord(host, line)).find((value): value is RemoteWorkspace => Boolean(value));
  if (record) return record;
  const fallbackPath = target.startsWith("/") ? target : target;
  return {
    id: workspaceId(host.alias, fallbackPath),
    host: host.alias,
    path: fallbackPath,
    name: nameOf(fallbackPath),
    kinds: [],
    recognized: false,
    git: { repo: false, root: null, branch: null, dirty: false, ahead: 0, behind: 0 },
    inspectedAt: new Date().toISOString(),
  };
}

export async function discoverRemoteWorkspaces(
  host: RemoteHost,
  options: { root?: string | null; maxDepth?: number; maxProjects?: number } = {},
): Promise<{ root: string; workspaces: RemoteWorkspace[] }> {
  const target = options.root?.trim() || host.defaultCwd || ".";
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 3, 5));
  const maxProjects = Math.max(1, Math.min(options.maxProjects ?? 30, 80));
  const command = String.raw`
set -eu
root=$(cd -- ${shellQuote(target)} 2>/dev/null && pwd -P) || exit 3
printf '__ROOT__\t%s\n' "$root"
if find "$root" -maxdepth 0 -print >/dev/null 2>&1; then
  candidates=$(find "$root" -maxdepth ${maxDepth} \( -type d -name .git -print -prune \) -o \( -type d \( -name node_modules -o -name .venv -o -name vendor -o -name target \) -prune \) -o \( -type f \( -name package.json -o -name pom.xml -o -name build.gradle -o -name build.gradle.kts -o -name pyproject.toml -o -name Cargo.toml -o -name go.mod \) -print \) 2>/dev/null | sed 's#/.git$##; s#/package.json$##; s#/pom.xml$##; s#/build.gradle$##; s#/build.gradle.kts$##; s#/pyproject.toml$##; s#/Cargo.toml$##; s#/go.mod$##' | awk '!seen[$0]++' | head -n ${maxProjects})
else
  candidates=$(find "$root" \( -type d -name .git -print -prune \) -o \( -type d \( -name node_modules -o -name .venv -o -name vendor -o -name target \) -prune \) -o \( -type f \( -name package.json -o -name pom.xml -o -name build.gradle -o -name build.gradle.kts -o -name pyproject.toml -o -name Cargo.toml -o -name go.mod \) -print \) 2>/dev/null | sed 's#/.git$##; s#/package.json$##; s#/pom.xml$##; s#/build.gradle$##; s#/build.gradle.kts$##; s#/pyproject.toml$##; s#/Cargo.toml$##; s#/go.mod$##' | awk '!seen[$0]++' | head -n ${maxProjects})
fi
printf '%s\n' "$candidates" | while IFS= read -r p; do
  [ -n "$p" ] || continue
${recordScript('"$p"')}
done
`;
  const stdout = await runWorkspaceProbe(host, command);
  let resolvedRoot = target;
  const workspaces: RemoteWorkspace[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("__ROOT__\t")) {
      resolvedRoot = line.slice("__ROOT__\t".length);
      continue;
    }
    const record = parseRecord(host, line);
    if (record) workspaces.push(record);
  }
  workspaces.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  return { root: resolvedRoot, workspaces };
}

export async function discoverRemoteWorkspaceServices(
  host: RemoteHost,
  workspacePath: string,
): Promise<{ supported: boolean; services: RemoteWorkspaceService[]; inspectedAt: string }> {
  const target = workspacePath.trim();
  if (!target) return { supported: false, services: [], inspectedAt: new Date().toISOString() };
  const command = String.raw`
set -eu
workspace=$(cd -- ${shellQuote(target)} 2>/dev/null && pwd -P) || exit 3
if ! command -v ss >/dev/null 2>&1 || [ ! -d /proc ]; then
  printf '__SERVICE_SUPPORTED__\t0\n'
  exit 0
fi
printf '__SERVICE_SUPPORTED__\t1\n'
ss -ltnpH 2>/dev/null | while IFS= read -r line; do
  local_addr=$(printf '%s\n' "$line" | awk '{print $4}')
  [ -n "$local_addr" ] || continue
  port=\${local_addr##*:}
  case "$port" in ''|*[!0-9]*) continue ;; esac
  bind=\${local_addr%:*}
  bind=\${bind#\[}; bind=\${bind%\]}
  pid=$(printf '%s\n' "$line" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1)
  [ -n "$pid" ] || continue
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || printf '')
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null || printf '')
  args_raw=$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || printf '')
  belongs=0
  case "$cwd" in "$workspace"|"$workspace"/*) belongs=1 ;; esac
  case "$exe" in "$workspace"|"$workspace"/*) belongs=1 ;; esac
  case "$args_raw" in *"$workspace"*) belongs=1 ;; esac
  [ "$belongs" = 1 ] || continue
  proc=$(cat "/proc/$pid/comm" 2>/dev/null | tr '\t\r\n' '   ' || printf '')
  args=$(printf '%s' "$args_raw" | tr '[:upper:]' '[:lower:]')
  hint=""
  case "$args" in
    *comfyui*) hint="comfyui" ;;
    *jupyter*) hint="jupyter" ;;
    *vite*) hint="vite" ;;
    *next-server*|*"next dev"*|*"next start"*) hint="next" ;;
    *nuxt*) hint="nuxt" ;;
    *spring*) hint="spring" ;;
    *uvicorn*|*fastapi*) hint="fastapi" ;;
    *flask*) hint="flask" ;;
    *gunicorn*) hint="gunicorn" ;;
    *opensearch*) hint="opensearch" ;;
    *qdrant*) hint="qdrant" ;;
  esac
  printf '__SERVICE__\t%s\t%s\t%s\t%s\t%s\t%s\n' "$bind" "$port" "$pid" "$proc" "$cwd" "$hint"
done
`;
  const stdout = await runWorkspaceProbe(host, command, 15_000);
  const supported = stdout.split(/\r?\n/).some((line) => line === "__SERVICE_SUPPORTED__\t1");
  const services = stdout
    .split(/\r?\n/)
    .map((line) => parseServiceRecord(host, target, line))
    .filter((service): service is RemoteWorkspaceService => Boolean(service));
  const deduped = new Map<string, RemoteWorkspaceService>();
  for (const service of services) deduped.set(`${service.pid}:${service.port}`, service);
  return {
    supported,
    services: [...deduped.values()].sort((left, right) => left.port - right.port || left.label.localeCompare(right.label)).slice(0, 20),
    inspectedAt: new Date().toISOString(),
  };
}
