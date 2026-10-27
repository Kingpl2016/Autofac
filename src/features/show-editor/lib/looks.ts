import type { ColorValue, Cue, Look, Param, Preset, Rgb } from "./project";

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

/** 各发光体的显示色（手动覆盖时的近似合成用）。 */
const EMITTER_RGB: Record<string, Rgb> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  white: [255, 255, 255],
  coolWhite: [235, 242, 255],
  warmWhite: [255, 180, 107],
  amber: [255, 191, 0],
  uv: [96, 0, 255],
  lime: [191, 255, 0],
};

/**
 * 颜色值的显示色（近似）：RGB 原样、色温换算、手动覆盖按各发光体颜色叠加。
 *
 * @param c 颜色值。
 * @returns sRGB。
 */
export function colorValueRgb(c: ColorValue): Rgb {
  switch (c.kind) {
    case "rgb":
      return c.rgb;
    case "kelvin":
      return kelvinToRgb(c.kelvin);
    case "manual": {
      const acc = [0, 0, 0];
      for (const [k, v] of Object.entries(c.values)) {
        const e = EMITTER_RGB[k];
        if (!e || !v) continue;
        for (let i = 0; i < 3; i += 1) acc[i] += e[i] * v;
      }
      const peak = Math.max(255, ...acc);
      return acc.map((v) => Math.round((v / peak) * 255)) as Rgb;
    }
  }
}

/**
 * 片段在时间线上的代表色：静态色 / 特效第一色 / 外观颜色层（没有颜色层时为中性灰）。
 *
 * @param cue 片段。
 * @param presets 预设库（外观引用预设时用）。
 * @returns sRGB。
 */
export function clipColor(cue: Cue, presets: readonly Preset[]): Rgb {
  switch (cue.kind) {
    case "static":
      return cue.rgb;
    case "effect":
      return cue.colors[0] ?? [255, 255, 255];
    case "look": {
      const color = paramHead(resolveLook(cue.look, presets).color);
      return color ? colorValueRgb(color) : [160, 160, 160];
    }
    case "scene": {
      const first = cue.entries.find((e) => resolveLook(e.look, presets).color);
      const color = first ? paramHead(resolveLook(first.look, presets).color) : undefined;
      return color ? colorValueRgb(color) : [160, 160, 160];
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
