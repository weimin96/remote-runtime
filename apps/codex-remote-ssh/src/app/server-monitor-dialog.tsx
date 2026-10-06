import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, IconButton, ScrollArea } from "@radix-ui/themes";
import {
  BarChartIcon,
  Cross1Icon,
  CubeIcon,
  DesktopIcon,
  LightningBoltIcon,
} from "@radix-ui/react-icons";

import { requestReadOnly, userFacingError } from "./runtime.js";
import type { Host, HostHealthInfo, ServerSnapshot } from "./types.js";

type MonitorState = {
  snapshot: ServerSnapshot | null;
  error: string;
  loading: boolean;
};

type MetricHistory = {
  cpu: number[];
  memory: number[];
  disk: number[];
  gpu: number[];
};

type MetricTone = "green" | "blue" | "orange" | "teal";

const EMPTY_HISTORY: MetricHistory = { cpu: [], memory: [], disk: [], gpu: [] };
const HISTORY_LIMIT = 14;

function percent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next.toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
}

function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}天 ${hours}小时`;
  if (hours) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

function appendPoint(values: number[], value: number | null): number[] {
  if (value === null || !Number.isFinite(value)) return values;
  return [...values, value].slice(-HISTORY_LIMIT);
}

function Sparkline({ values, tone, maxValue }: { values: number[]; tone: MetricTone; maxValue?: number }) {
  const samples = values.length >= 2 ? values : values.length === 1 ? [values[0], values[0]] : [0, 0];
  const max = maxValue ?? Math.max(1, ...samples) * 1.15;
  const min = maxValue ? 0 : Math.min(0, ...samples);
  const span = Math.max(1, max - min);
  const points = samples.map((value, index) => {
    const x = samples.length === 1 ? 42 : (index / (samples.length - 1)) * 84;
    const y = 25 - ((value - min) / span) * 21;
    return `${x.toFixed(1)},${Math.max(2, Math.min(25, y)).toFixed(1)}`;
  }).join(" ");
  return (
    <svg className={`monitor-sparkline tone-${tone}`} viewBox="0 0 84 28" aria-hidden="true">
      <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function MetricCard({ icon, label, value, detail, progress, history, tone }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  progress?: number | null;
  history: number[];
  tone: MetricTone;
}) {
  return (
    <div className={`monitor-resource-card tone-${tone}`}>
      <div className="monitor-resource-topline">
        <span className="monitor-resource-icon">{icon}</span>
        <span className="monitor-resource-label">{label}</span>
        <Sparkline values={history} tone={tone} maxValue={label === "Load" ? undefined : 100} />
      </div>
      <strong className="monitor-resource-value">{value}</strong>
      <span className="monitor-resource-detail" title={detail}>{detail || " "}</span>
      {progress !== undefined && progress !== null && (
        <div className="monitor-resource-progress" aria-hidden="true">
          <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      )}
    </div>
  );
}

function snapshotWarning(snapshot: ServerSnapshot | null, error: string): boolean {
  if (error) return true;
  if (!snapshot) return false;
  if (!snapshot.supported) return true;
  const memory = percent(snapshot.memoryUsedBytes, snapshot.memoryTotalBytes);
  const disk = percent(snapshot.diskUsedBytes, snapshot.diskTotalBytes);
  return (snapshot.cpuPercent ?? 0) >= 95 || (memory ?? 0) >= 90 || (disk ?? 0) >= 90 || (snapshot.gpuPercent ?? 0) >= 95;
}

function HostCard({ host, state, history, health }: { host: Host; state: MonitorState | undefined; history: MetricHistory | undefined; health: HostHealthInfo | undefined }) {
  const snapshot = state?.snapshot ?? null;
  const memoryPercent = percent(snapshot?.memoryUsedBytes ?? null, snapshot?.memoryTotalBytes ?? null);
  const diskPercent = percent(snapshot?.diskUsedBytes ?? null, snapshot?.diskTotalBytes ?? null);
  const status = state?.loading && !snapshot ? "loading" : state?.error ? "error" : snapshot ? "online" : "idle";
  const warning = snapshotWarning(snapshot, state?.error ?? "");
  const gpuDetected = snapshot?.gpuCount !== null && snapshot?.gpuCount !== undefined && snapshot.gpuCount > 0;
  const points = history ?? EMPTY_HISTORY;

  return (
    <section className={`monitor-host-card is-${status}${warning ? " has-warning" : ""}`}>
      <header className="monitor-host-head">
        <div className="monitor-host-copy">
          <div className="monitor-host-title-row">
            <span
              className={`monitor-health-dot is-${health?.status ?? "unknown"}`}
              title={health?.checkedAt ? `${health.status} · ${health.source ?? "unknown"} · ${new Date(health.checkedAt).toLocaleTimeString()}${health.message ? ` · ${health.message}` : ""}` : "暂无最近连接状态"}
            />
            <strong title={host.alias}>{host.alias}</strong>
          </div>
        </div>
      </header>

      {state?.error ? (
        <div className="monitor-host-message error">{state.error}</div>
      ) : snapshot && !snapshot.supported ? (
        <div className="monitor-host-message">{snapshot.platform} 暂不支持资源采集</div>
      ) : snapshot?.supported ? (
        <>
          <div className="monitor-host-meta">
            <DesktopIcon />
            <span>{snapshot.hostname}</span>
            <span>{snapshot.platform}</span>
            <span>uptime {formatUptime(snapshot.uptimeSeconds)}</span>
          </div>
          <div className="monitor-resource-grid">
            <MetricCard icon={<LightningBoltIcon />} label="CPU" value={formatPercent(snapshot.cpuPercent)} progress={snapshot.cpuPercent} history={points.cpu} tone="green" />
            <MetricCard icon={<BarChartIcon />} label="内存" value={formatPercent(memoryPercent)} detail={`${formatBytes(snapshot.memoryUsedBytes)} / ${formatBytes(snapshot.memoryTotalBytes)}`} progress={memoryPercent} history={points.memory} tone="blue" />
            <MetricCard icon={<CubeIcon />} label="磁盘" value={formatPercent(diskPercent)} detail={`${formatBytes(snapshot.diskUsedBytes)} / ${formatBytes(snapshot.diskTotalBytes)}`} progress={diskPercent} history={points.disk} tone="orange" />
            <MetricCard
              icon={<DesktopIcon />}
              label="GPU"
              value={gpuDetected ? formatPercent(snapshot.gpuPercent) : snapshot.gpuPending ? "采集中" : "未检测"}
              detail={gpuDetected ? `${snapshot.gpuCount} GPU · ${formatBytes(snapshot.gpuMemoryUsedBytes)} / ${formatBytes(snapshot.gpuMemoryTotalBytes)}` : snapshot.gpuPending ? "GPU 指标后台采集中，不阻塞基础状态" : "nvidia-smi 不可用或无 NVIDIA GPU"}
              progress={gpuDetected ? snapshot.gpuPercent : null}
              history={points.gpu}
              tone="teal"
            />
          </div>
        </>
      ) : (
        <div className="monitor-host-message">{state?.loading ? "正在读取服务器状态…" : "等待刷新"}</div>
      )}
    </section>
  );
}

export function ServerMonitorDialog({
  hosts,
  open,
  onOpenChange,
}: {
  hosts: Host[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const resolvedHosts = useMemo(() => hosts.filter((host) => host.resolved), [hosts]);
  const [states, setStates] = useState<Record<string, MonitorState>>({});
  const [histories, setHistories] = useState<Record<string, MetricHistory>>({});
  const [health, setHealth] = useState<Record<string, HostHealthInfo>>({});
  const refreshingRef = useRef(false);

  const refreshHealth = useCallback(async () => {
    try {
      const response = await requestReadOnly<{ isError?: boolean; structuredContent?: { health?: HostHealthInfo[] } }>("tools/call", {
        name: "hosts.health",
        arguments: {},
      }, 8_000);
      if (response.isError) return;
      const next: Record<string, HostHealthInfo> = {};
      for (const item of response.structuredContent?.health ?? []) next[item.host] = item;
      setHealth(next);
    } catch {
      // Health is advisory; the live monitor probe remains authoritative.
    }
  }, []);

  const refreshAll = useCallback(async () => {
    if (refreshingRef.current || resolvedHosts.length === 0) return;
    refreshingRef.current = true;
    setStates((current) => {
      const next = { ...current };
      for (const host of resolvedHosts) {
        next[host.id] = { snapshot: current[host.id]?.snapshot ?? null, error: "", loading: true };
      }
      return next;
    });

    await Promise.all(resolvedHosts.map(async (host) => {
      try {
        const response = await requestReadOnly<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { snapshot?: ServerSnapshot } }>("tools/call", {
          name: "monitor.snapshot",
          arguments: { host: host.id },
        }, 15_000);
        if (response.isError) throw new Error(response.content?.[0]?.text ?? "读取服务器状态失败");
        const snapshot = response.structuredContent?.snapshot ?? null;
        setStates((current) => ({ ...current, [host.id]: { snapshot, error: "", loading: false } }));
        if (snapshot?.supported) {
          const memory = percent(snapshot.memoryUsedBytes, snapshot.memoryTotalBytes);
          const disk = percent(snapshot.diskUsedBytes, snapshot.diskTotalBytes);
          setHistories((current) => {
            const existing = current[host.id] ?? EMPTY_HISTORY;
            return {
              ...current,
              [host.id]: {
                cpu: appendPoint(existing.cpu, snapshot.cpuPercent),
                memory: appendPoint(existing.memory, memory),
                disk: appendPoint(existing.disk, disk),
                gpu: appendPoint(existing.gpu, snapshot.gpuPercent),
              },
            };
          });
        }
      } catch (nextError) {
        setStates((current) => ({
          ...current,
          [host.id]: {
            snapshot: current[host.id]?.snapshot ?? null,
            error: userFacingError(nextError, "读取服务器状态失败"),
            loading: false,
          },
        }));
      }
    }));

    await refreshHealth();
    refreshingRef.current = false;
  }, [refreshHealth, resolvedHosts]);

  useEffect(() => {
    if (!open) return;
    void refreshAll();
    const timer = window.setInterval(() => void refreshAll(), 5000);
    return () => window.clearInterval(timer);
  }, [open, refreshAll]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="1180px" className="monitor-dialog">
        <Dialog.Description className="monitor-sr-only">查看全部可连接 SSH 主机的 CPU、内存、磁盘和 GPU 状态。</Dialog.Description>
        <header className="monitor-dialog-head">
          <Dialog.Title>服务器状态</Dialog.Title>
          <Dialog.Close>
            <IconButton size="2" variant="soft" color="gray" className="monitor-close-button" aria-label="关闭服务器状态"><Cross1Icon /></IconButton>
          </Dialog.Close>
        </header>

        <ScrollArea type="auto" scrollbars="vertical" className="monitor-host-scroll">
          {resolvedHosts.length ? (
            <div className="monitor-host-grid">
              {resolvedHosts.map((host) => <HostCard key={host.id} host={host} state={states[host.id]} history={histories[host.id]} health={health[host.alias]} />)}
            </div>
          ) : (
            <div className="monitor-empty">暂无可连接的 SSH 主机</div>
          )}
        </ScrollArea>
      </Dialog.Content>
    </Dialog.Root>
  );
}
