import type { TFunction } from "i18next";

import type { McpServerView, McpStatus, McpTool } from "./mcpApi";

/**
 * MCP 的纯逻辑：给模型的工具名、数量上限与错误文案。
 *
 * 工具名为 `mcp__<服务器>__<工具>`（只含字母、数字、下划线与连字符，最长 64 个字符，各家接口都接受）；
 * 一轮最多给模型 20 个外部工具（按服务器、工具的顺序），避免提示词过长、模型选错。
 */

/** 一轮最多给模型多少个外部工具。 */
export const MAX_MCP_TOOLS = 20;
/** 工具名前缀。 */
export const MCP_PREFIX = "mcp__";

/** 一个给模型的外部工具。 */
export interface McpToolSpec {
  /** 给模型的工具名 */
  name: string;
  serverId: string;
  serverName: string;
  tool: McpTool;
}

/** 名称片段：非法字符换成下划线。 */
const slug = (s: string, max: number) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max) || "x";

/**
 * 给模型的工具名。
 *
 * @param server 服务器名（或 id）。
 * @param tool 工具名。
 * @returns `mcp__<服务器>__<工具>`，最长 64 个字符。
 */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_PREFIX}${slug(server, 20)}__${slug(tool, 64 - MCP_PREFIX.length - 22)}`;
}

/**
 * 这一轮给模型的外部工具：启用的、已确认且已连接的服务器的工具，最多 {@link MAX_MCP_TOOLS} 个，名字重复的跳过。
 *
 * @param servers 服务器配置。
 * @param statuses 已连接的状态。
 * @returns 工具。
 */
export function pickMcpTools(servers: readonly McpServerView[], statuses: readonly McpStatus[]): McpToolSpec[] {
  const out: McpToolSpec[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    if (!server.enabled || server.needsApproval) continue;
    const status = statuses.find((s) => s.id === server.id);
    for (const tool of status?.tools ?? []) {
      if (out.length >= MAX_MCP_TOOLS) return out;
      const name = mcpToolName(server.id, tool.name);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, serverId: server.id, serverName: server.name, tool });
    }
  }
  return out;
}

/**
 * MCP 错误的文案（后端 `{ code, message }`）。
 *
 * @param t 翻译函数。
 * @param e 错误。
 * @returns 文案。
 */
export function mcpErrorText(t: TFunction, e: unknown): string {
  const obj = typeof e === "object" && e !== null ? (e as { code?: unknown; message?: unknown }) : null;
  const code = typeof obj?.code === "string" ? obj.code : typeof e === "string" ? e : "unknown";
  const message = typeof obj?.message === "string" ? obj.message : "";
  const text = t(`ai.mcp.errors.${code}`, { defaultValue: t("ai.mcp.errors.unknown", { code }) });
  const detail = message.replace(/^(connect|call) failed: /, "");
  return (code === "connect" || code === "call") && detail ? `${text}: ${detail}` : text;
}
