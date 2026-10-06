import React, { useEffect, useRef, useState } from "react";
import { Badge, Box, Button, Card, Flex, IconButton, ScrollArea, Text, TextField, Tooltip } from "@radix-ui/themes";
import { ActivityLogIcon, CheckCircledIcon, CodeIcon, CrossCircledIcon, EnterFullScreenIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";

import { formatDuration } from "./format.js";
import { capOutput, FIXED_TEST_COMMAND, request, requestReadOnly, transport, userFacingError } from "./runtime.js";
import type { ExecResult, TerminalEvent, ToolResult } from "./types.js";

export function CommandCard({
  toolName,
  toolInput,
  toolResult,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: ToolResult | null;
}) {
  const host = String(toolInput.host ?? "远程主机");
  const batchCommands = Array.isArray(toolInput.commands)
    ? toolInput.commands
        .map((item) => typeof item === "object" && item !== null && "command" in item ? String((item as { command?: unknown }).command ?? "") : "")
        .filter(Boolean)
    : [];
  const command = typeof toolInput.command === "string" && toolInput.command.trim()
    ? toolInput.command
    : batchCommands.length > 0
      ? `批量执行 ${batchCommands.length} 条命令`
      : FIXED_TEST_COMMAND;
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(true);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [interactive, setInteractive] = useState(toolName === "ssh.execInteractive" || toolInput.tty === true);
  const [waitingForUser, setWaitingForUser] = useState(false);
  const [takeoverState, setTakeoverState] = useState<"agent" | "awaiting-user" | "user">("agent");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [handoffInput, setHandoffInput] = useState("");
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const cursorRef = useRef(0);
  const localCursorRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const finalResultRef = useRef(false);

  useEffect(() => {
    const structured = (toolResult?.structuredContent ?? {}) as ExecResult;
    if (structured.sessionId) {
      sessionIdRef.current = structured.sessionId;
      setSessionId(structured.sessionId);
    }
    if (typeof structured.running === "boolean") setRunning(structured.running);
    if (structured.exitCode !== undefined && structured.exitCode !== null) setExitCode(structured.exitCode);
    if (structured.interactive) setInteractive(true);
    if (typeof structured.waitingForUser === "boolean") setWaitingForUser(structured.waitingForUser);
    if (structured.takeoverState === "agent" || structured.takeoverState === "awaiting-user" || structured.takeoverState === "user") {
      setTakeoverState(structured.takeoverState);
    }
    if (structured.prompt !== undefined) setPrompt(structured.prompt ?? null);
    const combined = `${structured.stdout ?? ""}${structured.stderr ?? ""}`;
    if (combined) {
      setOutput(capOutput(combined));
      if (structured.running === false) finalResultRef.current = true;
    }
    if (toolResult?.isError) {
      setRunning(false);
      setError(userFacingError(toolResult.content?.find((item) => item.type === "text")?.text ?? "", "SSH 命令失败"));
    }
  }, [toolResult]);

  useEffect(() => {
    if (interactive) return;
    let disposed = false;
    let timer: number | undefined;

    const processEvents = (events: TerminalEvent[]) => {
      if (!sessionIdRef.current) {
        const matching = [...events]
          .reverse()
          .find((event) => event.type === "command.started" && event.host === host && event.command === command);
        if (matching) {
          sessionIdRef.current = matching.sessionId;
          setSessionId(matching.sessionId);
        }
      }
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      for (const event of events) {
        if (event.sessionId !== sessionId) continue;
        if ((event.type === "stdout" || event.type === "stderr") && !finalResultRef.current) {
          setOutput((current) => capOutput(`${current}${event.data ?? ""}`));
        } else if (event.type === "command.completed") {
          setRunning(false);
          setExitCode(event.exitCode ?? null);
          setDurationMs(event.durationMs ?? null);
        } else if (event.type === "command.failed") {
          setRunning(false);
          setExitCode(event.exitCode ?? null);
          setDurationMs(event.durationMs ?? null);
          setError(event.message ?? "SSH command failed");
        }
      }
    };

    const tick = async () => {
      try {
        const response = await requestReadOnly<{ structuredContent?: { events?: TerminalEvent[]; nextSeq?: number }; isError?: boolean }>(
          "tools/call",
          { name: "terminal.events", arguments: { afterSeq: cursorRef.current, afterLocalSeq: localCursorRef.current, limit: 1000 } },
        );
        if (!disposed && response.isError) {
          setError("终端事件读取失败");
        } else if (!disposed) {
          const events = response.structuredContent?.events ?? [];
          processEvents(events);
          cursorRef.current = Number(response.structuredContent?.nextSeq ?? cursorRef.current);
          localCursorRef.current = Number((response.structuredContent as { nextLocalSeq?: number } | undefined)?.nextLocalSeq ?? localCursorRef.current);
        }
      } catch (nextError) {
        if (!disposed) setError(userFacingError(nextError, "终端事件读取失败"));
      } finally {
        if (!disposed && running) timer = window.setTimeout(tick, 280);
      }
    };
    void tick();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [command, host, interactive, running]);

  useEffect(() => {
    if (!interactive || !running || !sessionId) return;
    let disposed = false;
    let timer: number | undefined;

    const applyResult = (structured: ExecResult) => {
      if (typeof structured.running === "boolean") setRunning(structured.running);
      if (structured.exitCode !== undefined && structured.exitCode !== null) setExitCode(structured.exitCode);
      if (typeof structured.waitingForUser === "boolean") setWaitingForUser(structured.waitingForUser);
      if (structured.takeoverState === "agent" || structured.takeoverState === "awaiting-user" || structured.takeoverState === "user") {
        setTakeoverState(structured.takeoverState);
      }
      if (structured.prompt !== undefined) setPrompt(structured.prompt ?? null);
      const combined = `${structured.stdout ?? ""}${structured.stderr ?? ""}`;
      if (combined) setOutput(capOutput(combined));
      if (structured.running === false) {
        finalResultRef.current = true;
        setWaitingForUser(false);
        setTakeoverState("agent");
        setPrompt(null);
      }
    };

    const tick = async () => {
      try {
        const response = await requestReadOnly<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: ExecResult }>(
          "tools/call",
          { name: "ssh.poll", arguments: { sessionId, yieldTimeMs: takeoverState === "agent" ? 600 : 0 } },
        );
        if (response.isError) throw new Error(response.content?.[0]?.text ?? "SSH 交互会话读取失败");
        if (!disposed && response.structuredContent) applyResult(response.structuredContent);
      } catch (nextError) {
        if (!disposed) setHandoffError(userFacingError(nextError, "SSH 交互会话读取失败"));
      } finally {
        if (!disposed && running) timer = window.setTimeout(tick, takeoverState === "agent" ? 220 : 380);
      }
    };
    void tick();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [interactive, running, sessionId, takeoverState]);

  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;
    const content = root.querySelector<HTMLElement>(".command-card-wrap");
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const maxHeight = interactive ? 420 : 260;
      const height = Math.min(maxHeight, Math.max(88, Math.ceil(content.getBoundingClientRect().height)));
      transport.notify("ui/notifications/size-changed", { height });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [interactive]);

  const needsUser = interactive && running && (waitingForUser || takeoverState === "user");
  const state = error || (!running && exitCode !== 0) ? "error" : running ? "running" : "success";
  const statusText = needsUser
    ? takeoverState === "user" ? "你正在控制" : "需要你的操作"
    : interactive && running
      ? "交互执行中"
      : state === "running" ? "执行中" : state === "success" ? "已完成" : "失败";

  const expand = async () => {
    try {
      await request("ui/request-display-mode", { mode: "fullscreen" });
    } catch {
      // Hosts may reject display mode changes. The compact card remains usable.
    }
  };

  const takeover = async () => {
    if (!sessionId || handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "handoff.takeover",
        arguments: { sessionId },
      });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "接管失败");
      setTakeoverState("user");
      setWaitingForUser(false);
    } catch (nextError) {
      setHandoffError(userFacingError(nextError, "接管失败"));
    } finally {
      setHandoffBusy(false);
    }
  };

  const release = async () => {
    if (!sessionId || handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "handoff.release",
        arguments: { sessionId },
      });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "交回 Agent 失败");
      setTakeoverState("agent");
      setWaitingForUser(false);
      setPrompt(null);
    } catch (nextError) {
      setHandoffError(userFacingError(nextError, "交回 Agent 失败"));
    } finally {
      setHandoffBusy(false);
    }
  };

  const sendHandoffInput = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sessionId || takeoverState !== "user" || !handoffInput || handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }> }>("tools/call", {
        name: "handoff.write",
        arguments: { sessionId, data: `${handoffInput}\r` },
      });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "输入发送失败");
      setHandoffInput("");
    } catch (nextError) {
      setHandoffError(userFacingError(nextError, "输入发送失败"));
    } finally {
      setHandoffBusy(false);
    }
  };

  const cancelInteractive = async () => {
    if (!sessionId || handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      const response = await request<{ isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: ExecResult }>("tools/call", {
        name: "ssh.poll",
        arguments: { sessionId, yieldTimeMs: 0, cancel: true },
      });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? "取消失败");
      if (response.structuredContent) {
        setRunning(response.structuredContent.running ?? false);
        setExitCode(response.structuredContent.exitCode ?? null);
      }
    } catch (nextError) {
      setHandoffError(userFacingError(nextError, "取消失败"));
    } finally {
      setHandoffBusy(false);
    }
  };

  const secretPrompt = Boolean(prompt && /password|passphrase|密码|口令/i.test(prompt));

  return (
    <div className="command-card-wrap">
      <Card size="2" className="command-card">
        <Flex justify="between" align="center" gap="3" mb="2">
          <Flex align="center" gap="2" minWidth="0">
            <Box className="command-icon"><CodeIcon /></Box>
            <Box minWidth="0">
              <Flex align="center" gap="2">
                <Text size="2" weight="medium" truncate>{host}</Text>
                <Badge size="1" variant="soft" color={needsUser ? "orange" : state === "success" ? "green" : state === "error" ? "red" : "blue"}>
                  {needsUser ? <ExclamationTriangleIcon /> : state === "success" ? <CheckCircledIcon /> : state === "error" ? <CrossCircledIcon /> : <ActivityLogIcon />}
                  {statusText}
                </Badge>
              </Flex>
              <Tooltip content={command}>
                <Text as="div" size="1" color="gray" className="command-line" truncate>$ {command}</Text>
              </Tooltip>
            </Box>
          </Flex>
          <Tooltip content="展开命令卡片">
            <IconButton size="1" variant="ghost" color="gray" onClick={() => void expand()} aria-label="展开命令卡片">
              <EnterFullScreenIcon />
            </IconButton>
          </Tooltip>
        </Flex>

        <ScrollArea type="auto" scrollbars="vertical" className="command-output-scroll">
          <pre className={`command-output ${state === "error" ? "error" : ""}`}>
            {error ? error : output || (running ? "正在等待远端输出…" : "命令没有输出")}
          </pre>
        </ScrollArea>

        {interactive && running && (
          <div className={`command-handoff ${needsUser ? "needs-user" : ""}`}>
            <Flex justify="between" align="center" gap="3">
              <Box minWidth="0">
                <Text as="div" size="1" weight="bold">
                  {takeoverState === "user" ? "你正在控制这个 SSH 会话" : waitingForUser ? "需要你的操作" : "Human Takeover 可用"}
                </Text>
                <Text as="div" size="1" color="gray" truncate>
                  {prompt ?? (takeoverState === "user" ? "输入只会发送到当前 PTY，不进入模型上下文。" : "如果 CLI 需要人工输入，可以主动接管当前会话。")}
                </Text>
              </Box>
              <Flex align="center" gap="2" flexShrink="0">
                {takeoverState !== "user" ? (
                  <Button size="1" variant={waitingForUser ? "solid" : "soft"} color={waitingForUser ? "orange" : "gray"} loading={handoffBusy} onClick={() => void takeover()}>
                    接管
                  </Button>
                ) : (
                  <Button size="1" variant="soft" color="gray" loading={handoffBusy} onClick={() => void release()}>
                    交回 Agent
                  </Button>
                )}
                <Button size="1" variant="ghost" color="red" disabled={handoffBusy} onClick={() => void cancelInteractive()}>
                  取消
                </Button>
              </Flex>
            </Flex>

            {takeoverState === "user" && (
              <form className="command-handoff-input" onSubmit={(event) => void sendHandoffInput(event)}>
                <TextField.Root
                  type={secretPrompt ? "password" : "text"}
                  autoComplete="off"
                  value={handoffInput}
                  onChange={(event) => setHandoffInput(event.target.value)}
                  placeholder={secretPrompt ? "输入敏感信息" : "输入后按 Enter 发送"}
                  aria-label={secretPrompt ? "敏感交互输入" : "交互输入"}
                />
                <Button type="submit" size="1" disabled={!handoffInput} loading={handoffBusy}>发送</Button>
              </form>
            )}
            {handoffError && <Text as="div" size="1" color="red" mt="2">{handoffError}</Text>}
          </div>
        )}

        <Flex justify="between" align="center" mt="2">
          <Text size="1" color="gray">Remote SSH · {host}</Text>
          <Flex align="center" gap="2">
            {exitCode !== null && <Text size="1" color={exitCode === 0 ? "green" : "red"}>exit {exitCode}</Text>}
            {durationMs !== null && <Text size="1" color="gray" title={`${durationMs.toLocaleString()} ms`}>{formatDuration(durationMs)}</Text>}
          </Flex>
        </Flex>
      </Card>
    </div>
  );
}
