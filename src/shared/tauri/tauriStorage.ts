import { LazyStore } from "@tauri-apps/plugin-store";
import type { PersistStorage, StorageValue } from "zustand/middleware";

import { dataFilePath } from "./dataDir";

/** 界面偏好落盘文件（位于应用数据根目录，即软件目录下的 `data`）。 */
const PREFS_FILE = "ui-prefs.json";

/** 写盘防抖（毫秒）：连续切换筛选时合并为一次写入。 */
const AUTO_SAVE_MS = 300;

/** 每个文件复用同一个 `LazyStore`（首次读写时才加载文件）。 */
const stores = new Map<string, Promise<LazyStore>>();

/**
 * 取得某个文件对应的 `LazyStore`。路径用数据根目录下的绝对路径，
 * 这样偏好文件和后端的其他数据放在同一个目录里。
 *
 * @param file 文件名。
 * @returns 复用的 `LazyStore`。
 */
function getStore(file: string): Promise<LazyStore> {
  let store = stores.get(file);
  if (!store) {
    store = dataFilePath(file).then((path) => new LazyStore(path, { autoSave: AUTO_SAVE_MS }));
    stores.set(file, store);
  }
  return store;
}

/**
 * 创建给 zustand `persist` 用的存储适配器，统一经 Tauri Store 插件把状态以 JSON
 * 对象写入 `ui-prefs.json`。读写失败只告警并降级（读取返回 `null`），不让界面因为
 * 偏好存储不可用而崩溃。
 *
 * # Arguments
 *
 * * `file` - 落盘文件名（位于应用数据根目录），默认是界面偏好文件；
 *   第二个窗口等需要独立持久化的状态应使用自己的文件，避免多个窗口同写一个文件。
 *
 * # Returns
 *
 * 可直接作为 `persist(..., { storage })` 的存储实现；`name` 即文件里的键。
 */
export function createTauriPersistStorage<S>(file: string = PREFS_FILE): PersistStorage<S> {
  return {
    getItem: async (name) => {
      try {
        const v = await (await getStore(file)).get<StorageValue<S>>(name);
        return v ?? null;
      } catch (e) {
        console.warn(`[prefs] 读取 ${name} 失败，使用默认值`, e);
        return null;
      }
    },
    setItem: async (name, value) => {
      try {
        await (await getStore(file)).set(name, value);
      } catch (e) {
        console.warn(`[prefs] 写入 ${name} 失败`, e);
      }
    },
    removeItem: async (name) => {
      try {
        await (await getStore(file)).delete(name);
      } catch (e) {
        console.warn(`[prefs] 删除 ${name} 失败`, e);
      }
    },
  };
}
