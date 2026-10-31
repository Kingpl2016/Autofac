import { create } from "zustand";

import { pickMcpTools, type McpToolSpec } from "../lib/mcp";
import {
  mcpConnect,
  mcpDisconnect,
  mcpServerApprove,
  mcpServerDelete,
  mcpServerRestore,
  mcpServerSave,
  mcpServersList,
  mcpStatus,
  type McpServerInput,
  type McpServerView,
  type McpStatus,
} from "../lib/mcpApi";
import type { TrashEntry } from "../lib/skillsApi";

/**
 * MCP 服务器（运行时状态）：配置列表、已连接的状态，以及每个服务器最近一次连接的错误。
 * 配置与密钥在后端；这里只缓存界面要显示的内容。
 */
interface McpState {
  status: "idle" | "loading" | "ready" | "error";
  servers: McpServerView[];
  statuses: McpStatus[];
  /** 服务器 id → 连接中 */
  connecting: Record<string, boolean>;
  /** 服务器 id → 最近一次连接失败的错误（`{ code, message }`） */
  errors: Record<string, unknown>;
  /** 读入配置与状态。 */
  load: () => Promise<void>;
  /**
   * 保存服务器。
   *
   * @param input 输入。
   * @returns 保存后的视图。
   */
  save: (input: McpServerInput) => Promise<McpServerView>;
  /**
   * 确认命令 / 地址。
   *
   * @param id 服务器 id。
   * @param fingerprint 界面上展示时的指纹。
   */
  approve: (id: string, fingerprint: string) => Promise<void>;
  /**
   * 删除（进回收站）。
   *
   * @param id 服务器 id。
   * @returns 回收站条目（撤销用）。
   */
  remove: (id: string) => Promise<TrashEntry>;
  /**
   * 从回收站恢复。
   *
   * @param trashId 条目 id。
   */
  restore: (trashId: string) => Promise<void>;
  /**
   * 连接（失败时记下错误）。
   *
   * @param id 服务器 id。
   * @returns 是否连上。
   */
  connect: (id: string) => Promise<boolean>;
  /**
   * 断开。
   *
   * @param id 服务器 id。
   */
  disconnect: (id: string) => Promise<void>;
}

/** MCP 服务器状态。 */
export const useMcpStore = create<McpState>((set, get) => ({
  status: "idle",
  servers: [],
  statuses: [],
  connecting: {},
  errors: {},
  load: async () => {
    set({ status: "loading" });
    try {
      const [servers, statuses] = await Promise.all([mcpServersList(), mcpStatus()]);
      set({ status: "ready", servers, statuses });
    } catch {
      set({ status: "error" });
    }
  },
  save: async (input) => {
    const saved = await mcpServerSave(input);
    await get().load();
    return saved;
  },
  approve: async (id, fingerprint) => {
    await mcpServerApprove(id, fingerprint);
    await get().load();
  },
  remove: async (id) => {
    const entry = await mcpServerDelete(id);
    await get().load();
    return entry;
  },
  restore: async (trashId) => {
    await mcpServerRestore(trashId);
    await get().load();
  },
  connect: async (id) => {
    set((s) => ({ connecting: { ...s.connecting, [id]: true }, errors: { ...s.errors, [id]: undefined } }));
    try {
      const status = await mcpConnect(id);
      set((s) => ({ statuses: [...s.statuses.filter((x) => x.id !== id), status] }));
      return true;
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [id]: e } }));
      return false;
    } finally {
      set((s) => ({ connecting: { ...s.connecting, [id]: false } }));
    }
  },
  disconnect: async (id) => {
    await mcpDisconnect(id).catch(() => undefined);
    set((s) => ({ statuses: s.statuses.filter((x) => x.id !== id) }));
  },
}));

/**
 * AI 调用前：读入配置，并连接启用、已确认、还没连上的服务器（失败的只记下错误，不影响对话）。
 */
export async function ensureMcp(): Promise<void> {
  const store = useMcpStore.getState();
  if (store.status === "idle") await store.load();
  const { servers, statuses, connecting } = useMcpStore.getState();
  await Promise.all(
    servers
      .filter((s) => s.enabled && !s.needsApproval && !statuses.some((x) => x.id === s.id) && !connecting[s.id] && !useMcpStore.getState().errors[s.id])
      .map((s) => useMcpStore.getState().connect(s.id)),
  );
}

/**
 * 这一轮给模型的外部工具。
 *
 * @returns 工具（最多 20 个）。
 */
export function mcpToolSpecs(): McpToolSpec[] {
  const { servers, statuses } = useMcpStore.getState();
  return pickMcpTools(servers, statuses);
}
