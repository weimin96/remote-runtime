import { readFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ExecutionBroker } from "./execution-broker.js";
import { HostHealthRegistry } from "./host-health.js";
import { PortForwardManager } from "./port-forward-manager.js";
import { registerRemoteSsh } from "./register.js";

const health = new HostHealthRegistry();
const broker = new ExecutionBroker({ health });
const forwards = new PortForwardManager();
const server = new McpServer({
  name: "remote-ssh",
  title: "Remote SSH",
  version: "0.99.5",
});

const remoteSsh = await registerRemoteSsh(
  server,
  broker,
  forwards,
  health,
  await readFile(new URL("./app.html", import.meta.url), "utf8"),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await remoteSsh.close();
    await forwards.closeAll();
    broker.close();
    process.exit(0);
  });
}

await server.connect(new StdioServerTransport());
