import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverSshHosts } from "../src/server/ssh-config.js";

test("discovers concrete Host aliases and included config files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-config-"));
  const configDir = path.join(root, "conf.d");
  await mkdir(configDir);
  const config = path.join(root, "config");
  await writeFile(
    config,
    [
      `Include ${configDir}/*.conf`,
      "Host gateway",
      "  HostName 203.0.113.10",
      "  User root",
      "Host *.internal",
      "  User ignored-pattern",
    ].join("\n"),
  );
  await writeFile(
    path.join(configDir, "servers.conf"),
    [
      "Host app-prod",
      "  HostName 192.0.2.20",
      "  User deploy",
      "  Port 2222",
      "  ProxyJump gateway",
    ].join("\n"),
  );

  const hosts = await discoverSshHosts(config);
  assert.deepEqual(hosts.map((host) => host.alias), ["app-prod", "gateway"]);
  const app = hosts.find((host) => host.alias === "app-prod");
  assert.equal(app?.hostname, "192.0.2.20");
  assert.equal(app?.user, "deploy");
  assert.equal(app?.port, 2222);
  assert.equal(app?.proxyJump, "gateway");
});
