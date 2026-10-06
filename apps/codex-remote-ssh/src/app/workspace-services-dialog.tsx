import React, { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Box, Button, Dialog, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import { Cross1Icon, Link2Icon, ReloadIcon } from "@radix-ui/react-icons";

import { request, requestReadOnly, userFacingError } from "./runtime.js";
import type { PortForwardInfo, RemoteWorkspace, RemoteWorkspaceService } from "./types.js";

export function WorkspaceServicesDialog({ workspace }: { workspace: RemoteWorkspace | null }) {
  const [open, setOpen] = useState(false);
  const [services, setServices] = useState<RemoteWorkspaceService[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [forwards, setForwards] = useState<Record<string, PortForwardInfo>>({});
  const [forwarding, setForwarding] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const requestRef = useRef(0);

  const loadServices = useCallback(async () => {
    if (!workspace) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setNotice("");
    try {
      const [serviceResponse, forwardResponse] = await Promise.all([
        requestReadOnly<{
          isError?: boolean;
          content?: Array<{ text?: string }>;
          structuredContent?: { supported?: boolean; services?: RemoteWorkspaceService[] };
        }>("tools/call", {
          name: "workspace.services",
          arguments: { host: workspace.host, workspacePath: workspace.path },
        }, 20_000),
        requestReadOnly<{
          isError?: boolean;
          structuredContent?: { forwards?: PortForwardInfo[] };
        }>("tools/call", { name: "forward.list", arguments: {} }),
      ]);
      if (serviceResponse.isError) throw new Error(serviceResponse.content?.[0]?.text ?? "发现工作区服务失败");
      if (requestId !== requestRef.current) return;
      const nextServices = serviceResponse.structuredContent?.services ?? [];
      const activeForwards = forwardResponse.isError ? [] : forwardResponse.structuredContent?.forwards ?? [];
      const nextForwards: Record<string, PortForwardInfo> = {};
      for (const service of nextServices) {
        const forward = activeForwards.find((item) => item.status === "running" && item.host === service.host && item.remoteHost === service.remoteHost && item.remotePort === service.port);
        if (forward) nextForwards[service.id] = forward;
      }
      setServices(nextServices);
      setSupported(serviceResponse.structuredContent?.supported !== false);
      setForwards(nextForwards);
    } catch (error) {
      if (requestId === requestRef.current) setNotice(userFacingError(error, "发现工作区服务失败"));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    requestRef.current += 1;
    setServices([]);
    setForwards({});
    setNotice("");
    setSupported(true);
  }, [workspace?.host, workspace?.path]);

  useEffect(() => {
    if (!open || !workspace) return;
    void loadServices();
  }, [loadServices, open, workspace]);

  const forwardService = async (service: RemoteWorkspaceService) => {
    if (forwarding) return;
    setForwarding(service.id);
    setNotice("");
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
      setForwards((current) => ({ ...current, [service.id]: forward }));
      setNotice(`${service.label} 已转发到 127.0.0.1:${forward.localPort}`);
    } catch (error) {
      setNotice(userFacingError(error, "创建端口转发失败"));
    } finally {
      setForwarding(null);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Tooltip content={workspace ? `查看 ${workspace.name} 的运行服务` : "先选择工作区"}>
        <Dialog.Trigger>
          <Button className="deck-action-button" size="2" variant="ghost" color="gray" disabled={!workspace} aria-label="工作区服务">
            <Link2Icon />
            <span className="deck-action-label">服务</span>
            {services.length > 0 && <Badge size="1" variant="soft" color="blue">{services.length}</Badge>}
          </Button>
        </Dialog.Trigger>
      </Tooltip>
      <Dialog.Content maxWidth="680px" className="workspace-services-dialog">
        <Flex justify="between" align="start" gap="3" mb="4">
          <Box minWidth="0">
            <Dialog.Title>工作区服务</Dialog.Title>
            <Dialog.Description size="2" color="gray">
              {workspace ? `${workspace.host} · ${workspace.path}` : "先选择工作区"}
            </Dialog.Description>
          </Box>
          <Flex gap="2" align="center">
            <Button size="1" variant="soft" color="gray" loading={loading} disabled={!workspace} onClick={() => void loadServices()}><ReloadIcon />刷新</Button>
            <Dialog.Close><IconButton size="2" variant="ghost" color="gray" aria-label="关闭工作区服务"><Cross1Icon /></IconButton></Dialog.Close>
          </Flex>
        </Flex>

        <Text as="div" size="1" color="gray" mb="3">读取与当前工作区关联的监听进程；不会扫描整台服务器，也不会执行项目启动脚本。</Text>
        <div className="workspace-service-grid">
          {services.map((service) => {
            const forward = forwards[service.id];
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
                  <Button size="1" variant="soft" loading={forwarding === service.id} disabled={Boolean(forwarding)} onClick={() => void forwardService(service)}>
                    <Link2Icon />转发到本机
                  </Button>
                )}
              </div>
            );
          })}
          {!loading && supported && services.length === 0 && <div className="workspace-services-empty">当前工作区没有检测到关联的监听服务。可确认工作区目录后刷新。</div>}
          {!loading && !supported && <div className="workspace-services-empty">远端缺少 Linux ss / proc，无法识别工作区服务。</div>}
          {loading && services.length === 0 && <div className="workspace-services-empty">正在检测工作区服务…</div>}
        </div>
        {notice && <Text as="div" size="1" color={notice.includes("失败") ? "red" : "gray"} mt="3">{notice}</Text>}
      </Dialog.Content>
    </Dialog.Root>
  );
}
