import { create } from "zustand";

import type { AppModeName } from "@/shared/stores/engineStatusStore";

/** 一次需要用户确认的模式切换请求。 */
export interface ModeRequest {
  /** 目标模式 */
  target: AppModeName;
  /**
   * 自定义的“执行切换”方式。
   *
   * 例如从节目库打开节目：后端 `player_open` 会自动进入播放器模式，
   * 此时传入 `() => playerOpen(path)`，对话框负责确认、停止录制、忙碌态与错误提示。
   * 省略则直接调用 `app_mode_set`。
   */
  run?: () => Promise<unknown>;
  /**
   * 失败时的文案：返回 `undefined` 则回落到通用的模式切换错误文案。
   * 让发起方（例如节目库）能把“节目打不开”说得比“切换模式失败”更具体。
   */
  describeError?: (e: unknown) => string | undefined;
}

interface ModeDialogState {
  /** 待确认的请求；`null` 表示对话框关闭 */
  request: ModeRequest | null;
  open: (request: ModeRequest) => void;
  close: () => void;
}

/** 模式切换确认对话框的状态（对话框只在布局里挂载一次，任何入口都可以请求打开）。 */
export const useModeDialogStore = create<ModeDialogState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
