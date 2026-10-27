import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";
import type { AppearanceSettings, ThemeMode } from "./appearanceSettings";
import { BUILTIN_ACCENTS } from "./presets/builtinPresets";

/** 旧版 `prefs` 里与外观相关的字段。 */
interface LegacyPrefsState {
  theme?: unknown;
  accent?: unknown;
}

/**
 * 把旧版偏好（`prefs` 键里的 `theme` / `accent`）转成新的外观设置。
 * 旧强调色的 id（blue / cyan / green / orange / violet / rose）与内置主色同名，直接映射。
 *
 * @param legacy 旧版 `prefs` 的 `state`。
 * @returns 需要写入新设置的字段；没有可迁移内容时为 null。
 */
export function mapLegacyPrefs(legacy: LegacyPrefsState | null | undefined): Partial<AppearanceSettings> | null {
  if (!legacy) return null;
  const patch: Partial<AppearanceSettings> = {};
  if (legacy.theme === "dark" || legacy.theme === "light") patch.mode = legacy.theme as ThemeMode;
  const accent = BUILTIN_ACCENTS.find((preset) => preset.id === legacy.accent);
  // 旧默认就是 blue：保持“未选择”，继续使用 CSS 里的默认强调色
  if (accent && accent.id !== "blue") patch.accent = { id: accent.id, color: accent.color };
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * 读取旧版偏好里的外观字段（首次运行新外观系统时用于一次性迁移）。
 * 读取失败时返回 null：迁移是尽力而为，不阻塞启动。
 *
 * @returns 需要写入新设置的字段；没有可迁移内容时为 null。
 */
export async function readLegacyAppearance(): Promise<Partial<AppearanceSettings> | null> {
  try {
    const stored = await createTauriPersistStorage<LegacyPrefsState>().getItem("prefs");
    return mapLegacyPrefs(stored?.state);
  } catch {
    return null;
  }
}
