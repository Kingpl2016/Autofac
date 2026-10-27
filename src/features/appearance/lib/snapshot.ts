import type { AppearanceSettings, ThemeMode } from "./appearanceSettings";
import { computeAttrs, type AppearanceAttrs } from "./computeAttrs";
import { computeVars, type AppearanceVars } from "./computeVars";

/**
 * 防闪烁快照在 `localStorage` 里的键。
 * `index.html` 与 `signal-checker.html` 里的内联脚本使用同一个键（有测试保证两边一致）。
 */
export const APPEARANCE_SNAPSHOT_KEY = "art-net-studio:appearance";

/** 同步写入 `localStorage` 的快照：内联脚本在首次绘制前据此还原明暗、CSS 变量与 data 属性。 */
export interface AppearanceSnapshot {
  /** 用户选择的模式（`system` 需要在读取时再解析）。 */
  mode: ThemeMode;
  /** 折算好的明暗两套 CSS 变量。 */
  vars: AppearanceVars;
  /** 折算好的 data 属性（键为 dataset 驼峰写法）。 */
  attrs: AppearanceAttrs;
}

/**
 * 写入防闪烁快照。存储不可用（隐私模式、配额）时静默忽略：快照只是首屏优化，不影响功能。
 *
 * @param settings 当前外观设置。
 */
export function writeAppearanceSnapshot(settings: AppearanceSettings): void {
  try {
    const snapshot: AppearanceSnapshot = {
      mode: settings.mode,
      vars: computeVars(settings),
      attrs: computeAttrs(settings),
    };
    localStorage.setItem(APPEARANCE_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // 忽略
  }
}
