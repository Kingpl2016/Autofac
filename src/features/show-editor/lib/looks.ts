import { DEFAULT_GAMMA, type ColorValue, type Cue, type Look, type Param, type Preset, type Rgb } from "./project";

/**
 * 外观（Look）与参数（Param）的界面辅助：取代表值、合并预设、判断参与的层。
 *
 * 逐帧求值（插值、曲线、分布、混色）只在 show-engine 里实现；这里只服务于时间线色块、
 * 检查器显示等“不需要精确到每一帧”的场景。
 */

/**
 * 参数的代表值：固定值本身、第一帧的值，或曲线的起点。
 *
 * @param p 参数。
 * @returns 代表值；参数缺失时为 `undefined`。
 */
export function paramHead<T>(p: Param<T> | undefined): T | undefined {
  if (!p) return undefined;
  switch (p.kind) {
    case "value":
      return p.value;
    case "keys":
      return p.keys[0]?.value;
    case "curve":
      return p.curve.from as T;
  }
}

/**
 * 包成固定值参数。
 *
 * @param value 值。
 * @returns 固定值参数。
 */
export function fixed<T>(value: T): Param<T> {
  return { kind: "value", value } as Param<T>;
}

/**
 * 外观叠在预设之上：外观里显式写出的层覆盖预设的同名层。
 *
 * @param look 外观。
 * @param presets 工程的预设库。
 * @returns 合并后的外观（不含 `presetId`）；预设不存在时等于外观本身。
 */
export function resolveLook(look: Look, presets: readonly Preset[]): Look {
  const preset = look.presetId ? presets.find((p) => p.id === look.presetId) : undefined;
  const base = preset ? resolveLook(preset.look, []) : {};
  return {
    intensity: look.intensity ?? base.intensity,
    color: look.color ?? base.color,
    attrs: { ...base.attrs, ...look.attrs },
  };
}

/** 色温（K）→ sRGB，仅用于界面色块显示（Tanner Helland 近似，与引擎的发光体换算同源）。 */
export function kelvinToRgb(kelvin: number): Rgb {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  return [clamp(r), clamp(g), clamp(b)];
}

/**
 * 各发光体未校准时的显示色与相对亮度（手动覆盖时合成显示色用），与引擎 `Emitters::with_gamma` 一致：
 * 白 / 冷白为理想白，暖白为 3000K，UV 只有 30% 的亮度。
 */
const EMITTER_RGB: Record<string, { rgb: Rgb; gain: number }> = {
  red: { rgb: [255, 0, 0], gain: 1 },
  green: { rgb: [0, 255, 0], gain: 1 },
  blue: { rgb: [0, 0, 255], gain: 1 },
  white: { rgb: [255, 255, 255], gain: 1 },
  coolWhite: { rgb: [255, 255, 255], gain: 1 },
  warmWhite: { rgb: kelvinToRgb(3000), gain: 1 },
  amber: { rgb: [255, 191, 0], gain: 1 },
  uv: { rgb: [96, 0, 255], gain: 0.3 },
  lime: { rgb: [191, 255, 0], gain: 1 },
};

/**
 * 颜色值的显示色（近似）：RGB 原样、色温换算、手动覆盖按各发光体颜色叠加。
 *
 * 手动覆盖（按发光体直给 DMX）的合成方式与引擎预览一致：各发光体的显示色按 Gamma 解码成线性光、
 * 按输出值叠加，再用 Gamma 的逆编码回显示色。
 *
 * @param c 颜色值。
 * @param gamma 工程 Gamma（只影响手动覆盖的合成）；省略时按新工程默认值。
 * @returns sRGB。
 */
export function colorValueRgb(c: ColorValue, gamma: number = DEFAULT_GAMMA): Rgb {
  switch (c.kind) {
    case "rgb":
      return c.rgb;
    case "kelvin":
      return kelvinToRgb(c.kelvin);
    case "manual": {
      const g = Number.isFinite(gamma) && gamma > 0 ? gamma : DEFAULT_GAMMA;
      const acc = [0, 0, 0];
      for (const [k, v] of Object.entries(c.values)) {
        const e = EMITTER_RGB[k];
        if (!e || !v) continue;
        const amount = Math.min(1, Math.max(0, v));
        for (let i = 0; i < 3; i += 1) acc[i] += amount * e.gain * (e.rgb[i] / 255) ** g;
      }
      // 超过 1 时整体压缩（保持色相），与引擎 `emitted_rgb` 一致
      const peak = Math.max(1, ...acc);
      return acc.map((v) => Math.round((v / peak) ** (1 / g) * 255)) as Rgb;
    }
  }
}

/**
 * 片段在时间线上的代表色：静态色 / 特效第一色 / 外观颜色层（没有颜色层时为中性灰）。
 *
 * @param cue 片段。
 * @param presets 预设库（外观引用预设时用）。
 * @param gamma 工程 Gamma（手动覆盖的颜色合成用）。
 * @returns sRGB。
 */
export function clipColor(cue: Cue, presets: readonly Preset[], gamma: number = DEFAULT_GAMMA): Rgb {
  switch (cue.kind) {
    case "static":
      return cue.rgb;
    case "effect":
      return cue.colors[0] ?? [255, 255, 255];
    case "look": {
      const color = paramHead(resolveLook(cue.look, presets).color);
      return color ? colorValueRgb(color, gamma) : [160, 160, 160];
    }
    case "scene": {
      const first = cue.entries.find((e) => resolveLook(e.look, presets).color);
      const color = first ? paramHead(resolveLook(first.look, presets).color) : undefined;
      return color ? colorValueRgb(color, gamma) : [160, 160, 160];
    }
  }
}

/**
 * 外观参与的层（用于检查器徽标、片段角标）。
 *
 * @param look 外观（已合并预设）。
 * @returns 层名列表：`intensity`、`color` 与各属性键。
 */
export function lookLayers(look: Look): string[] {
  const layers: string[] = [];
  if (look.intensity) layers.push("intensity");
  if (look.color) layers.push("color");
  for (const key of Object.keys(look.attrs ?? {})) layers.push(key);
  return layers;
}
