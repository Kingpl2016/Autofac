import type { ChannelFunction, Emitter, FixtureModel } from "./types";

/**
 * “典型 LED”发光体预设：常见舞台 LED 芯片的近似显示色（sRGB）与白光色温。
 *
 * 取值按常见主波长折算（红约 625 nm、绿约 525 nm、蓝约 460 nm、琥珀约 595 nm、靛蓝约 445 nm），
 * 只修正色相，不改相对亮度（亮度差异因灯而异，需要按实测填写）。UV 只影响预览，不在预设里。
 */
export const TYPICAL_LED: Partial<Record<ChannelFunction, Omit<Emitter, "function">>> = {
  red: { rgb: [255, 24, 0] },
  green: { rgb: [20, 255, 60] },
  blue: { rgb: [24, 0, 255] },
  amber: { rgb: [255, 160, 0] },
  lime: { rgb: [200, 255, 60] },
  indigo: { rgb: [70, 0, 255] },
  white: { kelvin: 6000 },
  coolWhite: { kelvin: 6500 },
  warmWhite: { kelvin: 3000 },
};

/**
 * 给模型的发光体套用预设：只写模型实际有的发光体，已有的相对亮度保留。
 *
 * @param functions 模型的发光体功能（见 `emitterFunctions`）。
 * @param current 当前的校准。
 * @param preset 预设。
 * @returns 新的校准列表；没有可写的发光体时为 `undefined`。
 */
export function applyEmitterPreset(
  functions: readonly ChannelFunction[],
  current: FixtureModel["emitters"],
  preset: Partial<Record<ChannelFunction, Omit<Emitter, "function">>> = TYPICAL_LED,
): Emitter[] | undefined {
  const list: Emitter[] = [];
  for (const fn of functions) {
    const p = preset[fn];
    const old = current?.find((e) => e.function === fn);
    if (!p) {
      if (old) list.push(old);
      continue;
    }
    list.push({ function: fn, ...p, ...(old?.intensity !== undefined ? { intensity: old.intensity } : {}) });
  }
  return list.length > 0 ? list : undefined;
}
