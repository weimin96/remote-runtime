import { spawn } from "node:child_process";

import type { RemoteHost } from "./host-registry.js";
import { sshConfigPath } from "./ssh-config.js";
import { connectionCacheKey, sshMultiplexingArgs } from "./ssh-performance.js";

const MONITOR_TIMEOUT_MS = 12_000;
const GPU_TIMEOUT_MS = 10_000;
const GPU_CACHE_TTL_MS = 20_000;
const MAX_OUTPUT_CHARS = 64_000;

const LINUX_PROBE = String.raw`set -eu
platform=$(uname -s 2>/dev/null || printf unknown)
printf 'platform=%s\n' "$platform"
printf 'hostname=%s\n' "$(hostname 2>/dev/null || printf unknown)"
if [ "$platform" != Linux ] || [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then
  printf 'supported=false\n'
  exit 0
fi
printf 'supported=true\n'
read_cpu() { awk '/^cpu / { total=0; for (i=2; i<=NF; i++) total += $i; idle=$5+$6; print total, idle; exit }' /proc/stat; }
set -- $(read_cpu); total1=$1; idle1=$2
sleep 0.2
set -- $(read_cpu); total2=$1; idle2=$2
dt=$((total2-total1)); di=$((idle2-idle1))
awk -v dt="$dt" -v di="$di" 'BEGIN { if (dt > 0) printf "cpu_percent=%.1f\n", ((dt-di)*100)/dt; else print "cpu_percent=0.0" }'
awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {available=$2} END {printf "memory_total_kb=%d\nmemory_available_kb=%d\n", total, available}' /proc/meminfo
awk '{printf "uptime_seconds=%.0f\n", $1}' /proc/uptime
awk '{printf "load1=%s\nload5=%s\nload15=%s\n", $1, $2, $3}' /proc/loadavg
df -Pk / 2>/dev/null | awk 'NR==2 {printf "disk_total_kb=%d\ndisk_used_kb=%d\n", $2, $3}'
`;

const GPU_PROBE = String.raw`set -eu
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | awk -F',' '
    BEGIN { count=0; util=0; used=0; total=0 }
    {
      gsub(/[[:space:]]/, "", $1); gsub(/[[:space:]]/, "", $2); gsub(/[[:space:]]/, "", $3);
      if ($1 ~ /^[0-9.]+$/ && $2 ~ /^[0-9.]+$/ && $3 ~ /^[0-9.]+$/) { util += $1; used += $2; total += $3; count += 1 }
    }
    END { if (count > 0) printf "gpu_checked=true\ngpu_count=%d\ngpu_percent=%.1f\ngpu_memory_used_mb=%.0f\ngpu_memory_total_mb=%.0f\n", count, util/count, used, total; else print "gpu_checked=true\ngpu_count=0" }'
else
  printf 'gpu_checked=true\ngpu_count=0\n'
fi
`;

type GpuMetrics = {
  count: number | null;
  percent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
};

type GpuCacheEntry = {
  metrics: GpuMetrics | null;
  updatedAt: number;
  pending: Promise<void> | null;
};

const gpuCache = new Map<string, GpuCacheEntry>();

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

function finiteNumber(values: Map<string, string>, key: string): number | null {
  const value = Number(values.get(key));
  return Number.isFinite(value) ? value : null;
}

function kbToBytes(value: number | null): number | null {
  return value === null ? null : value * 1024;
}

function parseValues(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function parseSnapshot(host: RemoteHost, stdout: string, gpu: GpuMetrics | null, gpuPending: boolean): ServerSnapshot {
  const values = parseValues(stdout);
  const memoryTotalKb = finiteNumber(values, "memory_total_kb");
  const memoryAvailableKb = finiteNumber(values, "memory_available_kb");
  const diskTotalKb = finiteNumber(values, "disk_total_kb");
  const diskUsedKb = finiteNumber(values, "disk_used_kb");
  return {
    host: host.alias,
    hostname: values.get("hostname") || host.hostname,
    platform: values.get("platform") || "unknown",
    supported: values.get("supported") === "true",
    cpuPercent: finiteNumber(values, "cpu_percent"),
    memoryTotalBytes: kbToBytes(memoryTotalKb),
    memoryUsedBytes: memoryTotalKb !== null && memoryAvailableKb !== null ? (memoryTotalKb - memoryAvailableKb) * 1024 : null,
    diskTotalBytes: kbToBytes(diskTotalKb),
    diskUsedBytes: kbToBytes(diskUsedKb),
    load1: finiteNumber(values, "load1"),
    load5: finiteNumber(values, "load5"),
    load15: finiteNumber(values, "load15"),
    uptimeSeconds: finiteNumber(values, "uptime_seconds"),
    gpuCount: gpu?.count ?? null,
    gpuPercent: gpu?.percent ?? null,
    gpuMemoryUsedBytes: gpu?.memoryUsedBytes ?? null,
    gpuMemoryTotalBytes: gpu?.memoryTotalBytes ?? null,
    gpuPending,
    capturedAt: new Date().toISOString(),
  };
}

async function runProbe(host: RemoteHost, command: string, timeoutMs: number): Promise<string> {
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
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_CHARS); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error(`服务器状态探针超过 ${timeoutMs}ms`);
  if (code !== 0) throw new Error((stderr || stdout || `ssh exit ${code ?? "?"}`).trim());
  return stdout;
}

function parseGpuMetrics(stdout: string): GpuMetrics {
  const values = parseValues(stdout);
  const count = finiteNumber(values, "gpu_count");
  const usedMb = finiteNumber(values, "gpu_memory_used_mb");
  const totalMb = finiteNumber(values, "gpu_memory_total_mb");
  return {
    count,
    percent: finiteNumber(values, "gpu_percent"),
    memoryUsedBytes: usedMb === null ? null : usedMb * 1024 * 1024,
    memoryTotalBytes: totalMb === null ? null : totalMb * 1024 * 1024,
  };
}

function gpuState(host: RemoteHost): GpuCacheEntry {
  const key = connectionCacheKey(host);
  const existing = gpuCache.get(key) ?? { metrics: null, updatedAt: 0, pending: null };
  const stale = Date.now() - existing.updatedAt >= GPU_CACHE_TTL_MS;
  if (stale && !existing.pending) {
    existing.pending = runProbe(host, GPU_PROBE, GPU_TIMEOUT_MS)
      .then((stdout) => {
        existing.metrics = parseGpuMetrics(stdout);
        existing.updatedAt = Date.now();
      })
      .catch(() => {
        existing.updatedAt = Date.now();
      })
      .finally(() => {
        existing.pending = null;
      });
    gpuCache.set(key, existing);
  }
  return existing;
}

export async function readServerSnapshot(host: RemoteHost): Promise<ServerSnapshot> {
  const base = await runProbe(host, LINUX_PROBE, MONITOR_TIMEOUT_MS);
  const gpu = gpuState(host);
  return parseSnapshot(host, base, gpu.metrics, gpu.pending !== null && gpu.metrics === null);
}
