import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod/v4";

const HostIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/, "主机 ID 只能包含字母、数字、点、下划线和短横线");

export const ManagedHostInputSchema = z.object({
  id: HostIdSchema,
  hostname: z.string().trim().min(1).max(255),
  user: z.string().trim().min(1).max(128),
  port: z.number().int().min(1).max(65_535).default(22),
  identityFile: z.string().trim().max(4096).optional(),
  proxyJump: z.string().trim().max(1024).optional(),
  defaultCwd: z.string().trim().max(4096).optional(),
});

export type ManagedHostInput = z.infer<typeof ManagedHostInputSchema>;

type StoredConfig = {
  version: 1;
  hosts: ManagedHostInput[];
};

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function managedHostsPath(): string {
  const override = process.env.REMOTE_SSH_HOSTS_CONFIG;
  if (override) return path.resolve(expandHome(override));
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "remote-agent", "remote-ssh", "hosts.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "remote-agent", "remote-ssh", "hosts.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "remote-agent", "remote-ssh", "hosts.json");
}

export async function readManagedHosts(filePath = managedHostsPath()): Promise<ManagedHostInput[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const result = z.object({ version: z.literal(1), hosts: z.array(ManagedHostInputSchema) }).safeParse(parsed);
    if (!result.success) throw new Error(`配置格式无效: ${result.error.message}`);
    return result.data.hosts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveManagedHost(input: ManagedHostInput, filePath = managedHostsPath()): Promise<ManagedHostInput[]> {
  const host = ManagedHostInputSchema.parse(input);
  if (host.identityFile) {
    const keyPath = path.resolve(expandHome(host.identityFile));
    const keyStat = await stat(keyPath).catch(() => null);
    if (!keyStat?.isFile()) throw new Error(`IdentityFile 不存在或不是文件: ${host.identityFile}`);
  }
  const hosts = await readManagedHosts(filePath);
  const next = hosts.filter((existing) => existing.id !== host.id);
  next.push(host);
  next.sort((left, right) => left.id.localeCompare(right.id));
  await writeConfig({ version: 1, hosts: next }, filePath);
  return next;
}

export async function removeManagedHost(id: string, filePath = managedHostsPath()): Promise<ManagedHostInput[]> {
  HostIdSchema.parse(id);
  const hosts = await readManagedHosts(filePath);
  const next = hosts.filter((host) => host.id !== id);
  await writeConfig({ version: 1, hosts: next }, filePath);
  return next;
}

async function writeConfig(config: StoredConfig, filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

export function resolveManagedIdentityFile(value?: string): string | null {
  if (!value) return null;
  return path.resolve(expandHome(value));
}
