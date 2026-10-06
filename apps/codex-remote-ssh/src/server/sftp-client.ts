import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RemoteHost } from "./host-registry.js";
import { sshConfigPath } from "./ssh-config.js";
import { sshMultiplexingArgs } from "./ssh-performance.js";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const TRANSFER_ROOT = path.join(os.tmpdir(), "remote-ssh-sftp-transfer");
const MAX_CHUNK_BYTES = 768 * 1024;
const STALE_TRANSFER_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_SESSION_RETENTION_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_TRANSFER_ERROR_CHARS = 16_000;

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

type UploadSession = {
  path: string;
  createdAt: number;
};

type DownloadSession = {
  info: SftpDownloadStatus;
  process: ChildProcessWithoutNullStreams;
  tempPath: string;
  stderr: string;
  timeout: NodeJS.Timeout;
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

function sftpArgs(host: RemoteHost): string[] {
  const args = [
    "-q",
    "-b", "-",
    "-F", sshConfigPath(),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    ...sshMultiplexingArgs(),
  ];
  if (host.source === "managed") {
    args.push("-P", String(host.port));
    if (host.identityFile) args.push("-i", host.identityFile, "-o", "IdentitiesOnly=yes");
    if (host.proxyJump) args.push("-J", host.proxyJump);
    args.push("--", `${host.user}@${host.hostname}`);
  } else {
    args.push("--", host.alias);
  }
  return args;
}

function quoteBatchArg(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("SFTP 路径不能包含换行或 NUL 字符");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function ensureTransferRoot(): Promise<void> {
  await mkdir(TRANSFER_ROOT, { recursive: true, mode: 0o700 });
}

async function cleanupStaleTransferFiles(): Promise<void> {
  await ensureTransferRoot();
  const now = Date.now();
  const entries = await readdir(TRANSFER_ROOT, { withFileTypes: true }).catch(() => []);
  await Promise.allSettled(entries.map(async (entry) => {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]{20,80}$/.test(entry.name)) return;
    const candidate = path.join(TRANSFER_ROOT, entry.name);
    const info = await stat(candidate).catch(() => null);
    if (!info || now - info.mtimeMs < STALE_TRANSFER_MS) return;
    await rm(candidate, { force: true });
  }));
}

function transferPath(id: string): string {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(id)) throw new Error("无效的 SFTP transfer id");
  return path.join(TRANSFER_ROOT, id);
}

function newTransferId(): string {
  return crypto.randomBytes(24).toString("base64url");
}

async function uniqueDownloadPath(fileName: string): Promise<string> {
  const downloads = path.join(os.homedir(), "Downloads");
  await mkdir(downloads, { recursive: true });
  const safeName = (path.basename(fileName).replace(/[\u0000-\u001f]/g, "_") || "download");
  const extension = path.extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = path.join(downloads, index === 0 ? safeName : `${stem} (${index})${extension}`);
    try {
      await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error("Downloads 目录中同名文件过多");
}

async function cleanupStaleDownloadParts(): Promise<void> {
  const downloads = path.join(os.homedir(), "Downloads");
  await mkdir(downloads, { recursive: true });
  const now = Date.now();
  const entries = await readdir(downloads, { withFileTypes: true }).catch(() => []);
  await Promise.allSettled(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.includes(".remote-ssh-") || !entry.name.endsWith(".part")) return;
    const candidate = path.join(downloads, entry.name);
    const info = await stat(candidate).catch(() => null);
    if (!info || now - info.mtimeMs < STALE_TRANSFER_MS) return;
    await rm(candidate, { force: true });
  }));
}

