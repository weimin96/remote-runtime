import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const HEARTBEAT_MS = 10_000;
const ACTIVE_SCAN_CACHE_MS = 750;
const STALE_RUNTIME_MS = HEARTBEAT_MS * 4;

export type ActiveCommandPresence = {
  sessionId: string;
  startedAt: number;
};

type RuntimePresenceFile = {
  runtimeId: string;
  pid: number;
  updatedAt: number;
  commands: ActiveCommandPresence[];
};

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export class RuntimePresenceRegistry {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly runtimeId: string;
  private readonly pid: number;
  private commands: ActiveCommandPresence[] = [];
  private queue = Promise.resolve();
  private heartbeat: NodeJS.Timeout;
  private closed = false;
  private lastScanAt = 0;
  private lastActiveCommands: ActiveCommandPresence[] = [];

  constructor(journalPath: string, runtimeId: string, pid = process.pid) {
    this.directory = `${journalPath}.runtimes`;
    this.filePath = path.join(this.directory, `${runtimeId}.json`);
    this.runtimeId = runtimeId;
    this.pid = pid;
    this.heartbeat = setInterval(() => void this.publish(), HEARTBEAT_MS);
    this.heartbeat.unref();
    void this.publish();
  }

  async setCommands(commands: ActiveCommandPresence[]): Promise<void> {
    if (this.closed) return;
    this.commands = commands;
    this.lastScanAt = 0;
    await this.publish();
  }

  async activeCommands(): Promise<ActiveCommandPresence[]> {
    if (Date.now() - this.lastScanAt < ACTIVE_SCAN_CACHE_MS) return this.lastActiveCommands;
    await this.queue;
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => []);
    const states: Array<{ filePath: string; state: RuntimePresenceFile }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(this.directory, entry.name);
      try {
        const state = JSON.parse(await readFile(filePath, "utf8")) as RuntimePresenceFile;
        if (!state.runtimeId || !Number.isSafeInteger(state.pid) || !Array.isArray(state.commands)) throw new Error("invalid runtime presence");
        states.push({ filePath, state });
      } catch {
        await rm(filePath, { force: true }).catch(() => {});
      }
    }

    const now = Date.now();
    const newestFreshByPid = new Map<number, RuntimePresenceFile>();
    for (const { state } of states) {
      if (now - state.updatedAt > STALE_RUNTIME_MS) continue;
      const current = newestFreshByPid.get(state.pid);
      if (!current || state.updatedAt > current.updatedAt) newestFreshByPid.set(state.pid, state);
    }

    const active: ActiveCommandPresence[] = [];
    for (const { filePath, state } of states) {
      const newestFresh = newestFreshByPid.get(state.pid);
      const superseded = now - state.updatedAt > STALE_RUNTIME_MS && newestFresh?.runtimeId !== state.runtimeId;
      if (superseded || !processAlive(state.pid)) {
        await rm(filePath, { force: true }).catch(() => {});
        continue;
      }
      active.push(...state.commands);
    }
    this.lastActiveCommands = active;
    this.lastScanAt = Date.now();
    return active;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.commands = [];
    this.lastActiveCommands = [];
    void this.queue.finally(() => rm(this.filePath, { force: true }).catch(() => {}));
  }

  private publish(): Promise<void> {
    if (this.closed) return this.queue;
    const state: RuntimePresenceFile = {
      runtimeId: this.runtimeId,
      pid: this.pid,
      updatedAt: Date.now(),
      commands: this.commands,
    };
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${this.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    }).catch(() => {
      // Presence is advisory. Command execution must keep working if the cache is unavailable.
    });
    return this.queue;
  }
}
