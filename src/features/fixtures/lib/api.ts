import { invoke } from "@/shared/tauri/invoke";

import type { CatalogPage, CatalogQuery, CatalogSummary, FixtureModel, ImportOutcome } from "./types";

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
 * 导入一个 Open Fixture Library 灯具 JSON（`.json`），合并进自定义模型库。
 *
 * @param path 用户在文件对话框里选择的文件路径。
 */
export function fixtureImportOfl(path: string): Promise<ImportOutcome> {
  return invoke<ImportOutcome>("fixture_import_ofl", { path });
}

/**
 * 打开一个 OFL 包（官方仓库 zip 或解压后的文件夹），建立可搜索的目录。进度见 `ofl:catalog-progress` 事件。
 *
 * @param path zip 文件或文件夹路径。
 */
export function oflCatalogOpen(path: string): Promise<CatalogSummary> {
  return invoke<CatalogSummary>("ofl_catalog_open", { path });
}

/** 上次打开的 OFL 目录的概况；从未打开过时为 `null`。 */
export function oflCatalogSummary(): Promise<CatalogSummary | null> {
  return invoke<CatalogSummary | null>("ofl_catalog_summary");
}

/**
 * 分页搜索 OFL 目录。
 *
 * @param query 查询条件。
 */
export function oflCatalogSearch(query: CatalogQuery): Promise<CatalogPage> {
  return invoke<CatalogPage>("ofl_catalog_search", { query });
}

/**
 * 符合条件的全部灯具标识（全选当前筛选结果）。
 *
 * @param query 查询条件（忽略分页）。
 */
export function oflCatalogKeys(query: CatalogQuery): Promise<string[]> {
  return invoke<string[]>("ofl_catalog_keys", { query });
}

/**
 * 导入勾选的 OFL 灯具。进度见 `ofl:import-progress` 事件。
 *
 * @param keys 灯具标识（`制造商/灯具`）。
 */
export function oflCatalogImport(keys: readonly string[]): Promise<ImportOutcome> {
  return invoke<ImportOutcome>("ofl_catalog_import", { keys });
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
