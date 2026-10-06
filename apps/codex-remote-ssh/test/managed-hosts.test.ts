import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readManagedHosts, removeManagedHost, saveManagedHost } from "../src/server/managed-hosts.js";

test("persists only managed host metadata and key paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-managed-"));
  const config = path.join(root, "hosts.json");
  const key = path.join(root, "id_test");
  await writeFile(key, "not-a-real-key");

  await saveManagedHost({
    id: "app-prod",
    hostname: "192.0.2.20",
    user: "deploy",
    port: 2222,
    identityFile: key,
    proxyJump: "gateway",
    defaultCwd: "/opt/app",
  }, config);

  const hosts = await readManagedHosts(config);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].identityFile, key);
  const raw = await readFile(config, "utf8");
  assert.match(raw, /id_test/);
  assert.doesNotMatch(raw, /not-a-real-key/);
  const mode = (await stat(config)).mode & 0o777;
  assert.equal(mode, 0o600);

  await removeManagedHost("app-prod", config);
  assert.deepEqual(await readManagedHosts(config), []);
});
