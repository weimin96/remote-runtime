import crypto from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RemoteHost } from "./host-registry.js";
import { connectionFailureMessage } from "./ssh-performance.js";

const HEALTH_STALE_MS = 5 * 60 * 1000;
const HEALTH_FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 600;

export type HostHealthStatus = "unknown" | "online" | "unreachable" | "error";

export type HostHealthInfo = {
  host: string;
  status: HostHealthStatus;
  source: string | null;
  message: string | null;
  checkedAt: string | null;
  lastSuccessAt: string | null;
  stale: boolean;
};

type StoredHostHealth = Omit<HostHealthInfo, "stale">;

type RuntimeHealthFile = {
  runtimeId: string;
  pid: number;
  updatedAt: string;
  hosts: StoredHostHealth[];
};

function healthRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "remote-agent", "remote-ssh", "host-health");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "remote-agent", "remote-ssh", "host-health");
  }
  const cacheHome = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "remote-agent", "remote-ssh", "host-health");
}

function safeRuntimeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || crypto.randomUUID();
}

function cleanMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error ?? "");
  return value.trim().slice(-MAX_MESSAGE_CHARS);
}

export class HostHealthRegistry {
  private readonly runtimeId: string;
  private readonly root: string;
  private readonly filePath: string;
  private readonly records = new Map<string, StoredHostHealth>();
  private writeQueue = Promise.resolve();
  private pendingPersist: Promise<void> | null = null;

  constructor(options: { runtimeId?: string; root?: string } = {}) {
    this.runtimeId = options.runtimeId ?? crypto.randomUUID();
    this.root = options.root ?? healthRoot();
    this.filePath = path.join(this.root, `${safeRuntimeId(this.runtimeId)}.json`);
  }

  async recordSuccess(host: RemoteHost, source: string): Promise<void> {
    const now = new Date().toISOString();
    this.records.set(host.alias, {
      host: host.alias,
      status: "online",
      source,
      message: null,
      checkedAt: now,
      lastSuccessAt: now,
    });
    await this.persist();
  }

  async recordFailure(host: RemoteHost, error: unknown, source: string): Promise<void> {
    const now = new Date().toISOString();
    const message = cleanMessage(error);
    const previous = this.records.get(host.alias);
    this.records.set(host.alias, {
      host: host.alias,
      status: connectionFailureMessage(message) ? "unreachable" : "error",
      source,
      message: message || null,
      checkedAt: now,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
    });
    await this.persist();
  }

  async snapshot(hosts: RemoteHost[]): Promise<HostHealthInfo[]> {
    await this.writeQueue;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const merged = new Map<string, StoredHostHealth>();
    const latestSuccess = new Map<string, string>();
    const mergeRecord = (record: StoredHostHealth) => {
      const current = merged.get(record.host);
      if (!current || String(record.checkedAt ?? "").localeCompare(String(current.checkedAt ?? "")) > 0) {
        merged.set(record.host, record);
      }
      if (record.lastSuccessAt) {
        const existing = latestSuccess.get(record.host);
        if (!existing || record.lastSuccessAt.localeCompare(existing) > 0) latestSuccess.set(record.host, record.lastSuccessAt);
      }
    };
    const files = await readdir(this.root).catch(() => [] as string[]);
    await Promise.all(files.filter((name) => name.endsWith(".json")).map(async (name) => {
      const filePath = path.join(this.root, name);
      const info = await stat(filePath).catch(() => null);
      if (!info) return;
      if (now - info.mtimeMs > HEALTH_FILE_RETENTION_MS) {
        await rm(filePath, { force: true }).catch(() => {});
        return;
      }
      try {
        const parsed = JSON.parse(await readFile(filePath, "utf8")) as RuntimeHealthFile;
        for (const record of parsed.hosts ?? []) mergeRecord(record);
      } catch {
        // Ignore partial or stale cache files. Health is advisory only.
      }
    }));

    for (const record of this.records.values()) mergeRecord(record);

    return hosts.map((host) => {
      const record = merged.get(host.alias);
      if (!record) {
        return { host: host.alias, status: "unknown", source: null, message: null, checkedAt: null, lastSuccessAt: null, stale: true };
      }
      const checkedAtMs = record.checkedAt ? new Date(record.checkedAt).getTime() : Number.NaN;
      const stale = !Number.isFinite(checkedAtMs) || now - checkedAtMs > HEALTH_STALE_MS;
      return { ...record, status: stale ? "unknown" : record.status, lastSuccessAt: latestSuccess.get(host.alias) ?? record.lastSuccessAt, stale };
    });
  }

  private async persist(): Promise<void> {
    if (this.pendingPersist) return this.pendingPersist;
    const work = async () => {
      await new Promise((resolve) => setTimeout(resolve, 8));
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const payload: RuntimeHealthFile = {
        runtimeId: this.runtimeId,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        hosts: [...this.records.values()],
      };
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    };
    const queued = this.writeQueue.then(work, work);
    this.writeQueue = queued.catch(() => {});
    const pending = queued.finally(() => {
      if (this.pendingPersist === pending) this.pendingPersist = null;
    });
    this.pendingPersist = pending;
    return pending;
  }
}
