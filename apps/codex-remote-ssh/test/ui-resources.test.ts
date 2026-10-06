import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_UI, WORKSPACE_UI } from "../src/server/ui-resources.js";

test("uses stable MCP App resource URIs across releases", () => {
  assert.equal(WORKSPACE_UI, "ui://remote-ssh/workspace");
  assert.equal(COMMAND_UI, "ui://remote-ssh/command");
  assert.doesNotMatch(WORKSPACE_UI, /-v\d/);
  assert.doesNotMatch(COMMAND_UI, /-v\d/);
});
