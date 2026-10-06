import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SshHost = {
  id: string;
  alias: string;
  hostname: string;
  user: string;
  port: number;
  identityFiles: string[];
  proxyJump: string | null;
  resolved: boolean;
  error?: string;
};

function stripComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === "'" || char === '"') && quote === null) quote = char;
    else if (char === quote) quote = null;
    else if (char === "#" && quote === null) return line.slice(0, index);
  }
  return line;
}

function splitTokens(input: string): string[] {
  const result: string[] = [];
  const expression = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(input)) !== null) {
    result.push(match[1] ?? match[2] ?? match[3]);
  }
  return result;
}

function isConcreteHost(value: string): boolean {
  return value.length > 0 && !/[*!?\[\]]/.test(value);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

async function expandInclude(raw: string, baseDir: string): Promise<string[]> {
  const expanded = raw.startsWith("~/")
    ? path.join(os.homedir(), raw.slice(2))
    : path.resolve(baseDir, raw);
  const basename = path.basename(expanded);
  if (!/[?*]/.test(basename)) return [expanded];
  const directory = path.dirname(expanded);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const pattern = wildcardToRegExp(basename);
  return entries.filter((entry) => pattern.test(entry)).sort().map((entry) => path.join(directory, entry));
}

async function collectAliases(
  configPath: string,
  aliases: Set<string>,
  visited: Set<string>,
): Promise<void> {
  const resolvedPath = path.resolve(configPath);
  if (visited.has(resolvedPath)) return;
  visited.add(resolvedPath);
  let content: string;
  try {
    content = await readFile(resolvedPath, "utf8");
  } catch {
    return;
  }
  const baseDir = path.dirname(resolvedPath);
  for (const sourceLine of content.split(/\r?\n/)) {
    const line = stripComment(sourceLine).trim();
    if (!line) continue;
    const tokens = splitTokens(line);
    if (!tokens.length) continue;
    const keyword = tokens[0].toLowerCase();
    if (keyword === "host") {
      for (const alias of tokens.slice(1)) if (isConcreteHost(alias)) aliases.add(alias);
    } else if (keyword === "include") {
      for (const include of tokens.slice(1)) {
        for (const includedPath of await expandInclude(include, baseDir)) {
          await collectAliases(includedPath, aliases, visited);
        }
      }
    }
  }
}

function parseResolvedConfig(stdout: string): Omit<SshHost, "id" | "alias" | "resolved"> {
  const values = new Map<string, string[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf(" ");
    if (separator < 1) continue;
    const key = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!value) continue;
    const current = values.get(key) ?? [];
    current.push(value);
    values.set(key, current);
  }
  const first = (key: string, fallback = "") => values.get(key)?.[0] ?? fallback;
  const port = Number.parseInt(first("port", "22"), 10);
  const proxyJump = first("proxyjump", "none");
  return {
    hostname: first("hostname"),
    user: first("user"),
    port: Number.isFinite(port) ? port : 22,
    identityFiles: values.get("identityfile") ?? [],
    proxyJump: proxyJump === "none" ? null : proxyJump,
  };
}

export function sshConfigPath(): string {
  const configured = process.env.REMOTE_SSH_CONFIG;
  if (!configured) return path.join(os.homedir(), ".ssh", "config");
  return configured.startsWith("~/")
    ? path.join(os.homedir(), configured.slice(2))
    : path.resolve(configured);
}

export async function discoverSshHosts(configPath = sshConfigPath()): Promise<SshHost[]> {
  try {
    await access(configPath);
  } catch {
    return [];
  }
  const aliases = new Set<string>();
  await collectAliases(configPath, aliases, new Set());
  const hosts = await Promise.all(
    [...aliases].sort().map(async (alias): Promise<SshHost> => {
      try {
        const { stdout } = await execFileAsync("ssh", ["-G", "-F", configPath, "--", alias], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        });
        return { id: alias, alias, ...parseResolvedConfig(stdout), resolved: true };
      } catch (error) {
        return {
          id: alias,
          alias,
          hostname: alias,
          user: "",
          port: 22,
          identityFiles: [],
          proxyJump: null,
          resolved: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return hosts;
}
