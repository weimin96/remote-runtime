import React, { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Box, Button, Dialog, Flex, IconButton, ScrollArea, Select, Text, TextField, Tooltip } from "@radix-ui/themes";
import { CodeIcon, Cross1Icon, MagnifyingGlassIcon, ReloadIcon } from "@radix-ui/react-icons";

import { requestReadOnly, userFacingError } from "./runtime.js";
import type { Host, RemoteWorkspace, RemoteWorkspaceRoot } from "./types.js";

function workspaceSubtitle(workspace: RemoteWorkspace): string {
  const parts: string[] = [];
  if (workspace.git.branch) parts.push(workspace.git.branch);
  if (workspace.git.dirty) parts.push("有修改");
  if (workspace.git.ahead > 0) parts.push(`↑${workspace.git.ahead}`);
  if (workspace.git.behind > 0) parts.push(`↓${workspace.git.behind}`);
  return parts.join(" · ");
}

function mergeWorkspaces(recents: RemoteWorkspace[], discovered: RemoteWorkspace[]): RemoteWorkspace[] {
  const merged = new Map<string, RemoteWorkspace>();
  for (const workspace of recents) merged.set(`${workspace.host}\0${workspace.path}`, workspace);
  for (const workspace of discovered) merged.set(`${workspace.host}\0${workspace.path}`, workspace);
  return [...merged.values()];
}

