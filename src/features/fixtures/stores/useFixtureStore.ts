import { create } from "zustand";

import {
  fixtureDelete,
  fixtureImportOfl,
  fixtureImportXlsx,
  fixtureList,
  fixtureSave,
  oflCatalogImport,
} from "../lib/api";
import type { FixtureModel, ImportOutcome } from "../lib/types";

/** 加载状态。 */
export type FixtureLoadStatus = "idle" | "loading" | "ready" | "error";

interface FixtureState {
  /** 全部模型：内置在前，自定义在后 */
  models: FixtureModel[];
  status: FixtureLoadStatus;
  /** 加载失败时的错误（后端错误码或消息） */
  error: unknown;
  /** 重新加载全部模型。 */
  load: () => Promise<void>;
  /** 导入 Excel，成功后刷新列表。 */
  importXlsx: (path: string) => Promise<ImportOutcome>;
  /** 导入 OFL 灯具 JSON，成功后刷新列表。 */
  importOfl: (path: string) => Promise<ImportOutcome>;
  /** 从 OFL 整库目录导入勾选的灯具，成功后刷新列表。 */
  importCatalog: (keys: readonly string[]) => Promise<ImportOutcome>;
  /** 新增 / 更新自定义模型，成功后刷新列表，返回保存后的模型。 */
  save: (model: FixtureModel) => Promise<FixtureModel>;
  /** 删除自定义模型，成功后刷新列表。 */
  remove: (id: string) => Promise<void>;
}

/**
 * 灯具素材库的前端状态：后端是唯一数据源，所有修改都先成功落盘再刷新列表。
 */
export const useFixtureStore = create<FixtureState>((set, get) => ({
  models: [],
  status: "idle",
  error: null,

  load: async () => {
    set({ status: "loading", error: null });
    try {
      set({ models: await fixtureList(), status: "ready" });
    } catch (error) {
      set({ status: "error", error });
    }
  },

  importXlsx: async (path) => {
    const outcome = await fixtureImportXlsx(path);
    set({ models: await fixtureList() });
    return outcome;
  },

  importOfl: async (path) => {
    const outcome = await fixtureImportOfl(path);
    set({ models: await fixtureList() });
    return outcome;
  },

  importCatalog: async (keys) => {
    const outcome = await oflCatalogImport(keys);
    set({ models: await fixtureList() });
    return outcome;
  },

  save: async (model) => {
    const saved = await fixtureSave(model);
    set({ models: await fixtureList() });
    return saved;
  },

  remove: async (id) => {
    await fixtureDelete(id);
    set({ models: await fixtureList() });
    // 删除后若列表为空（不应发生：内置模型始终在）也保持 ready
    if (get().status !== "ready") set({ status: "ready" });
  },
}));
