import { readManagedHosts, resolveManagedIdentityFile, type ManagedHostInput } from "./managed-hosts.js";
import { discoverSshHosts, type SshHost } from "./ssh-config.js";

export type RemoteHost = SshHost & {
  source: "ssh-config" | "managed";
  identityFile: string | null;
  defaultCwd: string | null;
};

function managedHostToRemote(host: ManagedHostInput): RemoteHost {
  const identityFile = resolveManagedIdentityFile(host.identityFile);
  return {
    id: host.id,
    alias: host.id,
    hostname: host.hostname,
    user: host.user,
    port: host.port,
    identityFiles: identityFile ? [identityFile] : [],
    proxyJump: host.proxyJump || null,
    resolved: true,
    source: "managed",
    identityFile,
    defaultCwd: host.defaultCwd || null,
  };
}

export async function discoverRemoteHosts(): Promise<RemoteHost[]> {
  const [sshHosts, managedHosts] = await Promise.all([discoverSshHosts(), readManagedHosts()]);
  const merged = new Map<string, RemoteHost>();
  for (const host of sshHosts) {
    merged.set(host.id, {
      ...host,
      source: "ssh-config",
      identityFile: host.identityFiles[0] ?? null,
      defaultCwd: null,
    });
  }
  // Explicit plugin-managed hosts intentionally override an imported alias with the same id.
  for (const host of managedHosts) merged.set(host.id, managedHostToRemote(host));
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function publicHost(host: RemoteHost) {
  return {
    id: host.id,
    alias: host.alias,
    hostname: host.hostname,
    user: host.user,
    port: host.port,
    proxyJump: host.proxyJump,
    resolved: host.resolved,
    error: host.error,
    source: host.source,
    identityConfigured: host.identityFiles.length > 0,
    defaultCwd: host.defaultCwd,
  };
}