function parentRemotePath(value: string): string {
  const normalized = value.replace(/\/+$/, "") || "/";
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function workspaceRootLabel(root: RemoteWorkspaceRoot): string {
  if (root.source === "context") return "当前上下文";
  if (root.source === "default") return "主机默认";
  if (root.source === "home") return "登录目录";
  return root.path;
}

export function WorkspaceSwitcher({
  hosts,
  active,
  recents,
  contextHost,
  contextCwd,
  followAgent,
  refreshing,
  onSelect,
  onFollowAgentChange,
  onRefreshActive,
  onRemoveRecent,
  onClearRecents,
}: {
  hosts: Host[];
  active: RemoteWorkspace | null;
  recents: RemoteWorkspace[];
  contextHost: string | null;
  contextCwd: string | null;
  followAgent: boolean;
  refreshing: boolean;
  onSelect: (workspace: RemoteWorkspace) => void;
  onFollowAgentChange: (follow: boolean) => void;
  onRefreshActive: () => Promise<void>;
  onRemoveRecent: (workspace: RemoteWorkspace) => void;
  onClearRecents: () => void;
}) {
  const resolvedHosts = useMemo(() => hosts.filter((host) => host.resolved), [hosts]);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");
  const [root, setRoot] = useState("");
  const [rootCandidates, setRootCandidates] = useState<RemoteWorkspaceRoot[]>([]);
  const [rootsLoading, setRootsLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [discovered, setDiscovered] = useState<RemoteWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const rootRequestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const nextHost = active?.host ?? contextHost ?? resolvedHosts[0]?.id ?? "";
    const hostInfo = resolvedHosts.find((item) => item.id === nextHost);
    setHost(nextHost);
    setRoot(active?.path ? parentRemotePath(active.path) : contextCwd ?? hostInfo?.defaultCwd ?? "");
    setError("");
  }, [active, contextCwd, contextHost, open, resolvedHosts]);

  useEffect(() => {
    if (!open || !host) {
      setRootCandidates([]);
      return;
    }
    const requestId = ++rootRequestRef.current;
    setRootsLoading(true);
    requestReadOnly<{
      isError?: boolean;
      content?: Array<{ text?: string }>;
      structuredContent?: { roots?: RemoteWorkspaceRoot[] };
    }>("tools/call", {
      name: "workspace.roots",
      arguments: {
        host,
        ...(contextHost === host && contextCwd ? { cwd: contextCwd } : {}),
      },
    }, 15_000).then((response) => {
      if (requestId !== rootRequestRef.current) return;
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "读取工作区搜索范围失败");
      const roots = response.structuredContent?.roots ?? [];
      setRootCandidates(roots);
      setRoot((current) => current || roots[0]?.path || "");
    }).catch((nextError) => {
      if (requestId === rootRequestRef.current) setError(userFacingError(nextError, "读取工作区搜索范围失败"));
    }).finally(() => {
      if (requestId === rootRequestRef.current) setRootsLoading(false);
    });
    return () => { rootRequestRef.current += 1; };
  }, [contextCwd, contextHost, host, open]);

  const discover = async () => {
    if (!host || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await requestReadOnly<{
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: { root?: string; workspaces?: RemoteWorkspace[] };
      }>("tools/call", {
        name: "workspace.discover",
        arguments: {
          host,
          ...(root.trim() ? { root: root.trim() } : {}),
          maxDepth: 3,
          maxProjects: 40,
        },
      }, 35_000);
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "发现远程工作区失败");
      setDiscovered(response.structuredContent?.workspaces ?? []);
      if (response.structuredContent?.root) setRoot(response.structuredContent.root);
    } catch (nextError) {
      setError(userFacingError(nextError, "发现远程工作区失败"));
    } finally {
      setLoading(false);
    }
  };

  const merged = useMemo(() => mergeWorkspaces(
    recents.filter((workspace) => !host || workspace.host === host),
    discovered.filter((workspace) => !host || workspace.host === host),
  ), [discovered, host, recents]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return merged;
    return merged.filter((workspace) => `${workspace.name} ${workspace.path} ${workspace.git.branch ?? ""} ${workspace.kinds.join(" ")}`.toLowerCase().includes(normalized));
  }, [merged, query]);
  const activeSubtitle = active ? workspaceSubtitle(active) : "";
  const recentKeys = useMemo(() => new Set(recents.map((workspace) => `${workspace.host}\0${workspace.path}`)), [recents]);

  const refreshActive = async () => {
    if (!active || refreshing) return;
    setError("");
    try {
      await onRefreshActive();
    } catch (nextError) {
      setError(userFacingError(nextError, "刷新远程工作区失败"));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Tooltip content={active ? `${active.host} · ${active.path} · 查看工作区服务` : "选择工作区并统一 Agent、Terminal、SFTP 与服务上下文"}>
        <Dialog.Trigger>
          <button type="button" className={`workspace-switcher-trigger ${active ? "has-workspace" : ""}`}>
            <CodeIcon />
            <span className="workspace-switcher-copy">
              <strong>{active?.name ?? "工作区"}</strong>
              {active && <small>{active.host}{activeSubtitle ? ` · ${activeSubtitle}` : ""} · {followAgent ? "跟随 Agent" : "已固定"}</small>}
            </span>
          </button>
        </Dialog.Trigger>
      </Tooltip>
      <Dialog.Content maxWidth="720px" className="workspace-switcher-dialog">
        <Flex justify="between" align="start" gap="3" mb="3">
          <Box>
            <Dialog.Title>工作区</Dialog.Title>
            <Dialog.Description size="2" color="gray">一个工作区 = SSH 主机 + 工程目录 + Git 状态 + 运行服务。Agent、Terminal 与 SFTP 共用这套上下文。</Dialog.Description>
          </Box>
          <Dialog.Close><IconButton size="2" variant="ghost" color="gray" aria-label="关闭工作区"><Cross1Icon /></IconButton></Dialog.Close>
        </Flex>

        <div className="workspace-context-strip">
          <div className="workspace-context-copy">
            <span>当前工作区</span>
            <strong>{active ? `${active.host} · ${active.name}` : "尚未选择工作区"}</strong>
            {active && <code>{active.path}</code>}
          </div>
          <Flex align="center" gap="2" className="workspace-context-actions">
            {active && <Button size="1" variant="soft" color="gray" loading={refreshing} onClick={() => void refreshActive()}><ReloadIcon />刷新 Git</Button>}
            <Button
              size="1"
              variant={followAgent ? "soft" : "solid"}
              color={followAgent ? "gray" : "jade"}
              onClick={() => onFollowAgentChange(!followAgent)}
            >
              {followAgent ? "固定工作区" : "跟随 Agent"}
            </Button>
          </Flex>
        </div>

        <Flex gap="2" align="end" className="workspace-discovery-form">
          <Box className="workspace-discovery-host">
            <Text as="label" size="1" color="gray">主机</Text>
            <Select.Root value={host || undefined} onValueChange={(value) => {
              setHost(value);
              setRoot("");
              setRootCandidates([]);
              setDiscovered([]);
            }}>
              <Select.Trigger mt="1" placeholder="选择主机" />
              <Select.Content>{resolvedHosts.map((item) => <Select.Item key={item.id} value={item.id}>{item.alias}</Select.Item>)}</Select.Content>
            </Select.Root>
          </Box>
          <Box className="workspace-discovery-root">
            <Text as="label" size="1" color="gray">搜索范围</Text>
            <TextField.Root mt="1" value={root} onChange={(event) => setRoot(event.target.value)} placeholder="例如 /opt、/srv、/home/user 或 /data/projects" />
          </Box>
          <Button size="2" onClick={() => void discover()} loading={loading} disabled={!host || !root.trim()}><ReloadIcon />发现工作区</Button>
        </Flex>

        <div className="workspace-root-candidates">
          <Text size="1" color="gray">{rootsLoading ? "正在读取远端目录…" : "可用搜索范围"}</Text>
          <Flex gap="1" wrap="wrap">
            {rootCandidates.slice(0, 12).map((candidate) => (
              <Button
                key={`${candidate.source}:${candidate.path}`}
                size="1"
                variant={root === candidate.path ? "solid" : "soft"}
                color={root === candidate.path ? "jade" : "gray"}
                onClick={() => setRoot(candidate.path)}
                title={candidate.path}
              >
                {workspaceRootLabel(candidate)}
                {candidate.source !== "top-level" && <span className="workspace-root-path">{candidate.path}</span>}
              </Button>
            ))}
          </Flex>
        </div>

        <TextField.Root mt="3" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选工作区、路径或分支">
          <TextField.Slot><MagnifyingGlassIcon /></TextField.Slot>
        </TextField.Root>
        {error && <Text as="div" size="1" color="red" mt="2">{error}</Text>}

        <Flex justify="between" align="center" mt="3" mb="1" className="workspace-list-head">
          <Text size="1" color="gray">{visible.length} 个工作区 · 最近 {recents.length}</Text>
          {recents.length > 0 && <Button size="1" variant="ghost" color="gray" onClick={onClearRecents}>清空最近</Button>}
        </Flex>

        <ScrollArea type="auto" scrollbars="vertical" className="workspace-switcher-list">
          <div className="workspace-switcher-grid">
            {visible.map((workspace) => {
              const subtitle = workspaceSubtitle(workspace);
              const selected = active?.host === workspace.host && active.path === workspace.path;
              const recent = recentKeys.has(`${workspace.host}\0${workspace.path}`);
              return (
                <div key={`${workspace.host}:${workspace.path}`} className={`workspace-option-wrap ${selected ? "is-selected" : ""}`}>
                  <button
                    type="button"
                    className="workspace-option"
                    onClick={() => {
                      onSelect(workspace);
                      setOpen(false);
                    }}
                  >
                    <div className="workspace-option-head">
                      <strong>{workspace.name}</strong>
                      <span>{workspace.host}</span>
                    </div>
                    <code>{workspace.path}</code>
                    <div className="workspace-option-meta">
                      {workspace.kinds.slice(0, 4).map((kind) => <Badge key={kind} size="1" variant="soft" color="gray">{kind}</Badge>)}
                      {workspace.git.branch && <Badge size="1" variant="soft" color={workspace.git.dirty ? "orange" : "green"}>{workspace.git.branch}{workspace.git.dirty ? " *" : ""}</Badge>}
                      {subtitle && <span>{subtitle}</span>}
                    </div>
                  </button>
                  {recent && (
                    <Tooltip content="从最近项目移除">
                      <IconButton
                        size="1"
                        variant="ghost"
                        color="gray"
                        className="workspace-option-remove"
                        aria-label={`从最近项目移除 ${workspace.name}`}
                        onClick={() => onRemoveRecent(workspace)}
                      >
                        <Cross1Icon />
                      </IconButton>
                    </Tooltip>
                  )}
                </div>
              );
            })}
            {!visible.length && (
              <div className="workspace-switcher-empty">
                {loading ? "正在发现工作区…" : "暂无工作区。选择主机和搜索范围后点击“发现工作区”。"}
              </div>
            )}
          </div>
        </ScrollArea>
      </Dialog.Content>
    </Dialog.Root>
  );
}
