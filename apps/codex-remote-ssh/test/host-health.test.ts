import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HostHealthRegistry } from "../src/server/host-health.js";
import type { RemoteHost } from "../src/server/host-registry.js";

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

test("shares passive host health across MCP runtimes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-health-"));
  const first = new HostHealthRegistry({ root, runtimeId: "runtime-a" });
  const second = new HostHealthRegistry({ root, runtimeId: "runtime-b" });

  await first.recordSuccess(host, "sftp");
  const healthy = (await second.snapshot([host]))[0];
  assert.equal(healthy.status, "online");
  assert.equal(healthy.source, "sftp");
  assert.ok(healthy.lastSuccessAt);

  await second.recordFailure(host, new Error("ssh: connect to host example.invalid port 22: Operation timed out"), "monitor");
  const failed = (await first.snapshot([host]))[0];
  assert.equal(failed.status, "unreachable");
  assert.equal(failed.source, "monitor");
  assert.match(failed.message ?? "", /Operation timed out/);
  assert.equal(failed.lastSuccessAt, healthy.lastSuccessAt, "latest success should survive a later failure from another runtime");
});

test("classifies non-network SSH failures separately", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-health-error-"));
  const registry = new HostHealthRegistry({ root, runtimeId: "runtime-error" });
  await registry.recordFailure(host, new Error("Permission denied (publickey)."), "sftp");
  const health = (await registry.snapshot([host]))[0];
  assert.equal(health.status, "error");
  assert.equal(health.source, "sftp");
});
