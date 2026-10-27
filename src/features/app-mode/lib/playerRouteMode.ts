import { toast } from "sonner";

import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { appModeSet, stopRecordingForModeChange } from "./api";
import { describeModeError } from "./errors";
import { useAppModeStore } from "../stores/useAppModeStore";

/** 播放器模式是否由“进入节目库 / 节目编辑页”自动进入（只有这样进入的才会在离开时自动退出）。 */
let autoEntered = false;
/** 串行化所有自动切换，避免快速切换页面时两次切换交错。 */
let queue: Promise<void> = Promise.resolve();

/** 当前是否由页面自动进入了播放器模式（测试用）。 */
export function isAutoEntered(): boolean {
  return autoEntered;
}

/** 重置内部状态（测试用）。 */
export function resetPlayerRouteMode(): void {
  autoEntered = false;
  queue = Promise.resolve();
}

/**
 * 执行一次自动切换（带忙碌态与错误提示；不弹确认、不跳转、不弹成功提示，只做读屏播报）。
 *
 * @param target 目标模式。
 */
async function switchQuietly(target: "player" | "live"): Promise<boolean> {
  const ui = useAppModeStore.getState();
  ui.setTransitioning(true);
  try {
    // 与进入播放器模式一样：先停止并保存进行中的录制（结果由全局 recording:finished 监听提示）
    if (target === "player" && useEngineStatusStore.getState().recording) {
      await stopRecordingForModeChange();
    }
    const status = await appModeSet(target);
    // 立即反映到状态 store（app:mode 事件稍后才到），紧接着的下一次同步据此判断，不会重复切换
    useEngineStatusStore.getState().patch({ appMode: status.mode, receivers: status.receivers, sender: status.sender });
    announce(i18n.t(target === "player" ? "mode.enteredPlayer" : "mode.leftPlayer"));
    return true;
  } catch (e: unknown) {
    toast.error(describeModeError(e, i18n.t));
    return false;
  } finally {
    useAppModeStore.getState().setTransitioning(false);
  }
}

/**
 * 立即（不确认）进入播放器模式，并记为“由页面自动进入”。已在播放器模式时什么也不做。
 *
 * @returns 结束后是否处于播放器模式。
 */
export function enterPlayerModeNow(): Promise<boolean> {
  const run = queue.then(async () => {
    if (useEngineStatusStore.getState().appMode === "player") return true;
    const ok = await switchQuietly("player");
    if (ok) autoEntered = true;
    return ok;
  });
  queue = run.then(() => undefined);
  return run;
}

/**
 * 按当前页面同步应用模式：
 *
 * - 进入声明了 `playerMode` 的页面（节目库、节目编辑）：实时模式下直接进入播放器模式；
 * - 离开这类页面到普通页面：若播放器模式是自动进入的，就退回实时模式（会卸载打开的节目）；
 *   去的是播放器页则保留播放器模式，此后视为用户主动进入，不再自动退出。
 *
 * 用户自己进入的播放器模式（顶栏开关、播放器页、启动即进入）不会被自动退出。
 *
 * @param wantsPlayer 当前页面是否要求播放器模式。
 * @param onPlayerPage 当前页面是否为播放器页。
 */
export function syncPlayerRouteMode(wantsPlayer: boolean, onPlayerPage: boolean): Promise<void> {
  if (wantsPlayer) return enterPlayerModeNow().then(() => undefined);
  queue = queue.then(async () => {
    if (!autoEntered) return;
    autoEntered = false;
    if (onPlayerPage || useEngineStatusStore.getState().appMode !== "player") return;
    await switchQuietly("live");
  });
  return queue;
}
