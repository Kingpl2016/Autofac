import type { McpServerInput } from "@/bindings/McpServerInput";
import type { McpServerView } from "@/bindings/McpServerView";
import type { McpStatus } from "@/bindings/McpStatus";
import type { McpTool } from "@/bindings/McpTool";
import type { McpToolOutput } from "@/bindings/McpToolOutput";
import type { TrashEntry } from "@/bindings/TrashEntry";
import { invoke } from "@/shared/tauri/invoke";

// MCP 客户端的命令（`mcp_*`）。后端错误 reject 为 `{ code, message }`（见 `mcpErrorText`）。

export type { McpServerInput, McpServerView, McpStatus, McpTool, McpToolOutput };

/** 列出 MCP 服务器。 */
export function mcpServersList(): Promise<McpServerView[]> {
  return invoke<McpServerView[]>("mcp_servers_list");
}

/** 新增 / 更新服务器（改了命令要重新确认）。 */
export function mcpServerSave(input: McpServerInput): Promise<McpServerView> {
  return invoke<McpServerView>("mcp_server_save", { input });
}

/** 确认服务器的命令 / 地址（指纹必须与界面上展示时一致）。 */
export function mcpServerApprove(id: string, fingerprint: string): Promise<McpServerView> {
  return invoke<McpServerView>("mcp_server_approve", { id, fingerprint });
}

/** 删除服务器（配置进回收站，密钥清除）。 */
export function mcpServerDelete(id: string): Promise<TrashEntry> {
  return invoke<TrashEntry>("mcp_server_delete", { id });
}

/** 从回收站恢复服务器（要重新确认、重新填写密钥）。 */
export function mcpServerRestore(trashId: string): Promise<McpServerView> {
  return invoke<McpServerView>("mcp_server_restore", { trashId });
}

/** 连接服务器并列出工具。 */
export function mcpConnect(id: string): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_connect", { id });
}

/** 断开服务器。 */
export function mcpDisconnect(id: string): Promise<void> {
  return invoke<void>("mcp_disconnect", { id });
}

/** 已连接的服务器与工具。 */
export function mcpStatus(): Promise<McpStatus[]> {
  return invoke<McpStatus[]>("mcp_status");
}

/** 调用工具（调用前必须已征得用户同意）。 */
export function mcpCallTool(id: string, tool: string, args: unknown): Promise<McpToolOutput> {
  return invoke<McpToolOutput>("mcp_call_tool", { id, tool, arguments: args ?? {} });
}
