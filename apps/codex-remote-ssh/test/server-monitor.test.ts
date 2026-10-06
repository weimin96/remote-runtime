import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RemoteHost } from "../src/server/host-registry.js";
import { readServerSnapshot } from "../src/server/server-monitor.js";

test("parses a fixed Linux server snapshot through system ssh", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-monitor-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(fakeSsh, `#!/bin/sh
cat <<'OUT'
platform=Linux
hostname=build-01
supported=true
cpu_percent=27.5
memory_total_kb=1000
memory_available_kb=400
uptime_seconds=7200
load1=0.25
load5=0.50
load15=0.75
disk_total_kb=2000
disk_used_kb=500
gpu_count=2
gpu_percent=42.5
gpu_memory_used_mb=2048
gpu_memory_total_mb=49152
OUT
`);
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  const host: RemoteHost = {
    id: "example",
    alias: "example",
    hostname: "example.invalid",
    user: "deploy",
    port: 22,
    identityFiles: [],
    proxyJump: null,
    resolved: true,
    source: "ssh-config",
    identityFile: null,
    defaultCwd: null,
  };
  try {
    const initial = await readServerSnapshot(host);
    assert.equal(initial.gpuPending, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snapshot = await readServerSnapshot(host);
    assert.equal(snapshot.hostname, "build-01");
    assert.equal(snapshot.supported, true);
    assert.equal(snapshot.cpuPercent, 27.5);
    assert.equal(snapshot.memoryTotalBytes, 1000 * 1024);
    assert.equal(snapshot.memoryUsedBytes, 600 * 1024);
    assert.equal(snapshot.diskUsedBytes, 500 * 1024);
    assert.equal(snapshot.uptimeSeconds, 7200);
    assert.equal(snapshot.load15, 0.75);
    assert.equal(snapshot.gpuCount, 2);
    assert.equal(snapshot.gpuPercent, 42.5);
    assert.equal(snapshot.gpuMemoryUsedBytes, 2048 * 1024 * 1024);
    assert.equal(snapshot.gpuMemoryTotalBytes, 49152 * 1024 * 1024);
    assert.equal(snapshot.gpuPending, false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});
