import type { SkillInfo } from "@/bindings/SkillInfo";
import type { TrashEntry } from "@/bindings/TrashEntry";
import { invoke } from "@/shared/tauri/invoke";

// 用户技能（`data/skills`）与回收站（`data/trash`）的命令。后端错误以错误码字符串 reject：
// `invalid` / `too_large` / `symlink` / `unsafe_path` / `exists` / `not_found` / `io` / `zip`。

export type { SkillInfo, TrashEntry };

/** 列出用户技能。 */
export function skillsList(): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("skills_list");
}

/** 读取技能的 `SKILL.md` 全文。 */
export function skillsRead(name: string): Promise<string> {
  return invoke<string>("skills_read", { name });
}

/** 导入技能包（`.zip`、文件夹或单个 `SKILL.md`）；`replace` 为替换同名技能（旧的进回收站）。 */
export function skillsImport(path: string, replace = false): Promise<SkillInfo> {
  return invoke<SkillInfo>("skills_import", { path, replace });
}

/** 把技能导出成 zip。 */
export function skillsExport(name: string, dest: string): Promise<void> {
  return invoke<void>("skills_export", { name, dest });
}

/** 删除技能（进回收站，30 天内可恢复）。 */
export function skillsDelete(name: string): Promise<TrashEntry> {
  return invoke<TrashEntry>("skills_delete", { name });
}

/** 从回收站恢复技能。 */
export function skillsRestore(trashId: string): Promise<SkillInfo> {
  return invoke<SkillInfo>("skills_restore", { trashId });
}

/** 在文件管理器里显示技能（省略名称时打开技能目录）。 */
export function skillsReveal(name?: string): Promise<void> {
  return invoke<void>("skills_reveal", { name: name ?? null });
}

/** 列出回收站。 */
export function trashList(): Promise<TrashEntry[]> {
  return invoke<TrashEntry[]>("trash_list");
}

/** 把一段 JSON 放进回收站（删除的 MCP 服务器配置、记忆…）。 */
export function trashPutJson(kind: string, label: string, json: string): Promise<TrashEntry> {
  return invoke<TrashEntry>("trash_put_json", { kind, label, json });
}

/** 取回一个 JSON 条目（并从回收站删除）。 */
export function trashTakeJson(id: string): Promise<string> {
  return invoke<string>("trash_take_json", { id });
}

/** 彻底删除一个回收站条目。 */
export function trashRemove(id: string): Promise<void> {
  return invoke<void>("trash_remove", { id });
}
