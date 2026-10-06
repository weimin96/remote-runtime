import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const PLUGIN = "remote-ssh@remote-agent";
const CACHE_PARENT = `${os.homedir()}/.codex/plugins/cache/remote-agent/`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function isRemoteSshRuntimeCwd(cwd) {
  if (!cwd.startsWith(CACHE_PARENT)) return false;
  const relative = cwd.slice(CACHE_PARENT.length);
  return /^remote-ssh\/[^/]+$/.test(relative)
    || /^plugin-backup-[^/]+\/remote-ssh\/[^/]+$/.test(relative);
}

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function marketplaceRoot(name) {
  let output = "";
  try {
    output = commandOutput("codex", ["plugin", "marketplace", "list"]);
  } catch {
    return null;
  }
  for (const line of output.split("\n")) {
    const match = line.match(/^([^\s]+)\s+(.+)$/);
    if (match?.[1] === name) return match[2].trim();
  }
  return null;
}

function ensureLocalMarketplace() {
  const current = marketplaceRoot("remote-agent");
  if (current === REPO_ROOT) return;

  if (current) {
    console.log(`Switching remote-agent marketplace from ${current} to local checkout ${REPO_ROOT}…`);
    execFileSync("codex", ["plugin", "marketplace", "remove", "remote-agent"], { stdio: "inherit" });
  } else {
    console.log(`Registering local remote-agent marketplace from ${REPO_ROOT}…`);
  }
  execFileSync("codex", ["plugin", "marketplace", "add", REPO_ROOT], { stdio: "inherit" });
}

function remoteSshRuntimePids() {
  let ps;
  try {
    ps = commandOutput("ps", ["ax", "-o", "pid=,command="]);
  } catch {
    return [];
  }

  const pids = [];
  for (const line of ps.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+node\s+\.\/dist\/server\.js\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    try {
      const lsof = commandOutput("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const cwd = lsof.split("\n").find((entry) => entry.startsWith("n"))?.slice(1) ?? "";
      if (isRemoteSshRuntimeCwd(cwd)) pids.push(pid);
    } catch {
      // The process may exit while it is being inspected. In that case there is
      // nothing left to reload.
    }
  }
  return pids;
}

ensureLocalMarketplace();
console.log(`Installing ${PLUGIN} from the local checkout…`);
execFileSync("codex", ["plugin", "add", PLUGIN, "--json"], { stdio: "inherit" });

const pids = remoteSshRuntimePids();
if (pids.length) {
  console.log(`Restarting ${pids.length} Remote SSH MCP runtime(s): ${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
} else {
  console.log("No running Remote SSH MCP runtimes need restarting.");
}

console.log("Local plugin install complete. Existing Remote SSH surfaces will reconnect to the current version on their next request.");
