import React, { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Box, Button, Dialog, Flex, IconButton, ScrollArea, Select, Text, TextField, Tooltip } from "@radix-ui/themes";
import { CodeIcon, Cross1Icon, Link2Icon, MagnifyingGlassIcon, ReloadIcon } from "@radix-ui/react-icons";

import { request, requestReadOnly, userFacingError } from "./runtime.js";
import type { Host, PortForwardInfo, RemoteWorkspace, RemoteWorkspaceService } from "./types.js";

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
  const [query, setQuery] = useState("");
  const [discovered, setDiscovered] = useState<RemoteWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [services, setServices] = useState<RemoteWorkspaceService[]>([]);
  const [servicesSupported, setServicesSupported] = useState(true);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesLoadedKey, setServicesLoadedKey] = useState("");
  const [serviceForwards, setServiceForwards] = useState<Record<string, PortForwardInfo>>({});
  const [forwardingService, setForwardingService] = useState<string | null>(null);
  const [serviceNotice, setServiceNotice] = useState("");
  const serviceRequestRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const nextHost = active?.host ?? contextHost ?? resolvedHosts[0]?.id ?? "";
    const hostInfo = resolvedHosts.find((item) => item.id === nextHost);
    setHost(nextHost);
    setRoot(active?.path ? parentRemotePath(active.path) : contextCwd ?? hostInfo?.defaultCwd ?? "");
    setError("");
  }, [active, contextCwd, contextHost, open, resolvedHosts]);

  const loadServices = async (force = false) => {
    if (!active) return;
    const key = `${active.host}\0${active.path}`;
    if (!force && servicesLoadedKey === key) return;
    const requestId = ++serviceRequestRef.current;
    setServicesLoading(true);
    setServiceNotice("");
    if (servicesLoadedKey !== key) {
      setServices([]);
      setServiceForwards({});
      setServicesSupported(true);
    }
    try {
      const [serviceResponse, forwardResponse] = await Promise.all([
        requestReadOnly<{
          isError?: boolean;
          content?: Array<{ text?: string }>;
          structuredContent?: { supported?: boolean; services?: RemoteWorkspaceService[] };
        }>("tools/call", {
          name: "workspace.services",
          arguments: { host: active.host, workspacePath: active.path },
        }, 20_000),
        requestReadOnly<{
          isError?: boolean;
          structuredContent?: { forwards?: PortForwardInfo[] };
        }>("tools/call", { name: "forward.list", arguments: {} }),
      ]);
      if (serviceResponse.isError) throw new Error(serviceResponse.content?.[0]?.text ?? "发现项目服务失败");
      if (requestId !== serviceRequestRef.current) return;
      const nextServices = serviceResponse.structuredContent?.services ?? [];
      const nextForwards: Record<string, PortForwardInfo> = {};
      const forwards = forwardResponse.isError ? [] : forwardResponse.structuredContent?.forwards ?? [];
      for (const service of nextServices) {
        const forward = forwards.find((item) => item.status === "running" && item.host === service.host && item.remoteHost === service.remoteHost && item.remotePort === service.port);
        if (forward) nextForwards[service.id] = forward;
      }
      setServices(nextServices);
      setServicesSupported(serviceResponse.structuredContent?.supported !== false);
      setServiceForwards(nextForwards);
      setServicesLoadedKey(key);
    } catch (nextError) {
      if (requestId === serviceRequestRef.current) setServiceNotice(userFacingError(nextError, "发现项目服务失败"));
    } finally {
      if (requestId === serviceRequestRef.current) setServicesLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !active) {
      serviceRequestRef.current += 1;
      if (!active) {
        setServices([]);
        setServiceForwards({});
        setServicesLoadedKey("");
      }
      return;
    }
    void loadServices(false);
    // The active key deliberately controls the one-shot service probe. Git refreshes do not rescan ports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active?.host, active?.path]);

  const forwardService = async (service: RemoteWorkspaceService) => {
    if (forwardingService) return;
    setForwardingService(service.id);
    setServiceNotice("");
    try {
      const response = await request<{
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: { forward?: PortForwardInfo };
      }>("tools/call", {
        name: "forward.open",
        arguments: {
          host: service.host,
          localPort: 0,
          remoteHost: service.remoteHost,
          remotePort: service.port,
        },
      }, 20_000);
      if (response.isError || !response.structuredContent?.forward) throw new Error(response.content?.[0]?.text ?? "创建端口转发失败");
      const forward = response.structuredContent.forward;
      setServiceForwards((current) => ({ ...current, [service.id]: forward }));
      setServiceNotice(`${service.label} 已转发到 127.0.0.1:${forward.localPort}`);
    } catch (nextError) {
      setServiceNotice(userFacingError(nextError, "创建端口转发失败"));
    } finally {
      setForwardingService(null);
    }
  };

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
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "发现远程项目失败");
      setDiscovered(response.structuredContent?.workspaces ?? []);
      if (response.structuredContent?.root) setRoot(response.structuredContent.root);
    } catch (nextError) {
      setError(userFacingError(nextError, "发现远程项目失败"));
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
      setError(userFacingError(nextError, "刷新远程项目失败"));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Tooltip content={active ? `${active.host} · ${active.path}` : "选择远程项目"}>
        <Dialog.Trigger>
          <button type="button" className={`workspace-switcher-trigger ${active ? "has-workspace" : ""}`}>
            <CodeIcon />
            <span className="workspace-switcher-copy">
              <strong>{active?.name ?? "项目"}</strong>
              {active && <small>{active.host}{activeSubtitle ? ` · ${activeSubtitle}` : ""} · {followAgent ? "跟随" : "固定"}</small>}
            </span>
          </button>
        </Dialog.Trigger>
      </Tooltip>
      <Dialog.Content maxWidth="720px" className="workspace-switcher-dialog">
        <Flex justify="between" align="start" gap="3" mb="3">
          <Box>
            <Dialog.Title>远程项目</Dialog.Title>
            <Dialog.Description size="2" color="gray">发现项目根目录，并让 Terminal 与 SFTP 使用同一个工作上下文。</Dialog.Description>
          </Box>
          <Dialog.Close><IconButton size="2" variant="ghost" color="gray" aria-label="关闭远程项目"><Cross1Icon /></IconButton></Dialog.Close>
        </Flex>

        <div className="workspace-context-strip">
          <div className="workspace-context-copy">
            <span>当前上下文</span>
            <strong>{active ? `${active.host} · ${active.name}` : "尚未选择项目"}</strong>
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
              {followAgent ? "固定当前" : "恢复跟随"}
            </Button>
          </Flex>
        </div>

        {active && (
          <section className="workspace-services">
            <Flex justify="between" align="center" gap="3" className="workspace-services-head">
              <Box minWidth="0">
                <Text as="div" size="2" weight="medium">项目服务</Text>
                <Text as="div" size="1" color="gray">只读取当前项目进程实际监听的 TCP 端口，不后台持续扫描。</Text>
              </Box>
              <Button size="1" variant="ghost" color="gray" loading={servicesLoading} onClick={() => void loadServices(true)}><ReloadIcon />刷新</Button>
            </Flex>
            <div className="workspace-service-grid">
              {services.map((service) => {
                const forward = serviceForwards[service.id];
                const href = forward && service.protocol === "http" ? `http://127.0.0.1:${forward.localPort}` : null;
                return (
                  <div key={service.id} className="workspace-service-card">
                    <div className="workspace-service-copy">
                      <Flex align="center" gap="2">
                        <strong>{service.label}</strong>
                        <Badge size="1" variant="soft" color={service.protocol === "http" ? "blue" : "gray"}>{service.protocol.toUpperCase()}</Badge>
                      </Flex>
                      <span>{service.process} · {service.bindAddress}:{service.port}</span>
                      <code>{service.cwd}</code>
                    </div>
                    {forward ? (
                      <div className="workspace-service-forwarded">
                        <span>127.0.0.1:{forward.localPort}</span>
                        {href && <a href={href} target="_blank" rel="noreferrer">打开</a>}
                      </div>
                    ) : (
                      <Button size="1" variant="soft" loading={forwardingService === service.id} disabled={Boolean(forwardingService)} onClick={() => void forwardService(service)}>
                        <Link2Icon />转发
                      </Button>
                    )}
                  </div>
                );
              })}
              {!servicesLoading && servicesSupported && services.length === 0 && <div className="workspace-services-empty">当前项目没有检测到监听中的服务</div>}
              {!servicesLoading && !servicesSupported && <div className="workspace-services-empty">远端缺少 Linux ss / proc，无法识别项目服务</div>}
              {servicesLoading && services.length === 0 && <div className="workspace-services-empty">正在检测项目服务…</div>}
            </div>
            {serviceNotice && <Text as="div" size="1" color={serviceNotice.includes("失败") ? "red" : "gray"} mt="2">{serviceNotice}</Text>}
          </section>
        )}

        <Flex gap="2" align="end" className="workspace-discovery-form">
          <Box className="workspace-discovery-host">
            <Text as="label" size="1" color="gray">主机</Text>
            <Select.Root value={host || undefined} onValueChange={(value) => {
              setHost(value);
              const next = resolvedHosts.find((item) => item.id === value);
              setRoot(next?.defaultCwd ?? "");
              setDiscovered([]);
            }}>
              <Select.Trigger mt="1" placeholder="选择主机" />
              <Select.Content>{resolvedHosts.map((item) => <Select.Item key={item.id} value={item.id}>{item.alias}</Select.Item>)}</Select.Content>
            </Select.Root>
          </Box>
          <Box className="workspace-discovery-root">
            <Text as="label" size="1" color="gray">搜索根目录</Text>
            <TextField.Root mt="1" value={root} onChange={(event) => setRoot(event.target.value)} placeholder="远端登录目录或 /srv/projects" />
          </Box>
          <Button size="2" onClick={() => void discover()} loading={loading} disabled={!host}><ReloadIcon />发现</Button>
        </Flex>

        <TextField.Root mt="3" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选项目、路径或分支">
          <TextField.Slot><MagnifyingGlassIcon /></TextField.Slot>
        </TextField.Root>
        {error && <Text as="div" size="1" color="red" mt="2">{error}</Text>}

        <Flex justify="between" align="center" mt="3" mb="1" className="workspace-list-head">
          <Text size="1" color="gray">{visible.length} 个项目 · 最近 {recents.length}</Text>
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
                {loading ? "正在发现项目…" : "暂无项目。选择主机和搜索根目录后点击“发现”。"}
              </div>
            )}
          </div>
        </ScrollArea>
      </Dialog.Content>
    </Dialog.Root>
  );
}
