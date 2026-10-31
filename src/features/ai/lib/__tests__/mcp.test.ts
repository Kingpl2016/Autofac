import { describe, expect, it } from "vitest";

import i18n from "@/shared/i18n";
import { MAX_MCP_TOOLS, mcpErrorText, mcpToolName, pickMcpTools, splitMcpToolName } from "../mcp";
import type { McpServerView, McpStatus } from "../mcpApi";

const server = (id: string, over: Partial<McpServerView> = {}): McpServerView => ({
  id,
  name: id.toUpperCase(),
  enabled: true,
  transport: { kind: "http", url: "https://x.com/mcp" },
  approved: "fp",
  fingerprint: "fp",
  needsApproval: false,
  summary: "https://x.com/mcp",
  hasToken: false,
  ...over,
});
const status = (id: string, n: number): McpStatus => ({
  id,
  server: null,
  tools: Array.from({ length: n }, (_, i) => ({ name: `tool.${i}`, title: null, description: "d", inputSchema: { type: "object" }, readOnly: false })),
});

describe("MCP 工具名与挑选", () => {
  it("工具名只含合法字符，不超过 64 个字符", () => {
    expect(mcpToolName("files", "read_file")).toBe("mcp__files__read_file");
    expect(mcpToolName("my server", "get.thing/now")).toBe("mcp__my_server__get_thing_now");
    const long = mcpToolName("a".repeat(50), "b".repeat(80));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("工具名拆回服务器名与工具名；服务器已删除时只给工具名", () => {
    const servers = [server("files"), server("files_2")];
    expect(splitMcpToolName(mcpToolName("files_2", "read"), servers)).toEqual({ server: "FILES_2", tool: "read" });
    expect(splitMcpToolName("mcp__files__read_file", servers)).toEqual({ server: "FILES", tool: "read_file" });
    expect(splitMcpToolName("mcp__gone__list", servers)).toEqual({ server: null, tool: "list" });
  });

  it("只给启用、已确认且已连接的服务器的工具，最多 20 个", () => {
    const servers = [server("a"), server("b", { enabled: false }), server("c", { needsApproval: true }), server("d")];
    const picked = pickMcpTools(servers, [status("a", 15), status("b", 3), status("c", 3), status("d", 10)]);
    expect(picked).toHaveLength(MAX_MCP_TOOLS);
    expect(new Set(picked.map((p) => p.serverId))).toEqual(new Set(["a", "d"]));
    expect(picked[0]).toMatchObject({ name: "mcp__a__tool_0", serverName: "A" });
    expect(pickMcpTools(servers, [])).toEqual([]);
  });

  it("错误文案：连接失败带上原因", async () => {
    await i18n.changeLanguage("zh");
    expect(mcpErrorText(i18n.t, { code: "needs_approval", message: "x" })).toBe("还没有确认这个服务器的命令");
    expect(mcpErrorText(i18n.t, { code: "connect", message: "connect failed: program not found" })).toBe("连接失败: program not found");
    expect(mcpErrorText(i18n.t, "weird")).toContain("weird");
  });
});
