import type { AttrEffectId } from "./attrEffects";
import { addLookCue, DEFAULT_CUE_MS, normalizeFades, type CueStyle } from "./cueOps";
import { rgbToHsv } from "./colorMath";
import type { CueTemplate } from "./cueTemplates";
import type { EffectPreset } from "./effectPresets";
import { trackCapabilities, type FixtureCapability, type TrackCapabilities } from "./fixtureProfile";
import type { ColorValue, EffectId, Look, Rgb, ShowProject } from "./project";

/**
 * 按灯具类型决定的新片段默认外观，以及素材（模板、特效）对所选轨道是否适用。
 *
 * - 调光灯只写强度层；能混色 / 调色温的灯加颜色层（白光）；摇头灯加 Pan / Tilt（居中）。
 * - 素材需要某项能力（例如彩色模板需要混色、画圆需要 Pan / Tilt）；轨道上没有一台灯支持时“不适用”，
 *   只有部分灯支持时“部分适用”（不支持的灯忽略那一层）。
 */

/** 适用程度。 */
export type ApplyLevel = "full" | "partial" | "none";

/** 素材对目标轨道的适用情况。 */
export interface Applicability {
  level: ApplyLevel;
  /** 素材需要的能力 */
  needs: FixtureCapability;
  /** 支持的灯具数 / 全部灯具数（所有目标轨道合计） */
  supported: number;
  total: number;
}

/** 饱和度低于这个值的 RGB 模板算作白光（调光灯也能用）。 */
const WHITE_SATURATION = 0.15;

/** 新建片段的样式：模板给的颜色（RGB 或色温）、亮度、淡入淡出与长度。 */
export type TemplateStyle = Partial<CueStyle> & { lengthMs?: number; color?: ColorValue };

/** 只用强度就能表现的经典特效（颜色只是点缀）。 */
const INTENSITY_EFFECTS: ReadonlySet<EffectId> = new Set<EffectId>(["breathe", "chase", "pulse", "sparkle", "strobe"]);

/** 属性特效需要的能力。 */
const ATTR_EFFECT_NEEDS: Record<AttrEffectId, FixtureCapability> = {
  circle: "position",
  figure8: "position",
  panSweep: "position",
  tiltSweep: "position",
  intensityWave: "intensity",
  intensityChase: "intensity",
  strobe: "intensity",
  rainbow: "mixing",
};

/**
 * 模板需要的能力。
 *
 * @param template 模板。
 * @returns 色温模板和接近白色的 RGB 模板为强度（调光灯也能用），其余彩色为混色。
 */
export function templateNeeds(template: Pick<CueTemplate, "color">): FixtureCapability {
  if (template.color.kind === "kelvin") return "intensity";
  return rgbToHsv(template.color.rgb).s < WHITE_SATURATION ? "intensity" : "mixing";
}

/**
 * 经典特效需要的能力。
 *
 * @param preset 特效预设。
 * @returns 呼吸 / 追逐 / 脉冲 / 闪烁 / 频闪为强度，其余（彩虹、擦除、渐变）为混色。
 */
export function effectNeeds(preset: Pick<EffectPreset, "effect">): FixtureCapability {
  return INTENSITY_EFFECTS.has(preset.effect) ? "intensity" : "mixing";
}

/**
 * 属性特效需要的能力。
 *
 * @param id 属性特效。
 * @returns 能力。
 */
export function attrEffectNeeds(id: AttrEffectId): FixtureCapability {
  return ATTR_EFFECT_NEEDS[id];
}

/**
 * 素材对一组轨道的适用情况（按灯具台数合计）。没有灯具的轨道不计。
 *
 * @param caps 每条目标轨道的能力汇总。
 * @param needs 素材需要的能力。
 * @returns 适用情况；没有任何灯具时为“不适用”。
 */
export function applicability(caps: readonly TrackCapabilities[], needs: FixtureCapability): Applicability {
  let supported = 0;
  let total = 0;
  for (const c of caps) {
    supported += c.counts.get(needs) ?? 0;
    total += c.total;
  }
  const level: ApplyLevel = supported === 0 ? "none" : supported === total ? "full" : "partial";
  return { level, needs, supported, total };
}

/**
 * 素材对单条轨道是否可用（拖放、点击添加时逐条检查）。
 *
 * @param project 工程（只读）。
 * @param trackId 轨道。
 * @param needs 需要的能力。
 * @returns 至少一台灯支持时为 `true`；轨道不存在或没有灯具时为 `false`。
 */
export function trackSupports(
  project: Pick<ShowProject, "tracks" | "fixtures" | "fixtureModels" | "groups" | "cues">,
  trackId: string,
  needs: FixtureCapability,
): boolean {
  const track = project.tracks.find((t) => t.id === trackId);
  return track !== undefined && applicability([trackCapabilities(project, track)], needs).level !== "none";
}

/**
 * 新片段的默认外观（按轨道上灯具的能力）。
 *
 * @param caps 轨道能力。
 * @param color 颜色（模板给定的 RGB 或色温；省略为白光）。
 * @returns 外观：强度 100；能混色或调色温时加颜色层；能动时加居中的 Pan / Tilt。
 */
export function defaultLook(caps: TrackCapabilities, color?: Rgb | ColorValue): Look {
  const look: Look = { intensity: { kind: "value", value: 100 } };
  if (caps.any.has("mixing") || caps.any.has("colorTemp")) {
    const value: ColorValue = !color
      ? { kind: "rgb", rgb: [255, 255, 255] }
      : Array.isArray(color)
        ? { kind: "rgb", rgb: [...color] as Rgb }
        : structuredClone(color);
    look.color = { kind: "value", value };
  }
  if (caps.any.has("position")) {
    look.attrs = { pan: { kind: "value", value: 0.5 }, tilt: { kind: "value", value: 0.5 } };
  }
  return look;
}

/**
 * 在轨道上新建一个按灯具类型给默认值的外观片段（双击、模板、右键“新建”共用）。
 *
 * @param d 工程草稿。
 * @param trackId 轨道（场景轨道不新建）。
 * @param timeMs 起点。
 * @param style 模板给的颜色（`color` 优先，其次 `rgb`）、亮度、淡入淡出与长度。
 * @returns 新片段 id；放不下或轨道不可用时为 `null`。
 */
export function addDefaultLook(
  d: ShowProject,
  trackId: string,
  timeMs: number,
  style: TemplateStyle = {},
): string | null {
  const track = d.tracks.find((t) => t.id === trackId);
  if (!track || track.target.kind === "scene") return null;
  const look = defaultLook(trackCapabilities(d, track), style.color ?? style.rgb);
  const id = addLookCue(d, trackId, timeMs, look, style.lengthMs ?? DEFAULT_CUE_MS);
  const cue = id ? d.cues.find((c) => c.id === id) : undefined;
  if (cue) {
    if (style.brightness !== undefined) cue.brightness = style.brightness;
    if (style.fadeInMs !== undefined) cue.fadeInMs = style.fadeInMs;
    if (style.fadeOutMs !== undefined) cue.fadeOutMs = style.fadeOutMs;
    if (style.easing !== undefined) cue.easing = style.easing;
    normalizeFades(cue);
  }
  return id;
}
