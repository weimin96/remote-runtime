import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRemoteSshIcons, remoteSshGlobalEntrypoint } from "../src/server/icons.js";

const svg = '<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"></svg>';

test("publishes MCP implementation icons and a global quick action icon", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-ssh-icons-"));
  await Promise.all([
    writeFile(path.join(root, "icon.svg"), svg),
    writeFile(path.join(root, "icon-dark.svg"), svg),
  ]);

  const icons = await loadRemoteSshIcons(root);
  assert.equal(icons.length, 2);
  assert.deepEqual(icons.map((icon) => icon.theme), ["light", "dark"]);
  for (const icon of icons) {
    assert.equal(icon.mimeType, "image/svg+xml");
    assert.deepEqual(icon.sizes, ["256x256"]);
    assert.match(icon.src, /^data:image\/svg\+xml;base64,/);
    const encoded = icon.src.split(",", 2)[1];
    assert.equal(Buffer.from(encoded, "base64").toString("utf8"), svg);
  }

  const entrypoint = remoteSshGlobalEntrypoint(icons);
  assert.equal(entrypoint.type, "global");
  assert.equal(entrypoint.quickAction?.title, "SSH 终端");
  assert.equal(entrypoint.quickAction?.target.name, "remote.open");
  assert.deepEqual(entrypoint.quickAction?.icons, icons);
});
