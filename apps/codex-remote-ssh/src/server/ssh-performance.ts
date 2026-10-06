import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { RemoteHost } from "./host-registry.js";

const CONTROL_PERSIST_SECONDS = 300;
export const CONNECTION_FAILURE_TTL_MS = 15_000;

let controlRootReady = false;

function controlRoot(): string | null {
  if (process.platform === "win32") return null;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join("/tmp", `codex-rssh-${uid}`);
}

export function sshMultiplexingArgs(): string[] {
  const root = controlRoot();
  if (!root) return [];
  if (!controlRootReady) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    controlRootReady = true;
  }
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
    "-o", `ControlPath=${path.join(root, "%C")}`,
  ];
}

export function inferExecYieldTimeMs(command: string): number {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return 2_500;
  if (/\b(tail\s+-f|journalctl\s+.*-f|docker\s+logs\s+.*-f|npm\s+run\s+(dev|start)|pnpm\s+(dev|start)|yarn\s+(dev|start)|uvicorn\b|gunicorn\b|vite\b|webpack\s+serve\b|python\s+-m\s+http\.server\b)\b/.test(normalized)) return 400;
  if (/\b(docker\s+(build|compose\s+(build|up|pull))|npm\s+(install|ci|test)|pnpm\s+(install|test)|yarn\s+(install|test)|pip\s+install|apt(-get)?\s+|yum\s+|dnf\s+|cargo\s+(build|test)|mvn\s+|gradle\b|pytest\b|make\b|cmake\b|git\s+(clone|fetch|pull)|curl\b.*\s-o\s|wget\b)\b/.test(normalized)) return 1_200;
  return 2_500;
}

export function connectionFailureMessage(stderr: string): string | null {
  const text = stderr.trim();
  if (!text) return null;
  const patterns = [
    /connection timed out/i,
    /operation timed out/i,
    /connection refused/i,
    /no route to host/i,
    /network is unreachable/i,
    /could not resolve hostname/i,
    /connection closed by .* port \d+/i,
  ];
  return patterns.some((pattern) => pattern.test(text)) ? text.slice(-800) : null;
}

export function sshTransportFailureMessage(stderr: string): string | null {
  const text = stderr.trim();
  if (!text) return null;
  if (connectionFailureMessage(text)) return text.slice(-800);
  const patterns = [
    /permission denied/i,
    /host key verification failed/i,
    /remote host identification has changed/i,
    /too many authentication failures/i,
    /no supported authentication methods available/i,
    /connection closed by authenticating user/i,
    /kex_exchange_identification/i,
  ];
  return patterns.some((pattern) => pattern.test(text)) ? text.slice(-800) : null;
}

export function connectionCacheKey(host: RemoteHost): string {
  return `${host.source}:${host.user}@${host.hostname}:${host.port}:${host.alias}`;
}
