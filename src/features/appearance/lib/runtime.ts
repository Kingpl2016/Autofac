import { combineLatest, fromEvent, Observable, type Subscription } from "rxjs";

import { applyAppearance } from "./applyAppearance";
import type { AppearanceSettings, ResolvedMode } from "./appearanceSettings";
import { computeAttrs } from "./computeAttrs";
import { computeVars } from "./computeVars";
import { readLegacyAppearance } from "./legacyMigration";
import { writeAppearanceSnapshot } from "./snapshot";
import { systemMode$ } from "./systemTheme";
import { appearanceStorage, APPEARANCE_STORAGE_KEY, useAppearanceStore } from "../stores/useAppearanceStore";

/** 外观设置的变化流：订阅时先发出当前值，之后每次 store 变化都同步发出（View Transition 依赖同步应用）。 */
const settings$ = new Observable<AppearanceSettings>((subscriber) => {
  subscriber.next(useAppearanceStore.getState());
  return useAppearanceStore.subscribe((state) => subscriber.next(state));
});

/**
 * 从磁盘读回外观设置；首次运行（磁盘上还没有）时，一次性迁移旧版偏好里的主题与强调色。
 * 读取失败时保持默认设置，不阻塞启动。
 */
export async function loadAppearance(): Promise<void> {
  const hadStored = (await appearanceStorage.getItem(APPEARANCE_STORAGE_KEY)) != null;
  await useAppearanceStore.persist.rehydrate();
  if (hadStored) return;
  const legacy = await readLegacyAppearance();
  if (legacy) useAppearanceStore.getState().update(legacy);
}

/**
 * 开始把外观设置同步到 `<html>`：设置变化或（`跟随系统` 时）系统明暗变化都会立即重新应用，
 * 同时刷新防闪烁快照。
 *
 * @param root 通常是 `document.documentElement`。
 * @returns 订阅；退订即停止同步。
 */
export function startAppearanceSync(root: HTMLElement = document.documentElement): Subscription {
  return combineLatest([settings$, systemMode$]).subscribe(([settings, system]) => {
    const resolved: ResolvedMode = settings.mode === "system" ? system : settings.mode;
    applyAppearance(root, computeVars(settings), computeAttrs(settings), resolved);
    writeAppearanceSnapshot(settings);
  });
}

/**
 * 窗口获得焦点时重新读取磁盘上的设置。
 *
 * 第二个窗口（如信号检测器）自己的内存状态不会随主窗口里的切换而变，获得焦点时重读一次即可追上，
 * 不需要额外的跨窗口事件。
 *
 * @returns 订阅；退订即停止。
 */
export function rehydrateOnFocus(): Subscription {
  return fromEvent(window, "focus").subscribe(() => void useAppearanceStore.persist.rehydrate());
}
