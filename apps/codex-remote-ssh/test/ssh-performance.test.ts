import assert from "node:assert/strict";
import test from "node:test";

import { connectionFailureMessage, inferExecYieldTimeMs, sshMultiplexingArgs, sshTransportFailureMessage } from "../src/server/ssh-performance.js";

test("selects shorter default yields for long-running commands", () => {
  assert.equal(inferExecYieldTimeMs("pwd"), 2_500);
  assert.equal(inferExecYieldTimeMs("docker compose build"), 1_200);
  assert.equal(inferExecYieldTimeMs("tail -f /var/log/app.log"), 400);
});

test("configures OpenSSH connection multiplexing on POSIX", (context) => {
  if (process.platform === "win32") return context.skip("OpenSSH ControlMaster is POSIX-only here");
  const args = sshMultiplexingArgs();
  assert.ok(args.includes("ControlMaster=auto"));
  assert.ok(args.includes("ControlPersist=300"));
  assert.ok(args.some((value) => value.startsWith("ControlPath=/tmp/codex-rssh-") && value.endsWith("/%C")));
});

test("recognizes network failures but not authentication failures", () => {
  assert.match(connectionFailureMessage("ssh: connect to host 192.0.2.10 port 22: Connection timed out") ?? "", /timed out/i);
  assert.equal(connectionFailureMessage("Permission denied (publickey)."), null);
  assert.match(sshTransportFailureMessage("Permission denied (publickey).") ?? "", /permission denied/i);
  assert.equal(sshTransportFailureMessage("application exited 255"), null);
});