function temporaryDownloadPath(finalPath: string): string {
  return path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.remote-ssh-${crypto.randomBytes(8).toString("hex")}.part`,
  );
}

async function runBatch(host: RemoteHost, commands: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  const child = spawn("sftp", sftpArgs(host), {
    env: safeLocalEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(`${commands.join("\n")}\nquit\n`);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error(`SFTP 操作超过 ${timeoutMs}ms`);
  if (code !== 0) throw new Error((stderr || stdout || `sftp exit ${code}`).trim());
  return { stdout, stderr };
}

function parseListLine(line: string, directory: string): SftpEntry | null {
  const match = line.match(/^([bcdlps-])([rwxStTs-]{9})\s+\S+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d{1,2})\s+(\d{2}:\d{2}|\d{4})\s+(.+)$/);
  if (!match) return null;
  const [, kind, mode, owner, group, sizeText, month, day, clockOrYear, rawName] = match;
  if (rawName === "." || rawName === "..") return null;
  const arrow = rawName.indexOf(" -> ");
  const name = arrow >= 0 ? rawName.slice(0, arrow) : rawName;
  const linkTarget = arrow >= 0 ? rawName.slice(arrow + 4) : null;
  const type = kind === "d" ? "directory" : kind === "-" ? "file" : kind === "l" ? "symlink" : "other";
  return {
    name,
    path: path.posix.join(directory === "/" ? "/" : directory, name),
    type,
    size: Number(sizeText),
    permissions: `${kind}${mode}`,
    owner,
    group,
    modified: `${month} ${day} ${clockOrYear}`,
    linkTarget,
  };
}

function parseDirectoryOutput(stdout: string): { cwd: string; entries: SftpEntry[] } {
  const lines = stdout.split(/\r?\n/);
  const pwdLine = lines.find((line) => line.startsWith("Remote working directory: "));
  if (!pwdLine) throw new Error("SFTP 未返回远端工作目录");
  const cwd = pwdLine.slice("Remote working directory: ".length).trim() || "/";
  const entries = lines
    .map((line) => parseListLine(line, cwd))
    .filter((entry): entry is SftpEntry => Boolean(entry))
    .sort((left, right) => {
      const rank = (entry: SftpEntry) => entry.type === "directory" ? 0 : entry.type === "symlink" ? 1 : 2;
      return rank(left) - rank(right) || left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
  return { cwd, entries };
}

export class SftpClient {
  private readonly uploads = new Map<string, UploadSession>();
  private readonly downloads = new Map<string, DownloadSession>();
  private cleanupStarted = false;

  private async ensureTransferStorage(): Promise<void> {
    await ensureTransferRoot();
    if (this.cleanupStarted) return;
    this.cleanupStarted = true;
    await Promise.allSettled([cleanupStaleTransferFiles(), cleanupStaleDownloadParts()]);
  }

  async listDirectory(host: RemoteHost, remotePath?: string | null): Promise<SftpDirectory> {
    const target = remotePath?.trim() || host.defaultCwd || ".";
    const { stdout } = await runBatch(host, [
      `cd ${quoteBatchArg(target)}`,
      "pwd",
      "ls -lan",
    ]);
    const { cwd, entries } = parseDirectoryOutput(stdout);
    return { host: host.alias, path: cwd, entries };
  }

  async readText(host: RemoteHost, remotePath: string, maxBytes = 512 * 1024): Promise<{ host: string; path: string; text: string; size: number; truncated: boolean }> {
    const boundedMax = Math.max(1, Math.min(maxBytes, MAX_PREVIEW_BYTES));
    const { stdout: statOutput } = await runBatch(host, [`ls -lan ${quoteBatchArg(remotePath)}`]);
    const parent = path.posix.dirname(remotePath) || "/";
    const listed = statOutput
      .split(/\r?\n/)
      .map((line) => parseListLine(line, parent))
      .find((entry): entry is SftpEntry => entry !== null && entry.name === path.posix.basename(remotePath));
    if (listed && listed.size > MAX_PREVIEW_BYTES) {
      throw new Error(`文件大小 ${listed.size} bytes，超过 ${MAX_PREVIEW_BYTES} bytes 的文本预览上限`);
    }
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-sftp-"));
    const localPath = path.join(tempDir, "preview");
    try {
      await runBatch(host, [`get ${quoteBatchArg(remotePath)} ${quoteBatchArg(localPath)}`], 30_000);
      const info = await stat(localPath);
      if (info.size > MAX_PREVIEW_BYTES) {
        throw new Error(`文件大小 ${info.size} bytes，超过 ${MAX_PREVIEW_BYTES} bytes 的文本预览上限`);
      }
      const buffer = await readFile(localPath);
      const slice = buffer.subarray(0, boundedMax);
      if (slice.includes(0)) throw new Error("该文件看起来是二进制文件，暂不支持文本预览");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
      } catch {
        throw new Error("该文件不是有效 UTF-8 文本，暂不支持预览");
      }
      return {
        host: host.alias,
        path: remotePath,
        text,
        size: info.size,
        truncated: info.size > slice.length,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async writeText(host: RemoteHost, remotePath: string, text: string): Promise<{ host: string; path: string; size: number }> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-sftp-edit-"));
    const localPath = path.join(tempDir, "edited-text");
    try {
      await writeFile(localPath, text, { encoding: "utf8", mode: 0o600 });
      await runBatch(host, [`put ${quoteBatchArg(localPath)} ${quoteBatchArg(remotePath)}`], 60_000);
      return { host: host.alias, path: remotePath, size: Buffer.byteLength(text) };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async mkdir(host: RemoteHost, remotePath: string): Promise<{ host: string; path: string }> {
    await runBatch(host, [`mkdir ${quoteBatchArg(remotePath)}`]);
    return { host: host.alias, path: remotePath };
  }

  async rename(host: RemoteHost, from: string, to: string): Promise<{ host: string; from: string; to: string }> {
    await runBatch(host, [`rename ${quoteBatchArg(from)} ${quoteBatchArg(to)}`]);
    return { host: host.alias, from, to };
  }

  async remove(host: RemoteHost, remotePath: string, type: "file" | "symlink" | "directory"): Promise<{ host: string; path: string }> {
    const command = type === "directory" ? "rmdir" : "rm";
    await runBatch(host, [`${command} ${quoteBatchArg(remotePath)}`]);
    return { host: host.alias, path: remotePath };
  }

  async beginUpload(): Promise<{ uploadId: string; received: number; createdAt: string }> {
    await this.ensureTransferStorage();
    const uploadId = `up_${newTransferId()}`;
    const localPath = transferPath(uploadId);
    const createdAt = Date.now();
    await writeFile(localPath, Buffer.alloc(0), { mode: 0o600 });
    this.uploads.set(uploadId, { path: localPath, createdAt });
    return { uploadId, received: 0, createdAt: new Date(createdAt).toISOString() };
  }

  async appendUploadChunk(uploadId: string, dataBase64: string): Promise<{ uploadId: string; received: number }> {
    const session = this.uploads.get(uploadId);
    if (!session) throw new Error("上传会话不存在或已随 Remote SSH runtime 结束，请重新上传");
    const data = Buffer.from(dataBase64, "base64");
    if (data.length > MAX_CHUNK_BYTES) throw new Error(`单个上传分块不能超过 ${MAX_CHUNK_BYTES} bytes`);
    await appendFile(session.path, data);
    const info = await stat(session.path);
    return { uploadId, received: info.size };
  }

  async commitUpload(host: RemoteHost, uploadId: string, remotePath: string): Promise<{ host: string; path: string; size: number }> {
    const session = this.uploads.get(uploadId);
    if (!session) throw new Error("上传会话不存在或已随 Remote SSH runtime 结束，请重新上传");
    const info = await stat(session.path);
    try {
      await runBatch(host, [`put ${quoteBatchArg(session.path)} ${quoteBatchArg(remotePath)}`], 10 * 60_000);
      return { host: host.alias, path: remotePath, size: info.size };
    } finally {
      this.uploads.delete(uploadId);
      await rm(session.path, { force: true });
    }
  }

  async abortUpload(uploadId: string): Promise<{ ok: true }> {
    const session = this.uploads.get(uploadId);
    this.uploads.delete(uploadId);
    await rm(session?.path ?? transferPath(uploadId), { force: true });
    return { ok: true };
  }

  async beginDownload(host: RemoteHost, remotePath: string, expectedSize?: number | null): Promise<SftpDownloadStatus> {
    await this.ensureTransferStorage();
    const localPath = await uniqueDownloadPath(path.posix.basename(remotePath));
    const tempPath = temporaryDownloadPath(localPath);
    const downloadId = `down_${newTransferId()}`;
    const child = spawn("sftp", sftpArgs(host), {
      env: safeLocalEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    const info: SftpDownloadStatus = {
      downloadId,
      host: host.alias,
      path: remotePath,
      localPath,
      status: "running",
      received: 0,
      total: Number.isFinite(expectedSize) && Number(expectedSize) >= 0 ? Number(expectedSize) : null,
      startedAt: new Date().toISOString(),
      error: null,
    };
    const timeout = setTimeout(() => {
      if (info.status !== "running") return;
      info.error = "SFTP 下载超过 6 小时，传输已终止";
      child.kill("SIGTERM");
    }, DOWNLOAD_TIMEOUT_MS);
    timeout.unref();
    const session: DownloadSession = { info, process: child, tempPath, stderr: "", timeout };
    this.downloads.set(downloadId, session);
    child.stderr.on("data", (chunk: string) => {
      session.stderr = `${session.stderr}${chunk}`.slice(-MAX_TRANSFER_ERROR_CHARS);
    });
    child.once("error", (error) => {
      void this.finishDownload(session, null, error.message);
    });
    child.once("close", (code) => {
      void this.finishDownload(session, code);
    });
    child.stdin.end(`get ${quoteBatchArg(remotePath)} ${quoteBatchArg(tempPath)}\nquit\n`);
    return { ...info };
  }

  async downloadStatus(downloadId: string): Promise<SftpDownloadStatus> {
    const session = this.downloads.get(downloadId);
    if (!session) throw new Error("下载会话不存在或已随 Remote SSH runtime 结束，请重新下载");
    if (session.info.status === "running") {
      const info = await stat(session.tempPath).catch(() => null);
      if (info) session.info.received = info.size;
    }
    return { ...session.info };
  }

  async cancelDownload(downloadId: string): Promise<SftpDownloadStatus> {
    const session = this.downloads.get(downloadId);
    if (!session) throw new Error("下载会话不存在或已结束");
    if (session.info.status === "running") {
      session.info.status = "cancelled";
      session.info.error = null;
      clearTimeout(session.timeout);
      if (session.process.exitCode === null && !session.process.killed) session.process.kill("SIGTERM");
      await rm(session.tempPath, { force: true });
      this.scheduleDownloadCleanup(downloadId);
    }
    return { ...session.info };
  }

  async downloadToDownloads(host: RemoteHost, remotePath: string): Promise<{ host: string; path: string; localPath: string; size: number }> {
    await this.ensureTransferStorage();
    const localPath = await uniqueDownloadPath(path.posix.basename(remotePath));
    const tempPath = temporaryDownloadPath(localPath);
    try {
      await runBatch(host, [`get ${quoteBatchArg(remotePath)} ${quoteBatchArg(tempPath)}`], 6 * 60 * 60_000);
      await rename(tempPath, localPath);
      const info = await stat(localPath);
      return { host: host.alias, path: remotePath, localPath, size: info.size };
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  async close(): Promise<void> {
    const uploads = [...this.uploads.values()];
    this.uploads.clear();
    await Promise.allSettled(uploads.map((session) => rm(session.path, { force: true })));
    const downloads = [...this.downloads.values()];
    for (const session of downloads) {
      clearTimeout(session.timeout);
      if (session.info.status === "running" && session.process.exitCode === null && !session.process.killed) {
        session.info.status = "cancelled";
        session.process.kill("SIGTERM");
      }
    }
    await Promise.allSettled(downloads.map((session) => rm(session.tempPath, { force: true })));
    this.downloads.clear();
  }

  private async finishDownload(session: DownloadSession, code: number | null, spawnError?: string): Promise<void> {
    if (session.info.status !== "running") return;
    clearTimeout(session.timeout);
    const current = await stat(session.tempPath).catch(() => null);
    if (current) session.info.received = current.size;
    if (!spawnError && code === 0) {
      try {
        await rename(session.tempPath, session.info.localPath);
        const finalInfo = await stat(session.info.localPath);
        session.info.received = finalInfo.size;
        if (session.info.total === null) session.info.total = finalInfo.size;
        session.info.status = "completed";
        session.info.error = null;
      } catch (error) {
        session.info.status = "error";
        session.info.error = error instanceof Error ? error.message : String(error);
        await rm(session.tempPath, { force: true });
      }
    } else {
      session.info.status = "error";
      session.info.error = session.info.error ?? spawnError ?? (session.stderr.trim() || `sftp exit ${code ?? "?"}`);
      await rm(session.tempPath, { force: true });
    }
    this.scheduleDownloadCleanup(session.info.downloadId);
  }

  private scheduleDownloadCleanup(downloadId: string): void {
    const timer = setTimeout(() => this.downloads.delete(downloadId), DOWNLOAD_SESSION_RETENTION_MS);
    timer.unref();
  }
}
