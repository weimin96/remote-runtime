import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import { ExecutionBroker } from "./execution-broker.js";
import { HostHealthRegistry } from "./host-health.js";
import { discoverRemoteHosts, publicHost, type RemoteHost } from "./host-registry.js";
import { ManagedHostInputSchema, managedHostsPath, removeManagedHost, saveManagedHost } from "./managed-hosts.js";
import { PortForwardManager } from "./port-forward-manager.js";
import { discoverRemoteWorkspaceRoots, discoverRemoteWorkspaceServices, discoverRemoteWorkspaces, inspectRemoteWorkspace } from "./remote-workspaces.js";
import { SftpClient } from "./sftp-client.js";
import { readServerSnapshot } from "./server-monitor.js";
import { sshConfigPath } from "./ssh-config.js";
import { COMMAND_UI, WORKSPACE_UI } from "./ui-resources.js";

const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

function result(data: Record<string, unknown>, text?: string) {
  return {
    content: text ? [{ type: "text" as const, text }] : [],
    structuredContent: data,
  };
}

function clipModelText(value: string, max = 48_000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

function execText(data: { sessionId: string | null; running: boolean; stdout: string; stderr: string; exitCode: number | null; stdinOpen?: boolean; stdinCharsWritten?: number; stdoutChars?: number; stderrChars?: number; interactive?: boolean; waitingForUser?: boolean; takeoverState?: string; prompt?: string | null }, label: string): string {
  const lines = [label, `状态: ${data.running ? "运行中" : "已完成"}`];
  if (data.interactive) lines.push(`交互: ${data.waitingForUser ? "等待用户接管" : data.takeoverState === "user" ? "用户已接管" : "Agent 观察中"}`);
  if (data.prompt) lines.push(`交互提示: ${data.prompt}`);
  if (data.exitCode !== null) lines.push(`退出码: ${data.exitCode}`);
  if (data.sessionId) lines.push(`sessionId: ${data.sessionId}`);
  if (data.running) lines.push(`下次增量 poll 游标: stdout=${data.stdoutChars ?? 0} · stderr=${data.stderrChars ?? 0}`);
  if (data.stdinOpen) lines.push("stdin: 等待继续输入");
  else if ((data.stdinCharsWritten ?? 0) > 0) lines.push(`stdin: 已写入 ${data.stdinCharsWritten} 个字符`);
  if (data.stdout) lines.push(`stdout:\n${clipModelText(data.stdout)}`);
  if (data.stderr) lines.push(`stderr:\n${clipModelText(data.stderr)}`);
  if (!data.stdout && !data.stderr) lines.push("输出: （空）");
  return lines.join("\n");
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function registerRemoteSsh(server: McpServer, broker: ExecutionBroker, forwards: PortForwardManager, health: HostHealthRegistry, html: string) {
  const sftp = new SftpClient();
  const hostsById = new Map<string, RemoteHost>();
  async function refreshHosts(): Promise<RemoteHost[]> {
    const hosts = await discoverRemoteHosts();
    hostsById.clear();
    for (const host of hosts) hostsById.set(host.id, host);
    return hosts;
  }
  async function requireHost(hostId: string): Promise<RemoteHost> {
    let host = hostsById.get(hostId);
    if (!host) {
      await refreshHosts();
      host = hostsById.get(hostId);
    }
    if (!host) throw new Error(`未找到 SSH Host: ${hostId}`);
    if (!host.resolved) throw new Error(`SSH Host 无法解析: ${host.error ?? hostId}`);
    return host;
  }
  async function observeHost<T>(host: RemoteHost, source: string, work: () => Promise<T>): Promise<T> {
    try {
      const value = await work();
      await health.recordSuccess(host, source);
      return value;
    } catch (error) {
      await health.recordFailure(host, error, source).catch(() => {});
      throw error;
    }
  }
  const ui = (
    resourceUri: string,
    entrypoints: unknown[] = [],
    options: { preferredModelDisplayMode?: "inline" | "fullscreen" } = {},
  ) => ({
    ui: { resourceUri },
    "openai/ui": { entrypoints, ...options },
    "openai/iconStyle": "monochrome",
  });

  server.registerTool(
    "remote.open",
    {
      title: "Remote SSH",
      description: "Open the Remote SSH live terminal workspace.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: { ...ui(WORKSPACE_UI, [{ type: "global" }]), ui: { resourceUri: WORKSPACE_UI, visibility: ["app"] } },
    },
    async () => result({
      page: "terminal",
      hosts: (await refreshHosts()).map(publicHost),
      configPath: sshConfigPath(),
      managedHostsPath: managedHostsPath(),
    }),
  );

  server.registerTool(
    "remote.thread",
    {
      title: "SSH 终端",
      description: "Open the live Remote SSH terminal beside the current conversation.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: { ...ui(WORKSPACE_UI, [{ type: "thread" }]), ui: { resourceUri: WORKSPACE_UI, visibility: ["app"] } },
    },
    async () => result({
      page: "terminal",
      hosts: (await refreshHosts()).map(publicHost),
      configPath: sshConfigPath(),
      managedHostsPath: managedHostsPath(),
    }),
  );

  server.registerTool(
    "ssh.listHosts",
    {
      title: "列出 SSH 主机",
      description: "列出 ~/.ssh/config 中可直接使用的 Host 别名及 OpenSSH 解析后的连接信息。",
      inputSchema: z.object({}),
      annotations: readonly,
    },
    async () => {
      const hosts = (await refreshHosts()).map(publicHost);
      return result(
        { hosts, configPath: sshConfigPath(), managedHostsPath: managedHostsPath() },
        hosts.length
          ? `已发现 ${hosts.length} 台 SSH 主机：\n${hosts.map((host) => `- ${host.alias}: ${host.user ? `${host.user}@` : ""}${host.hostname}:${host.port}`).join("\n")}`
          : "未发现可用 SSH 主机。",
      );
    },
  );

  server.registerTool(
    "hosts.health",
    {
      title: "读取 SSH 主机健康状态",
      description: "返回真实 SSH/SFTP/监控/端口转发操作形成的最近健康缓存，不主动探测主机。仅供 Remote SSH App 使用。",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      const hosts = (await refreshHosts()).filter((host) => host.resolved);
      return result({ health: await health.snapshot(hosts) });
    },
  );

  server.registerTool(
    "hosts.save",
    {
      title: "保存 SSH 主机",
      description: "保存插件管理的 SSH 主机。只保存 IdentityFile 路径，不读取或复制私钥内容。",
      inputSchema: ManagedHostInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (host) => {
      await saveManagedHost(host);
      return result({ hosts: (await refreshHosts()).map(publicHost) });
    },
  );

  server.registerTool(
    "hosts.remove",
    {
      title: "删除 SSH 主机",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id }) => {
      const current = (await refreshHosts()).find((host) => host.id === id);
      if (!current || current.source !== "managed") throw new Error("只能删除插件管理的主机；~/.ssh/config 主机请修改 OpenSSH 配置");
      await removeManagedHost(id);
      return result({ hosts: (await refreshHosts()).map(publicHost) });
    },
  );

  server.registerTool(
    "ssh.testConnection",
    {
      title: "测试 SSH 连接",
      description: "只读测试指定 SSH 主机的连接和身份，固定执行 hostname、id -un、pwd、uname -srm。用户说“连接测试”“SSH 能不能连”“测试某台服务器”时优先使用本工具，而不是本地 shell ssh。执行过程会显示在 Remote SSH UI。",
      inputSchema: z.object({
        host: z.string().min(1),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: ui(COMMAND_UI, [], { preferredModelDisplayMode: "inline" }),
    },
    async ({ host, timeoutMs }) => {
      const data = await broker.exec(await requireHost(host), "hostname; id -un; pwd; uname -srm", {
        yieldTimeMs: Math.min(timeoutMs, 3_000),
        timeoutMs,
      });
      return result(data, execText(data, `SSH 连接测试: ${host}`));
    },
  );

  server.registerTool(
    "ssh.exec",
    {
      title: "执行远程 SSH 命令",
      description: "统一的远程 SSH 执行入口。command 执行单条命令；commands 批量执行最多 12 条互相独立的快速检查；tty=true 使用可人工接管的 SSH PTY，适合密码、MFA、sudo 和确认提示。普通命令支持一次性 stdin/keepStdinOpen。插件自动复用短期 OpenSSH 连接、动态选择首轮等待时间并限制模型输出。长命令返回 sessionId 后统一使用 ssh.writeStdin：传 data 写 stdin，不传 data 即增量 poll，cancel=true 可取消。",
      inputSchema: z.object({
        host: z.string().min(1),
        command: z.string().min(1).max(200_000).optional(),
        commands: z.array(z.object({
          command: z.string().min(1).max(100_000),
          cwd: z.string().min(1).optional(),
        })).min(1).max(12).optional().describe("互相独立的快速检查命令；与 command 二选一。"),
        cwd: z.string().min(1).optional(),
        stdin: z.string().max(1_000_000).optional(),
        keepStdinOpen: z.boolean().default(false),
        tty: z.boolean().default(false).describe("需要真实 TTY/Human Takeover 时设为 true；批量 commands 不支持 tty。"),
        yieldTimeMs: z.number().int().min(0).max(12_000).optional().describe("可选。省略时由插件按命令类型动态选择；只有明确需要改变首轮等待时间时才传。"),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).default(1_800_000),
      }).refine((value) => Boolean(value.command) !== Boolean(value.commands), {
        message: "command 与 commands 必须且只能提供一个",
      }).refine((value) => !value.commands || (!value.tty && value.stdin === undefined && !value.keepStdinOpen), {
        message: "批量 commands 不支持 tty/stdin/keepStdinOpen",
      }).refine((value) => !value.tty || (value.stdin === undefined && !value.keepStdinOpen), {
        message: "tty=true 时不能传 stdin/keepStdinOpen；Human Takeover 输入只能由用户完成",
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: ui(COMMAND_UI, [], { preferredModelDisplayMode: "inline" }),
    },
    async ({ host, command, commands, cwd, stdin, keepStdinOpen, tty, yieldTimeMs, timeoutMs }) => {
      const remoteHost = await requireHost(host);
      if (commands) {
        const items = await mapWithConcurrency(commands, 4, async (entry, index) => {
          try {
            let execution = await broker.exec(remoteHost, entry.command, {
              cwd: entry.cwd ?? cwd,
              yieldTimeMs,
              timeoutMs: Math.min(timeoutMs, 300_000),
            });
            const settleDeadline = Date.now() + Math.min(8_000, timeoutMs);
            while (execution.running && execution.sessionId && Date.now() < settleDeadline) {
              const remaining = settleDeadline - Date.now();
              execution = await broker.poll(execution.sessionId, { yieldTimeMs: Math.max(0, Math.min(1_000, remaining)) });
            }
            return { index, command: entry.command, cwd: entry.cwd ?? null, ...execution };
          } catch (error) {
            return {
              index,
              command: entry.command,
              cwd: entry.cwd ?? null,
              running: false,
              stdout: "",
              stderr: error instanceof Error ? error.message : String(error),
              exitCode: null,
              sessionId: null,
            };
          }
        });
        const text = items.map((item) => {
          const state = item.running ? "运行中" : item.exitCode === 0 ? "exit 0" : item.exitCode === null ? "启动失败" : `exit ${item.exitCode}`;
          const output = clipModelText(`${item.stdout ?? ""}${item.stderr ? `${item.stdout ? "\n" : ""}${item.stderr}` : ""}`, 12_000);
          return `[${item.index + 1}] ${state} · $ ${item.command}${output ? `\n${output}` : ""}`;
        }).join("\n\n");
        const allFinished = items.every((item) => !item.running);
        const allSucceeded = allFinished && items.every((item) => item.exitCode === 0);
        return result({
          host,
          batch: true,
          items,
          running: false,
          stdout: text,
          stderr: "",
          exitCode: allSucceeded ? 0 : allFinished ? 1 : null,
          sessionId: null,
          stdinOpen: false,
          stdinCharsWritten: 0,
        }, `SSH 批量命令: ${host}\n${text}`);
      }

      if (!command) throw new Error("command 不能为空");
      const data = tty
        ? await broker.execInteractive(remoteHost, command, { cwd, yieldTimeMs, timeoutMs })
        : await broker.exec(remoteHost, command, { cwd, stdin, keepStdinOpen, yieldTimeMs, timeoutMs });
      return result(data, execText(data, `${tty ? "SSH 交互命令" : "SSH 命令"}: ${host}${cwd ? ` · ${cwd}` : ""}\n$ ${command}`));
    },
  );

  server.registerTool(
    "ssh.execBatch",
    {
      title: "批量执行远程 SSH 命令",
      description: "在同一 SSH 主机上批量执行最多 12 条互相独立的快速命令，一次 MCP 调用返回全部结果，最多并发 4 条。适合 pwd/git status/docker ps/df/free/grep 等探测与只读检查，减少连续 tool round-trip。存在前后依赖、需要 stdin/PTY、Human Takeover 或长时间 build/deploy 的命令不要使用本工具，改用 ssh.exec/ssh.execInteractive。",
      inputSchema: z.object({
        host: z.string().min(1),
        commands: z.array(z.object({
          command: z.string().min(1).max(100_000),
          cwd: z.string().min(1).optional(),
        })).min(1).max(12),
        yieldTimeMs: z.number().int().min(0).max(5_000).optional().describe("可选。省略时每条命令使用动态 yield。"),
        timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host, commands, yieldTimeMs, timeoutMs }) => {
      const remoteHost = await requireHost(host);
      const items = await mapWithConcurrency(commands, 4, async (entry, index) => {
        try {
          const execution = await broker.exec(remoteHost, entry.command, {
            cwd: entry.cwd,
            yieldTimeMs,
            timeoutMs,
          });
          return { index, command: entry.command, cwd: entry.cwd ?? null, ...execution };
        } catch (error) {
          return {
            index,
            command: entry.command,
            cwd: entry.cwd ?? null,
            running: false,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: null,
            sessionId: null,
          };
        }
      });
      const text = items.map((item) => {
        const state = item.running ? "运行中" : item.exitCode === 0 ? "exit 0" : item.exitCode === null ? "启动失败" : `exit ${item.exitCode}`;
        const output = clipModelText(`${item.stdout ?? ""}${item.stderr ? `${item.stdout ? "\n" : ""}${item.stderr}` : ""}`, 12_000);
        return `[${item.index + 1}] ${state} · $ ${item.command}${output ? `\n${output}` : ""}`;
      }).join("\n\n");
      return result({ host, items }, `SSH 批量命令: ${host}\n${text}`);
    },
  );

  server.registerTool(
    "ssh.write",
    {
      title: "写入 SSH 命令 stdin",
      description: "向 keepStdinOpen=true 的 ssh.exec 运行中 session 写入标准输入。data 原样传递，不做 trim；eof=true 会关闭 stdin。适合代码判分、管道程序、分阶段输入等非 PTY 场景。",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        data: z.string().max(1_000_000).default(""),
        eof: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ sessionId, data, eof }) => {
      const write = await broker.writeStdin(sessionId, data, eof);
      return result(write, `SSH stdin: ${sessionId}\n已写入 ${write.writtenChars} 个字符${eof ? " · EOF" : ""}${write.stdinOpen ? " · stdin 保持打开" : ""}`);
    },
  );

  server.registerTool(
    "ssh.execInteractive",
    {
      title: "执行可人工接管的 SSH 命令",
      description: "通过同一个 SSH PTY 执行可能需要密码、私钥 passphrase、MFA、sudo 或确认输入的远程命令。模型不会向该 PTY 写密码；检测到常见交互提示时返回 waitingForUser=true，让用户直接在 inline 命令卡片或 Remote SSH Terminal 中接管。后续继续使用 ssh.poll 观察同一 session，禁止为了获取输入而重新执行命令。",
      inputSchema: z.object({
        host: z.string().min(1),
        command: z.string().min(1).max(200_000),
        cwd: z.string().min(1).optional(),
        yieldTimeMs: z.number().int().min(0).max(12_000).default(3_000),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).default(1_800_000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ...ui(COMMAND_UI, [], { preferredModelDisplayMode: "inline" }), ui: { resourceUri: COMMAND_UI, visibility: ["app"] } },
    },
    async ({ host, command, cwd, yieldTimeMs, timeoutMs }) => {
      const data = await broker.execInteractive(await requireHost(host), command, { cwd, yieldTimeMs, timeoutMs });
      return result(data, execText(data, `SSH 交互命令: ${host}${cwd ? ` · ${cwd}` : ""}\n$ ${command}`));
    },
  );

  server.registerTool(
    "ssh.poll",
    {
      title: "继续 SSH 命令",
      description: "读取 ssh.exec、ssh.execBatch 子任务或 ssh.execInteractive 返回的运行中 session。为减少重复 token，长任务后续轮询应把上一次结果的 stdoutChars/stderrChars 分别传入 afterStdoutChars/afterStderrChars，此时只返回新增输出；不传 cursor 时保持兼容，返回累计输出。Human Takeover 会话会同时返回 waitingForUser/takeoverState。cancel=true 会中断对应 SSH 进程或 PTY。",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        yieldTimeMs: z.number().int().min(0).max(12_000).default(5_000),
        cancel: z.boolean().default(false),
        afterStdoutChars: z.number().int().min(0).optional(),
        afterStderrChars: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ sessionId, yieldTimeMs, cancel, afterStdoutChars, afterStderrChars }) => {
      const data = await broker.poll(sessionId, { yieldTimeMs, cancel, afterStdoutChars, afterStderrChars });
      return result(data, execText(data, `SSH session: ${sessionId}${cancel ? " · 已请求取消" : ""}`));
    },
  );

  server.registerTool(
    "ssh.writeStdin",
    {
      title: "继续 SSH 会话",
      description: "统一继续 ssh.exec 返回的运行中 session。data 非空时写入普通非 PTY stdin；eof=true 关闭 stdin；不传 data/eof 时等价于增量 poll。afterStdoutChars/afterStderrChars 应传上一次结果游标以避免重复输出。Human Takeover PTY 的敏感输入仍只能由用户通过 App-only 接管通道输入；模型只能用本工具观察或取消该 PTY。",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        data: z.string().max(1_000_000).optional(),
        eof: z.boolean().default(false),
        yieldTimeMs: z.number().int().min(0).max(12_000).default(5_000),
        cancel: z.boolean().default(false),
        afterStdoutChars: z.number().int().min(0).optional(),
        afterStderrChars: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ sessionId, data, eof, yieldTimeMs, cancel, afterStdoutChars, afterStderrChars }) => {
      if ((data !== undefined && data.length > 0) || eof) {
        if (broker.isHandoffSession(sessionId)) {
          throw new Error("该 session 是 Human Takeover PTY；模型不能写入敏感交互输入，请等待用户在 Remote SSH 卡片或 Terminal 中接管");
        }
        await broker.writeStdin(sessionId, data ?? "", eof);
      }
      const execution = await broker.poll(sessionId, {
        yieldTimeMs,
        cancel,
        afterStdoutChars,
        afterStderrChars,
      });
      return result(execution, execText(execution, `SSH session: ${sessionId}${cancel ? " · 已请求取消" : ""}`));
    },
  );

  server.registerTool(
    "terminal.events",
    {
      title: "读取终端事件",
      inputSchema: z.object({
        afterSeq: z.number().int().min(0).default(0),
        afterLocalSeq: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(500),
      }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ afterSeq, afterLocalSeq, limit }) => result(await broker.readEvents(afterSeq, afterLocalSeq, limit)),
  );

  server.registerTool(
    "terminal.clearCommandEvents",
    {
      title: "清空 Agent 命令事件",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      await broker.clearCommandEvents();
      return result({ ok: true });
    },
  );

  server.registerTool(
    "handoff.takeover",
    {
      title: "接管交互 SSH 会话",
      inputSchema: z.object({ sessionId: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ sessionId }) => result(broker.takeoverHandoff(sessionId)),
  );

  server.registerTool(
    "handoff.release",
    {
      title: "交回交互 SSH 会话",
      inputSchema: z.object({ sessionId: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ sessionId }) => result(broker.releaseHandoff(sessionId)),
  );

  server.registerTool(
    "handoff.write",
    {
      title: "写入已接管 SSH 会话",
      inputSchema: z.object({ sessionId: z.string().min(1), data: z.string().max(1_000_000) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ sessionId, data }) => result(broker.writeHandoff(sessionId, data)),
  );

  server.registerTool(
    "handoff.resize",
    {
      title: "调整接管 SSH 会话尺寸",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        cols: z.number().int().min(20).max(500),
        rows: z.number().int().min(5).max(200),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ sessionId, cols, rows }) => result(broker.resizeHandoff(sessionId, cols, rows)),
  );

  server.registerTool(
    "workspace.changedFiles",
    {
      title: "扫描 Agent 本次变化文件",
      description: "只读扫描指定远端 cwd 中自 Agent 命令开始后修改过的文件。仅供 Remote SSH App 用于定位变化文件。",
      inputSchema: z.object({
        host: z.string().min(1),
        cwd: z.string().min(1),
        since: z.string().min(1),
        maxFiles: z.number().int().min(1).max(500).default(200),
      }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host, cwd, since, maxFiles }) => result(await broker.inspectChangedFiles(await requireHost(host), cwd, since, maxFiles)),
  );

  server.registerTool(
    "workspace.inspect",
    {
      title: "识别远程项目",
      description: "从指定远端目录向上识别最近的项目根目录，并读取项目类型和轻量 Git 状态。仅供 Remote SSH App 使用。",
      inputSchema: z.object({
        host: z.string().min(1),
        cwd: z.string().min(1).max(4096),
      }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host, cwd }) => {
      const remoteHost = await requireHost(host);
      return result({ workspace: await observeHost(remoteHost, "workspace", () => inspectRemoteWorkspace(remoteHost, cwd)) });
    },
  );

  server.registerTool(
    "workspace.roots",
    {
      title: "读取远程工作区搜索范围",
      description: "只读返回当前目录、主机默认目录、登录 HOME 与远端可访问的顶层目录，供 Remote SSH App 选择工作区搜索范围。",
      inputSchema: z.object({
        host: z.string().min(1),
        cwd: z.string().min(1).max(4096).optional(),
      }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host, cwd }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "workspace", () => discoverRemoteWorkspaceRoots(remoteHost, cwd)));
    },
  );

  server.registerTool(
    "workspace.discover",
    {
      title: "发现远程项目",
      description: "在指定远端目录下有限深度发现 Git/Node/Maven/Gradle/Python/Rust/Go 项目，并返回轻量 Git 状态。仅供 Remote SSH App 使用。",
      inputSchema: z.object({
        host: z.string().min(1),
        root: z.string().min(1).max(4096).optional(),
        maxDepth: z.number().int().min(1).max(5).default(3),
        maxProjects: z.number().int().min(1).max(80).default(30),
      }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host, root, maxDepth, maxProjects }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "workspace", () => discoverRemoteWorkspaces(remoteHost, { root, maxDepth, maxProjects })));
    },
  );

  server.registerTool(
    "workspace.services",
    {
      title: "发现远程项目服务",
      description: "只读读取当前远程 Workspace 内进程实际监听的 TCP 服务，并按常见开发服务分类。仅供 Remote SSH App 使用，不执行项目脚本，不持续后台扫描。",
      inputSchema: z.object({
        host: z.string().min(1),
        workspacePath: z.string().min(1).max(4096),
      }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host, workspacePath }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "workspace", () => discoverRemoteWorkspaceServices(remoteHost, workspacePath)));
    },
  );

  server.registerTool(
    "terminal.openSession",
    {
      title: "打开交互 SSH 终端",
      inputSchema: z.object({
        host: z.string().min(1),
        cwd: z.string().min(1).optional(),
        cols: z.number().int().min(20).max(500).default(100),
        rows: z.number().int().min(5).max(200).default(30),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host, cwd, cols, rows }) =>
      result(broker.openTerminal(await requireHost(host), { cwd, cols, rows })),
  );

  server.registerTool(
    "terminal.write",
    {
      title: "写入交互终端",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        data: z.string().max(1_000_000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ sessionId, data }) => result(broker.writeTerminal(sessionId, data)),
  );

  server.registerTool(
    "terminal.resize",
    {
      title: "调整交互终端尺寸",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        cols: z.number().int().min(20).max(500),
        rows: z.number().int().min(5).max(200),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ sessionId, cols, rows }) => result(broker.resizeTerminal(sessionId, cols, rows)),
  );

  server.registerTool(
    "terminal.closeSession",
    {
      title: "关闭交互 SSH 终端",
      inputSchema: z.object({ sessionId: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ sessionId }) => result(broker.closeTerminal(sessionId)),
  );

  server.registerTool(
    "forward.list",
    {
      title: "列出本地端口转发",
      description: "列出 Remote SSH App 当前进程管理的 Local Port Forward。",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => result({ runtimeId: broker.runtimeIdentity(), forwards: forwards.list() }),
  );

  server.registerTool(
    "forward.open",
    {
      title: "打开本地端口转发",
      description: "创建仅绑定 127.0.0.1 的 SSH Local Port Forward。仅供 Remote SSH App 使用。",
      inputSchema: z.object({
        host: z.string().min(1),
        localPort: z.number().int().min(0).max(65_535),
        remoteHost: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/, "远端地址只支持 DNS 名、IPv4 或 localhost"),
        remotePort: z.number().int().min(1).max(65_535),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host, localPort, remoteHost, remotePort }) => {
      const remoteHostInfo = await requireHost(host);
      return result({
        forward: await observeHost(remoteHostInfo, "forward", () => forwards.open(remoteHostInfo, localPort, remoteHost, remotePort)),
      });
    },
  );

  server.registerTool(
    "forward.close",
    {
      title: "停止本地端口转发",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id }) => result(await forwards.close(id)),
  );

  server.registerTool(
    "monitor.snapshot",
    {
      title: "读取服务器状态",
      description: "通过固定只读探针读取 Linux 主机的 CPU、内存、磁盘、负载与 uptime。仅供 Remote SSH App 使用。",
      inputSchema: z.object({ host: z.string().min(1) }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host }) => {
      const remoteHost = await requireHost(host);
      return result({ snapshot: await observeHost(remoteHost, "monitor", () => readServerSnapshot(remoteHost)) });
    },
  );

  server.registerTool(
    "sftp.listDirectory",
    {
      title: "浏览 SFTP 目录",
      description: "通过系统 OpenSSH SFTP 浏览远端目录。仅供 Remote SSH App 文件侧栏使用。",
      inputSchema: z.object({
        host: z.string().min(1),
        path: z.string().min(1).optional(),
      }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host, path }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "sftp", () => sftp.listDirectory(remoteHost, path)));
    },
  );

  server.registerTool(
    "sftp.readText",
    {
      title: "预览 SFTP 文本文件",
      description: "通过系统 OpenSSH SFTP 下载并预览小型文本文件。仅供 Remote SSH App 文件侧栏使用。",
      inputSchema: z.object({
        host: z.string().min(1),
        path: z.string().min(1),
        maxBytes: z.number().int().min(1).max(2 * 1024 * 1024).default(512 * 1024),
      }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ host, path, maxBytes }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "sftp", () => sftp.readText(remoteHost, path, maxBytes)));
    },
  );

  const appWriteMeta = { ui: { visibility: ["app"] } };

  server.registerTool(
    "sftp.writeText",
    {
      title: "保存 SFTP 文本文件",
      inputSchema: z.object({ host: z.string().min(1), path: z.string().min(1), text: z.string().max(2 * 1024 * 1024) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: appWriteMeta,
    },
    async ({ host, path, text }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "sftp", () => sftp.writeText(remoteHost, path, text)));
    },
  );

  server.registerTool(
    "sftp.mkdir",
    {
      title: "新建 SFTP 目录",
      inputSchema: z.object({ host: z.string().min(1), path: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: appWriteMeta,
    },
    async ({ host, path }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "sftp", () => sftp.mkdir(remoteHost, path)));
    },
  );

  server.registerTool(
    "sftp.rename",
    {
      title: "重命名 SFTP 文件",
      inputSchema: z.object({ host: z.string().min(1), from: z.string().min(1), to: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: appWriteMeta,
    },
    async ({ host, from, to }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "sftp", () => sftp.rename(remoteHost, from, to)));
    },
  );

  server.registerTool(
    "sftp.remove",
    {
      title: "删除 SFTP 条目",
      description: "删除文件/链接或空目录。不会递归删除目录。仅供 Remote SSH App 文件侧栏使用。",
      inputSchema: z.object({
        host: z.string().min(1),
        path: z.string().min(1),
        type: z.enum(["file", "symlink", "directory"]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: appWriteMeta,
    },
    async ({ host, path, type }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "sftp", () => sftp.remove(remoteHost, path, type)));
    },
  );

  server.registerTool(
    "sftp.uploadBegin",
    {
      title: "开始 SFTP 上传",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: appWriteMeta,
    },
    async () => result(await sftp.beginUpload()),
  );

  server.registerTool(
    "sftp.uploadChunk",
    {
      title: "追加 SFTP 上传分块",
      inputSchema: z.object({ uploadId: z.string().min(1), dataBase64: z.string().max(1_200_000) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: appWriteMeta,
    },
    async ({ uploadId, dataBase64 }) => result(await sftp.appendUploadChunk(uploadId, dataBase64)),
  );

  server.registerTool(
    "sftp.uploadCommit",
    {
      title: "提交 SFTP 上传",
      inputSchema: z.object({ host: z.string().min(1), uploadId: z.string().min(1), path: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: appWriteMeta,
    },
    async ({ host, uploadId, path }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "sftp", () => sftp.commitUpload(remoteHost, uploadId, path)));
    },
  );

  server.registerTool(
    "sftp.uploadAbort",
    {
      title: "取消 SFTP 上传",
      inputSchema: z.object({ uploadId: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: appWriteMeta,
    },
    async ({ uploadId }) => result(await sftp.abortUpload(uploadId)),
  );

  server.registerTool(
    "sftp.downloadBegin",
    {
      title: "开始 SFTP 下载",
      description: "启动异步 SFTP 下载到本机 Downloads，使用临时 .part 文件并在完成后原子落盘。仅供 Remote SSH App 使用。",
      inputSchema: z.object({
        host: z.string().min(1),
        path: z.string().min(1),
        expectedSize: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: appWriteMeta,
    },
    async ({ host, path, expectedSize }) => {
      const remoteHost = await requireHost(host);
      return result(await sftp.beginDownload(remoteHost, path, expectedSize));
    },
  );

  server.registerTool(
    "sftp.downloadStatus",
    {
      title: "读取 SFTP 下载状态",
      inputSchema: z.object({ downloadId: z.string().min(1) }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ downloadId }) => {
      const status = await sftp.downloadStatus(downloadId);
      if (status.status === "completed") {
        const remoteHost = await requireHost(status.host);
        await health.recordSuccess(remoteHost, "sftp").catch(() => {});
      } else if (status.status === "error") {
        const remoteHost = await requireHost(status.host);
        await health.recordFailure(remoteHost, new Error(status.error ?? "SFTP 下载失败"), "sftp").catch(() => {});
      }
      return result(status);
    },
  );

  server.registerTool(
    "sftp.downloadCancel",
    {
      title: "取消 SFTP 下载",
      inputSchema: z.object({ downloadId: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: appWriteMeta,
    },
    async ({ downloadId }) => result(await sftp.cancelDownload(downloadId)),
  );

  server.registerTool(
    "sftp.downloadToDownloads",
    {
      title: "下载 SFTP 文件到本机",
      description: "通过系统 OpenSSH SFTP 将远端文件直接保存到当前用户的 ~/Downloads。仅供 Remote SSH App 文件侧栏使用。",
      inputSchema: z.object({ host: z.string().min(1), path: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: appWriteMeta,
    },
    async ({ host, path }) => {
      const remoteHost = await requireHost(host);
      return result(await observeHost(remoteHost, "sftp", () => sftp.downloadToDownloads(remoteHost, path)));
    },
  );

  const registerUiResource = (
    name: string,
    uri: string,
    preferredDisplayMode: "inline" | "fullscreen",
    viewMode: "command" | "workspace",
  ) =>
    server.registerResource(
      name,
      uri,
      { title: "Remote SSH", mimeType: "text/html;profile=mcp-app" },
      async () => ({
        contents: [
          {
            uri,
            mimeType: "text/html;profile=mcp-app",
            text: html.replace("__REMOTE_SSH_VIEW_MODE__", viewMode),
            _meta: {
              "openai/ui": {
                preferredDisplayMode,
                availableDisplayModes: ["inline", "fullscreen"],
              },
              ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
            },
          },
        ],
      }),
    );

  registerUiResource("remote-ssh-workspace", WORKSPACE_UI, "fullscreen", "workspace");
  registerUiResource("remote-ssh-command", COMMAND_UI, "inline", "command");

  return { close: () => sftp.close() };
}
