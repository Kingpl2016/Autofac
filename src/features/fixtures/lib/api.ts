import { invoke } from "@/shared/tauri/invoke";

import type { FixtureModel, ImportOutcome } from "./types";

/** 列出全部灯具模型：内置模型在前，自定义模型在后。 */
export function fixtureList(): Promise<FixtureModel[]> {
  return invoke<FixtureModel[]>("fixture_list");
}

/**
 * 导入物模型 Excel（`.xlsx`），合并进自定义模型库。
 *
 * @param path 用户在文件对话框里选择的文件路径。
 */
export function fixtureImportXlsx(path: string): Promise<ImportOutcome> {
  return invoke<ImportOutcome>("fixture_import_xlsx", { path });
}

/**
 * 新增或更新一个自定义模型，返回实际保存的模型。
 *
 * @param model 要保存的模型。
 */
export function fixtureSave(model: FixtureModel): Promise<FixtureModel> {
  return invoke<FixtureModel>("fixture_save", { model });
}

/**
 * 删除一个自定义模型。
 *
 * @param id 模型编号。
 */
export function fixtureDelete(id: string): Promise<void> {
  return invoke<void>("fixture_delete", { id });
}
