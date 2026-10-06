import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RemoteHost } from "../src/server/host-registry.js";
import { PortForwardManager } from "../src/server/port-forward-manager.js";

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("未获得本地端口"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

test("opens, lists and closes a loopback SSH local forward", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-forward-"));
  const fakeSsh = path.join(root, "ssh");
  const argsLog = path.join(root, "args.log");
  await writeFile(
    fakeSsh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
fs.writeFileSync(${JSON.stringify(argsLog)}, process.argv.slice(2).join("\\n"));
const spec = process.argv[process.argv.indexOf("-L") + 1];
const port = Number(spec.split(":")[1]);
const server = net.createServer((socket) => socket.end());
server.listen(port, "127.0.0.1");
const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
`,
  );
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
  const manager = new PortForwardManager();
  try {
    const localPort = await freePort();
    const opened = await manager.open(host, localPort, "127.0.0.1", 8080);
    assert.equal(opened.status, "running");
    assert.equal(opened.localHost, "127.0.0.1");
    assert.equal(manager.list().length, 1);
    const args = await import("node:fs/promises").then(({ readFile }) => readFile(argsLog, "utf8"));
    assert.match(args, /ExitOnForwardFailure=yes/);
    assert.match(args, new RegExp(`127\\.0\\.0\\.1:${localPort}:127\\.0\\.0\\.1:8080`));
    await manager.close(opened.id);
    assert.deepEqual(manager.list(), []);

    const auto = await manager.open(host, 0, "127.0.0.1", localPort);
    assert.equal(auto.status, "running");
    assert.equal(auto.localPort, localPort);
    await manager.close(auto.id);
  } finally {
    await manager.closeAll();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});

test("rejects a local forward when the loopback port is already occupied", async () => {
  const localPort = await freePort();
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => blocker.listen(localPort, "127.0.0.1", () => resolve()).once("error", reject));
  const manager = new PortForwardManager();
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
    await assert.rejects(() => manager.open(host, localPort, "127.0.0.1", 8080), /本地端口 .* 不可用/);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await manager.closeAll();
  }
});
