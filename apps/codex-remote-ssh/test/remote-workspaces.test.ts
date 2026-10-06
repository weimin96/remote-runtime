import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RemoteHost } from "../src/server/host-registry.js";
import { discoverRemoteWorkspaceRoots, discoverRemoteWorkspaceServices, discoverRemoteWorkspaces, inspectRemoteWorkspace } from "../src/server/remote-workspaces.js";

function host(): RemoteHost {
  return {
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
    defaultCwd: "/srv/projects",
  };
}

test("inspects and discovers remote workspaces with git metadata", async (context) => {
  if (process.platform === "win32") return context.skip("fake ssh executable test requires POSIX");
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-workspaces-"));
  const fakeSsh = path.join(root, "ssh");
  await writeFile(fakeSsh, `#!/bin/sh
command_name="$*"
case "$command_name" in
  *"__WORKSPACE_ROOT__"*)
    printf '__WORKSPACE_ROOT__\\tcontext\\t/srv/projects/web\\n'
    printf '__WORKSPACE_ROOT__\\tdefault\\t/srv/projects\\n'
    printf '__WORKSPACE_ROOT__\\thome\\t/home/deploy\\n'
    printf '__WORKSPACE_ROOT__\\ttop-level\\t/opt\\n'
    ;;
  *"__SERVICE_SUPPORTED__"*)
    printf '__SERVICE_SUPPORTED__\\t1\\n'
    printf '__SERVICE__\\t127.0.0.1\\t5173\\t101\\tnode\\t/srv/projects/web\\tvite\\n'
    printf '__SERVICE__\\t0.0.0.0\\t8188\\t202\\tpython\\t/srv/projects/web/tools\\tcomfyui\\n'
    ;;
  *"__ROOT__"*)
    printf '__ROOT__\\t/srv/projects\\n'
    printf '/srv/projects/api\\tgit,maven\\t1\\t/srv/projects/api\\tmain\\t1\\t2 3\\n'
    printf '/srv/projects/web\\tgit,node\\t1\\t/srv/projects/web\\tfeature/ui\\t0\\t0 0\\n'
    ;;
  *)
    printf '/srv/projects/api\\tgit,maven\\t1\\t/srv/projects/api\\tmain\\t1\\t2 3\\n'
    ;;
esac
`);
  await chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  const previousConfig = process.env.REMOTE_SSH_CONFIG;
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  process.env.REMOTE_SSH_CONFIG = path.join(root, "config");
  await writeFile(process.env.REMOTE_SSH_CONFIG, "Host example\n  HostName example.invalid\n");
  try {
    const inspected = await inspectRemoteWorkspace(host(), "/srv/projects/api/src");
    assert.equal(inspected.path, "/srv/projects/api");
    assert.deepEqual(inspected.kinds, ["git", "maven"]);
    assert.equal(inspected.git.branch, "main");
    assert.equal(inspected.git.dirty, true);
    assert.equal(inspected.git.behind, 2);
    assert.equal(inspected.git.ahead, 3);

    const discovered = await discoverRemoteWorkspaces(host(), { root: "/srv/projects", maxDepth: 3 });
    assert.equal(discovered.root, "/srv/projects");
    assert.deepEqual(discovered.workspaces.map((workspace) => workspace.name), ["api", "web"]);
    assert.equal(discovered.workspaces[1].git.branch, "feature/ui");

    const roots = await discoverRemoteWorkspaceRoots(host(), "/srv/projects/web");
    assert.deepEqual(roots.roots, [
      { path: "/srv/projects/web", source: "context" },
      { path: "/srv/projects", source: "default" },
      { path: "/home/deploy", source: "home" },
      { path: "/opt", source: "top-level" },
    ]);

    const services = await discoverRemoteWorkspaceServices(host(), "/srv/projects/web");
    assert.equal(services.supported, true);
    assert.equal(services.services.length, 2);
    assert.deepEqual(services.services.map((service) => [service.label, service.port, service.remoteHost]), [
      ["Vite", 5173, "127.0.0.1"],
      ["ComfyUI", 8188, "127.0.0.1"],
    ]);
    assert.equal("args" in services.services[0], false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.REMOTE_SSH_CONFIG;
    else process.env.REMOTE_SSH_CONFIG = previousConfig;
  }
});
