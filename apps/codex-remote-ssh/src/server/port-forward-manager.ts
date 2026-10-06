import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";

import type { RemoteHost } from "./host-registry.js";
import { sshConfigPath } from "./ssh-config.js";

const MAX_FORWARD_SESSIONS = 8;
const MAX_ERROR_CHARS = 16_000;
const FORWARD_READY_TIMEOUT_MS = 12_000;

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

type PortForwardSession = {
  info: PortForwardInfo;
  process: ChildProcessWithoutNullStreams;
  stderr: string;
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

function forwardTarget(host: RemoteHost): string {
  return host.source === "managed" ? `${host.user}@${host.hostname}` : host.alias;
}

function forwardArgs(host: RemoteHost, localPort: number, remoteHost: string, remotePort: number): string[] {
  const args = [
    "-N",
    "-T",
    "-F", sshConfigPath(),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", "ExitOnForwardFailure=yes",
    "-L", `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
  ];
  if (host.source === "managed") {
    args.push("-p", String(host.port));
    if (host.identityFile) args.push("-i", host.identityFile, "-o", "IdentitiesOnly=yes");
    if (host.proxyJump) args.push("-J", host.proxyJump);
  }
  args.push("--", forwardTarget(host));
  return args;
}

async function assertLocalPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => reject(new Error(`本地端口 127.0.0.1:${port} 不可用：${error.message}`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

async function randomAvailableLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地空闲端口"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForLocalListener(port: number, process: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + FORWARD_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.killed) throw new Error("SSH 端口转发进程提前退出");
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(120, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`SSH 端口转发在 ${FORWARD_READY_TIMEOUT_MS}ms 内未就绪`);
}

export class PortForwardManager {
  private readonly sessions = new Map<string, PortForwardSession>();

  list(): PortForwardInfo[] {
    return [...this.sessions.values()]
      .map((session) => ({ ...session.info }))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async open(host: RemoteHost, localPort: number, remoteHost: string, remotePort: number): Promise<PortForwardInfo> {
    const active = [...this.sessions.values()].filter((session) => session.info.status !== "error");
    if (active.length >= MAX_FORWARD_SESSIONS) throw new Error(`本地端口转发最多同时保留 ${MAX_FORWARD_SESSIONS} 个`);
    let selectedLocalPort = localPort;
    if (selectedLocalPort === 0) {
      const preferred = remotePort;
      const alreadyUsed = active.some((session) => session.info.localPort === preferred);
      if (!alreadyUsed) {
        try {
          await assertLocalPortAvailable(preferred);
          selectedLocalPort = preferred;
        } catch {
          selectedLocalPort = await randomAvailableLocalPort();
        }
      } else {
        selectedLocalPort = await randomAvailableLocalPort();
      }
    }
    if (active.some((session) => session.info.localPort === selectedLocalPort)) {
      throw new Error(`本地端口 127.0.0.1:${selectedLocalPort} 已被 Remote SSH 转发占用`);
    }
    await assertLocalPortAvailable(selectedLocalPort);

    const id = crypto.randomBytes(18).toString("base64url");
    const info: PortForwardInfo = {
      id,
      host: host.alias,
      localHost: "127.0.0.1",
      localPort: selectedLocalPort,
      remoteHost,
      remotePort,
      status: "starting",
      startedAt: new Date().toISOString(),
      error: null,
    };
    const child = spawn("ssh", forwardArgs(host, selectedLocalPort, remoteHost, remotePort), {
      env: safeLocalEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    const session: PortForwardSession = { info, process: child, stderr: "" };
    this.sessions.set(id, session);
    child.stderr.on("data", (chunk: string) => {
      session.stderr = `${session.stderr}${chunk}`.slice(-MAX_ERROR_CHARS);
    });
    child.on("error", (error) => {
      session.info.status = "error";
      session.info.error = error.message;
    });
    child.on("close", (code) => {
      if (!this.sessions.has(id)) return;
      session.info.status = "error";
      session.info.error = session.stderr.trim() || `SSH 端口转发已结束（exit ${code ?? "?"}）`;
    });

    try {
      await waitForLocalListener(selectedLocalPort, child);
      if (session.info.status === "error") throw new Error(session.info.error ?? "SSH 端口转发启动失败");
      session.info.status = "running";
      return { ...session.info };
    } catch (error) {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      session.info.status = "error";
      session.info.error = session.stderr.trim() || (error instanceof Error ? error.message : String(error));
      throw new Error(session.info.error);
    }
  }

  async close(id: string): Promise<{ ok: true }> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("端口转发 id 不存在或已释放");
    this.sessions.delete(id);
    if (session.process.exitCode === null && !session.process.killed) {
      session.process.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => session.process.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
      if (session.process.exitCode === null) session.process.kill("SIGKILL");
    }
    return { ok: true };
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
