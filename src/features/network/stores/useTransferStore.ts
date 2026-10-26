import { create } from "zustand";

import type { TransferHandle } from "../lib/api";
import { toNetError, type NetError } from "../lib/errors";
import type { Progress } from "../lib/types";

/** 传输种类。 */
export type TransferKind = "upload" | "download" | "ota";

/** 传输状态。 */
export type TransferState = "running" | "done" | "failed" | "cancelled";

/** 一条传输记录。 */
export interface TransferItem {
  id: string;
  kind: TransferKind;
  deviceId: string;
  /** 展示名（文件名） */
  label: string;
  state: TransferState;
  progress: Progress | null;
  error: NetError | null;
  startedAt: number;
  cancel: () => void;
  /** 失败 / 取消后重试（由发起方提供） */
  retry?: () => void;
}

/** 传输的元信息。 */
export interface TransferMeta {
  kind: TransferKind;
  deviceId: string;
  label: string;
  /** 失败 / 取消后重新发起同一传输 */
  retry?: () => void;
}

interface TransferStoreState {
  items: TransferItem[];
  /**
   * 启动并跟踪一次传输。
   *
   * # Arguments
   *
   * * `meta` - 传输元信息。
   * * `start` - 创建传输的函数，收到用于上报进度的回调。
   *
   * # Returns
   *
   * 传输结果；失败或取消时以原错误 reject（调用方按需忽略取消）。
   */
  run: <T>(meta: TransferMeta, start: (onProgress: (p: Progress) => void) => TransferHandle<T>) => Promise<T>;
  /** 移除一条已结束的记录。 */
  dismiss: (id: string) => void;
  /** 清除所有已结束的记录。 */
  clearFinished: () => void;
}

/**
 * 跨页面存活的传输队列：切换 Tab / 设备时进度不丢失。
 */
export const useTransferStore = create<TransferStoreState>()((set) => {
  const patch = (id: string, change: Partial<TransferItem>) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...change } : i)) }));

  return {
    items: [],

    run: async (meta, start) => {
      let id = "";
      const handle = start((progress) => {
        if (id) patch(id, { progress });
      });
      id = handle.id;
      const item: TransferItem = {
        ...meta,
        id,
        state: "running",
        progress: null,
        error: null,
        startedAt: Date.now(),
        cancel: handle.cancel,
      };
      set((s) => ({ items: [item, ...s.items] }));
      try {
        const result = await handle.promise;
        set((s) => ({
          items: s.items.map((i) =>
            i.id === id
              ? { ...i, state: "done", progress: i.progress ? { ...i.progress, done: i.progress.total } : null }
              : i,
          ),
        }));
        return result;
      } catch (e) {
        const error = toNetError(e);
        patch(id, { state: error.code === "cancelled" ? "cancelled" : "failed", error });
        throw e;
      }
    },

    dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id || i.state === "running") })),

    clearFinished: () => set((s) => ({ items: s.items.filter((i) => i.state === "running") })),
  };
});
