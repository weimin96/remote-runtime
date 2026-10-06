import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TerminalEvent } from "./execution-broker.js";

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const RETAIN_EVENTS = 4_000;
const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 3_000;

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function eventJournalPath(): string {
  const override = process.env.REMOTE_SSH_EVENT_JOURNAL;
  if (override) return path.resolve(expandHome(override));
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "remote-agent", "remote-ssh", "command-events.jsonl");
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "remote-agent", "remote-ssh", "command-events.jsonl");
  }
  const cacheHome = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "remote-agent", "remote-ssh", "command-events.jsonl");
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class SharedEventJournal {
  private readonly filePath: string;
  private readonly counterPath: string;
  private readonly lockPath: string;

  constructor(filePath = eventJournalPath()) {
    this.filePath = filePath;
    this.counterPath = `${filePath}.seq`;
    this.lockPath = `${filePath}.lock`;
  }

  async append(event: Omit<TerminalEvent, "seq" | "at">): Promise<TerminalEvent> {
    return this.withLock(async () => {
      const seq = (await this.readCounter()) + 1;
      const entry: TerminalEvent = { ...event, seq, at: new Date().toISOString() };
      await writeFile(this.counterPath, `${seq}\n`, { encoding: "utf8", mode: 0o600 });
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(this.filePath, 0o600).catch(() => {});
      await this.rotateIfNeeded();
      return entry;
    });
  }

  async read(afterSeq: number, limit: number): Promise<TerminalEvent[]> {
    const text = await readFile(this.filePath, "utf8").catch((error) => {
      if (isEnoent(error)) return "";
      throw error;
    });
    if (!text) return [];
    const events: TerminalEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as TerminalEvent;
        if (Number.isSafeInteger(event.seq) && event.seq > afterSeq) events.push(event);
      } catch {
        // Ignore a partial trailing line if another process is appending right now.
      }
    }
    events.sort((left, right) => left.seq - right.seq);
    return events.slice(0, limit);
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      await writeFile(this.filePath, "", { encoding: "utf8", mode: 0o600 });
      await chmod(this.filePath, 0o600).catch(() => {});
    });
  }

  private async readCounter(): Promise<number> {
    const raw = await readFile(this.counterPath, "utf8").catch((error) => {
      if (isEnoent(error)) return "0";
      throw error;
    });
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private async rotateIfNeeded(): Promise<void> {
    const info = await stat(this.filePath).catch(() => null);
    if (!info || info.size <= MAX_JOURNAL_BYTES) return;
    const text = await readFile(this.filePath, "utf8");
    const lines = text.split("\n").filter(Boolean).slice(-RETAIN_EVENTS);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => {});
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        const info = await stat(this.lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(this.lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Remote SSH 事件日志锁等待超时");
        await sleep(4 + Math.floor(Math.random() * 8));
      }
    }
    try {
      return await work();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}
