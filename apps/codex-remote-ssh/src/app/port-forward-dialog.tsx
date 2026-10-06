import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Box, Button, Card, Dialog, Flex, Grid, IconButton, ScrollArea, Select, Text, TextField } from "@radix-ui/themes";
import { Cross1Icon, Link2Icon, PlusIcon, StopIcon } from "@radix-ui/react-icons";

import { request, requestReadOnly, userFacingError } from "./runtime.js";
import type { Host, PortForwardInfo } from "./types.js";

type ForwardDraft = {
  host: string;
  localPort: string;
  remoteHost: string;
  remotePort: string;
};

export function PortForwardDialog({ hosts }: { hosts: Host[] }) {
  const resolvedHosts = useMemo(() => hosts.filter((host) => host.resolved), [hosts]);
  const [open, setOpen] = useState(false);
  const [forwards, setForwards] = useState<PortForwardInfo[]>([]);
  const [draft, setDraft] = useState<ForwardDraft>({ host: "", localPort: "3000", remoteHost: "127.0.0.1", remotePort: "3000" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const runtimeIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (draft.host && resolvedHosts.some((host) => host.id === draft.host)) return;
    setDraft((current) => ({ ...current, host: resolvedHosts[0]?.id ?? "" }));
  }, [draft.host, resolvedHosts]);

  const loadForwards = useCallback(async () => {
    const response = await requestReadOnly<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { runtimeId?: string; forwards?: PortForwardInfo[] } }>("tools/call", {
      name: "forward.list",
      arguments: {},
    });
    if (response.isError) throw new Error(response.content?.[0]?.text ?? "读取端口转发失败");
    const runtimeId = response.structuredContent?.runtimeId ?? null;
    if (runtimeIdRef.current && runtimeId && runtimeIdRef.current !== runtimeId) {
      setNotice("Remote SSH runtime 已重启，旧的本地端口转发已结束；需要时请重新创建。");
    }
    if (runtimeId) runtimeIdRef.current = runtimeId;
    setForwards(response.structuredContent?.forwards ?? []);
  }, []);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        await loadForwards();
        if (!disposed) setError("");
      } catch (nextError) {
        if (!disposed) setError(userFacingError(nextError, "读取端口转发失败"));
      } finally {
        if (!disposed) timer = window.setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadForwards, open]);

  const createForward = async (event: React.FormEvent) => {
    event.preventDefault();
    const localPort = Number(draft.localPort);
    const remotePort = Number(draft.remotePort);
    if (!draft.host) return setError("请选择 SSH 主机");
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) return setError("本地端口必须在 1–65535 之间");
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return setError("远端端口必须在 1–65535 之间");
    if (!/^[A-Za-z0-9._-]+$/.test(draft.remoteHost.trim())) return setError("远端地址只支持 DNS 名、IPv4 或 localhost");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "forward.open",
        arguments: {
          host: draft.host,
          localPort,
          remoteHost: draft.remoteHost.trim(),
          remotePort,
        },
      }, 20_000);
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "创建端口转发失败");
      await loadForwards();
    } catch (nextError) {
      setError(userFacingError(nextError, "创建端口转发失败"));
    } finally {
      setBusy(false);
    }
  };

  const closeForward = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "forward.close",
        arguments: { id },
      });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "停止端口转发失败");
      await loadForwards();
    } catch (nextError) {
      setError(userFacingError(nextError, "停止端口转发失败"));
    } finally {
      setBusy(false);
    }
  };

  const runningCount = forwards.filter((forward) => forward.status === "running").length;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button
          className="deck-action-button"
          size="2"
          variant="ghost"
          color={runningCount ? "green" : "gray"}
          aria-label="端口转发"
          title={runningCount ? `端口转发 · ${runningCount} 个运行中` : "端口转发"}
        >
          <Link2Icon />
          <span className="deck-action-label">端口转发</span>
          {runningCount > 0 && <Badge size="1" variant="soft" color="green">{runningCount}</Badge>}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="680px" className="forward-dialog">
        <Flex justify="between" align="start" gap="3" mb="4">
          <Box>
            <Dialog.Title>本地端口转发</Dialog.Title>
            <Dialog.Description size="2" color="gray">SSH Local Forward，仅监听 127.0.0.1，不向局域网或公网开放。</Dialog.Description>
          </Box>
          <Dialog.Close><IconButton size="2" variant="ghost" color="gray" aria-label="关闭端口转发"><Cross1Icon /></IconButton></Dialog.Close>
        </Flex>

        <form onSubmit={(event) => void createForward(event)}>
          <Grid columns={{ initial: "1", sm: "4" }} gap="3" className="forward-form-grid">
            <Box gridColumn={{ initial: "1", sm: "1 / -1" }}>
              <Text as="label" size="2" weight="medium">SSH 主机</Text>
              <Select.Root value={draft.host || undefined} onValueChange={(host) => setDraft((current) => ({ ...current, host }))}>
                <Select.Trigger mt="1" style={{ width: "100%" }} placeholder="选择主机" />
                <Select.Content>{resolvedHosts.map((host) => <Select.Item key={host.id} value={host.id}>{host.alias} · {host.user}@{host.hostname}</Select.Item>)}</Select.Content>
              </Select.Root>
            </Box>
            <Box>
              <Text as="label" size="2" weight="medium">本地端口</Text>
              <TextField.Root mt="1" type="number" min="1" max="65535" value={draft.localPort} onChange={(event) => setDraft((current) => ({ ...current, localPort: event.target.value }))} />
            </Box>
            <Box gridColumn={{ initial: "1", sm: "2 / 4" }}>
              <Text as="label" size="2" weight="medium">远端地址</Text>
              <TextField.Root mt="1" value={draft.remoteHost} onChange={(event) => setDraft((current) => ({ ...current, remoteHost: event.target.value }))} placeholder="127.0.0.1" />
            </Box>
            <Box>
              <Text as="label" size="2" weight="medium">远端端口</Text>
              <TextField.Root mt="1" type="number" min="1" max="65535" value={draft.remotePort} onChange={(event) => setDraft((current) => ({ ...current, remotePort: event.target.value }))} />
            </Box>
          </Grid>
          <Flex justify="between" align="center" gap="3" mt="4">
            <Text size="1" color={error ? "red" : notice ? "blue" : "gray"}>{error || notice || "示例：127.0.0.1:3000 → 远端 127.0.0.1:3000"}</Text>
            <Button type="submit" loading={busy} disabled={!resolvedHosts.length}><PlusIcon /> 创建转发</Button>
          </Flex>
        </form>

        <Box mt="5" className="forward-list-wrap">
          <Flex justify="between" align="center" mb="2">
            <Text size="2" weight="medium">当前转发</Text>
            <Text size="1" color="gray">{runningCount} 运行中</Text>
          </Flex>
          <ScrollArea type="auto" scrollbars="vertical" className="forward-list-scroll">
            <Flex direction="column" gap="2" pr="2">
              {forwards.map((forward) => (
                <Card key={forward.id} size="2" className="forward-card">
                  <Flex justify="between" align="center" gap="3">
                    <Box minWidth="0">
                      <Flex align="center" gap="2" mb="1">
                        <Text size="2" weight="medium" truncate>{forward.localHost}:{forward.localPort}</Text>
                        <Badge size="1" variant="soft" color={forward.status === "running" ? "green" : forward.status === "starting" ? "blue" : "red"}>
                          {forward.status === "running" ? "运行中" : forward.status === "starting" ? "启动中" : "异常"}
                        </Badge>
                      </Flex>
                      <Text as="div" size="1" color="gray" truncate>{forward.host} → {forward.remoteHost}:{forward.remotePort}</Text>
                      {forward.error && <Text as="div" size="1" color="red" truncate>{forward.error}</Text>}
                    </Box>
                    <Button size="1" variant="soft" color={forward.status === "error" ? "gray" : "red"} disabled={busy} onClick={() => void closeForward(forward.id)}>
                      <StopIcon /> {forward.status === "error" ? "移除" : "停止"}
                    </Button>
                  </Flex>
                </Card>
              ))}
              {!forwards.length && <div className="forward-empty">暂无端口转发</div>}
            </Flex>
          </ScrollArea>
        </Box>
      </Dialog.Content>
    </Dialog.Root>
  );
}
