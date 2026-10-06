import { createAppTransport } from "@openai/mcp-extensions/app/transport";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

export const transport = createAppTransport<Record<string, unknown>>();
export const FIXED_TEST_COMMAND = "hostname; id -un; pwd; uname -srm";
export const teardownCallbacks = new Set<() => void>();

export function request<Result = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000) {
  return transport.request<Result>(method, params, timeoutMs);
}

function toolErrorText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const result = value as { isError?: boolean; content?: Array<{ text?: string }> };
  if (!result.isError) return "";
  return result.content?.map((item) => item.text ?? "").filter(Boolean).join("\n") ?? "";
}

export function isTransientTransportError(value: unknown): boolean {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : toolErrorText(value);
  return /transport\s+closed|connection\s+closed|channel\s+closed|mcp.*closed/i.test(text);
}

export function userFacingError(value: unknown, fallback = "操作失败"): string {
  const text = value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : toolErrorText(value);
  if (!text) return fallback;
  if (isTransientTransportError(text)) return "Remote SSH 正在重新连接，请稍后重试";
  const timeout = text.match(/(?:操作超过|exceeded|timeout|timed out).*?(\d{4,})\s*ms/i);
  if (timeout) return `${fallback}：连接或操作超时，请检查 SSH 状态后重试`;
  return text;
}

export async function requestReadOnly<Result = any>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15_000,
  retries = 2,
): Promise<Result> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await request<Result>(method, params, timeoutMs);
      if (!isTransientTransportError(response) || attempt === retries) return response;
      lastError = new Error(toolErrorText(response) || "Transport closed");
    } catch (error) {
      if (!isTransientTransportError(error) || attempt === retries) throw error;
      lastError = error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("Remote SSH transport unavailable");
}

export function capOutput(value: string, max = 48_000) {
  return value.length <= max ? value : `…${value.slice(value.length - max)}`;
}

export function createTerminal(disableStdin: boolean, cursorBlink: boolean) {
  const instance = new Terminal({
    convertEol: true,
    cursorBlink,
    disableStdin,
    fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace',
    fontSize: 12,
    lineHeight: 1.32,
    scrollback: 8000,
    theme: {
      background: "#0b0d10",
      foreground: "#d7dde7",
      cursor: "#d7dde7",
      selectionBackground: "#47556988",
      black: "#0b0d10",
      brightBlack: "#64748b",
    },
  });
  const addon = new FitAddon();
  instance.loadAddon(addon);
  return { instance, addon };
}
