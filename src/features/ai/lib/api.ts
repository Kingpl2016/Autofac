import { invoke } from "@/shared/tauri/invoke";
import type { AiModelInfo, AiModelListInput, AiProfileInput, AiProfileView } from "./types";

// AI 命令由应用壳注册，命名空间为 `ai_*`。后端错误统一 reject 为 `{ code, message }`（见 `errors.ts`）。

/** 列出 AI 配置及其 Key 状态。 */
export function aiProfilesList(): Promise<AiProfileView[]> {
  return invoke<AiProfileView[]>("ai_profiles_list");
}

/** 新增或更新 AI 配置。 */
export function aiProfileSave(input: AiProfileInput): Promise<AiProfileView> {
  return invoke<AiProfileView>("ai_profile_save", { input });
}

/** 删除 AI 配置（同时清除其 Key）。 */
export function aiProfileDelete(id: string): Promise<void> {
  return invoke<void>("ai_profile_delete", { id });
}

/** 设置或清除 API Key（空串清除）。Key 只进系统凭据管理器，不会再返回给前端。 */
export function aiKeySet(id: string, key: string): Promise<void> {
  return invoke<void>("ai_key_set", { id, key });
}

/** 查询模型服务提供的模型（Key 只在后端使用，表单里刚填的 Key 不会被保存）。 */
export function aiListModels(input: AiModelListInput): Promise<AiModelInfo[]> {
  return invoke<AiModelInfo[]>("ai_list_models", { input });
}

/** 读取对话记录文件；不存在时为 `null`。 */
export function aiHistoryRead(path: string): Promise<string | null> {
  return invoke<string | null>("ai_history_read", { path });
}

/** 写入对话记录文件（原子写入）。 */
export function aiHistoryWrite(path: string, text: string): Promise<void> {
  return invoke<void>("ai_history_write", { path, text });
}

/** 节目库条目的对话记录路径（数据根目录下 `ai-history/<id>.ai.json`）。 */
export function aiHistoryLibraryPath(entry: string): Promise<string> {
  return invoke<string>("ai_history_library_path", { entry });
}
