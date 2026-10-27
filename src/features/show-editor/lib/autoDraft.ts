import { placeFixtures } from "../stage/stageGeometry";
import { buildAttrEffect, type AttrEffectId } from "./attrEffects";
import { addLookCue } from "./cueOps";
import { availableAttrs } from "./layers";
import type { Look, Rgb, ShowProject, Spread } from "./project";
import { createGroup } from "./ops";
import { energyTier, TIER_COLORS, type EnergyTier } from "./sections";
import { snapToFrame } from "./time";

/**
 * 一键生成灯光草稿：按段落（没有段落时按 8 小节切分）与段落能量，给所有灯具编排一套随音乐起伏的基础灯光，
 * 摇头灯另配一条动作轨道。生成的都是普通的外观片段，可以继续逐个修改。
 *
 * 编排规则（模板方法：先 `planDraft` 出计划，再 `applyDraft` 写入）：
 *
 * | 能量 | 灯光（全部灯具分组） | 动作（摇头灯分组） |
 * | --- | --- | --- |
 * | 安静 | 静态铺色 60%，慢淡入；或慢呼吸 | 不动 |
 * | 中等 | 2 拍一次的波浪；或 1 拍一次的追逐 | 左右摇摆 |
 * | 高能 | 1 拍追逐（快歌半拍不追，避免过快）；或彩虹 | 画圆 |
 *
 * 颜色按段落依次取所选配色；所有强度闪烁都不超过频闪安全频率。
 */

/** 配色方案。 */
export type DraftPalette = "warm" | "cool" | "neon" | "mono";

/** 各配色方案的颜色（存进工程的数据色）。 */
export const DRAFT_PALETTES: Record<DraftPalette, Rgb[]> = {
  warm: [
    [255, 120, 20],
    [255, 40, 60],
    [255, 190, 60],
    [220, 30, 120],
  ],
  cool: [
    [30, 110, 255],
    [0, 220, 200],
    [120, 60, 255],
    [40, 200, 255],
  ],
  neon: [
    [255, 0, 180],
    [0, 255, 140],
    [140, 0, 255],
    [255, 230, 0],
  ],
  mono: [[255, 255, 255]],
};

/** 草稿选项。 */
export interface DraftOptions {
  palette: DraftPalette;
  /** 整体亮度上限 0~100 */
  intensity: number;
  /** 摇头灯是否加动作轨道 */
  movement: boolean;
}

/** 默认选项。 */
export const DEFAULT_DRAFT: DraftOptions = { palette: "warm", intensity: 100, movement: true };

/** 灯光编排方式。 */
export type DraftLightKind = "wash" | "breathe" | "wave" | "chase" | "rainbow";
/** 动作编排方式。 */
export type DraftMoveKind = "none" | "sweep" | "circle";

/** 计划里的一段。 */
export interface DraftItem {
  startMs: number;
  endMs: number;
  tier: EnergyTier;
  light: DraftLightKind;
  move: DraftMoveKind;
  color: Rgb;
}

/** 没有段落时按多少小节切分。 */
const CHUNK_BARS = 8;
/** 段落短于这个长度（毫秒）时不编排。 */
const MIN_ITEM_MS = 500;

/**
 * 有 Pan 的灯具（摇头灯）。
 *
 * @param project 工程（只读）。
 * @returns 灯具 id。
 */
export function moverIds(project: Pick<ShowProject, "fixtures" | "fixtureModels">): string[] {
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  return project.fixtures.filter((f) => availableAttrs(models.get(f.modelId), f.modeId).some((a) => a.key === "pan")).map((f) => f.id);
}

/**
 * 编排计划（纯函数）：每个段落一段，按能量档位选灯光 / 动作，同档位相邻段落交替两种方式。
 *
 * @param project 工程（只读，需要节拍；段落为空时按 8 小节切分整首）。
 * @param options 选项。
 * @returns 计划；没有节拍时为空。
 */
export function planDraft(project: Pick<ShowProject, "tempo" | "sections" | "durationMs">, options: DraftOptions): DraftItem[] {
  const tempo = project.tempo;
  if (!tempo || tempo.bpm <= 0) return [];
  // 已有段落用颜色判断能量（节拍分析生成的段落颜色对应档位），否则按 8 小节切分、按位置起伏
  const spans =
    project.sections.length > 0
      ? [...project.sections].sort((a, b) => a.startMs - b.startMs).map((s) => ({ startMs: s.startMs, endMs: s.endMs, tier: tierOfSection(s) }))
      : chunks(project.durationMs, tempo.offsetMs, (60_000 / tempo.bpm) * tempo.beatsPerBar * CHUNK_BARS);
  const palette = DRAFT_PALETTES[options.palette];
  const seen: Record<EnergyTier, number> = { low: 0, mid: 0, high: 0 };
  const items: DraftItem[] = [];
  spans.forEach((s) => {
    const startMs = snapToFrame(Math.max(0, s.startMs));
    const endMs = snapToFrame(Math.min(project.durationMs, s.endMs));
    if (endMs - startMs < MIN_ITEM_MS) return;
    const tier = s.tier;
    const alt = seen[tier] % 2 === 1;
    seen[tier] += 1;
    const light: DraftLightKind =
      tier === "low" ? (alt ? "breathe" : "wash") : tier === "mid" ? (alt ? "chase" : "wave") : alt ? "rainbow" : "chase";
    const move: DraftMoveKind = !options.movement || tier === "low" ? "none" : tier === "mid" ? "sweep" : "circle";
    items.push({ startMs, endMs, tier, light, move, color: palette[items.length % palette.length] });
  });
  return items;
}

/** 段落颜色 → 能量档位：取最接近的档位色（节拍分析生成的段落按档位着色；手建的默认是中等色）。 */
function tierOfSection(s: { color: Rgb }): EnergyTier {
  const dist = (c: Rgb) => c.reduce((sum, v, i) => sum + (v - s.color[i]) ** 2, 0);
  return (Object.keys(TIER_COLORS) as EnergyTier[]).reduce((best, tier) =>
    dist(TIER_COLORS[tier]) < dist(TIER_COLORS[best]) ? tier : best,
  );
}

/** 没有段落时的起伏（按在整首里的位置 0~1）：开头安静、前半中等、后半高能、结尾回落。 */
function shapeTier(x: number): EnergyTier {
  return energyTier(x < 0.15 ? 0.1 : x > 0.9 ? 0.3 : x > 0.5 ? 0.9 : 0.5);
}

/** 按强拍对齐、每 `lengthMs` 切一段（开头不足一段的零头单独成段）。 */
function chunks(durationMs: number, offsetMs: number, lengthMs: number) {
  const first = ((offsetMs % lengthMs) + lengthMs) % lengthMs;
  const edges = [0];
  for (let t = first; t < durationMs; t += lengthMs) if (t > 0) edges.push(t);
  edges.push(durationMs);
  const n = edges.length - 1;
  return Array.from({ length: n }, (_, i) => ({
    startMs: edges[i],
    endMs: edges[i + 1],
    tier: shapeTier(n <= 1 ? 0.5 : i / (n - 1)),
  }));
}

/** 灯光段的外观。 */
function lightLook(item: DraftItem, members: number, project: Pick<ShowProject, "tempo">, cap: number): { look: Look; spread?: Spread } {
  const lengthMs = item.endMs - item.startMs;
  const color = { kind: "value" as const, value: { kind: "rgb" as const, rgb: [...item.color] as Rgb } };
  const effect = (id: AttrEffectId, beats: number) =>
    buildAttrEffect(id, { period: { kind: "beats", beats }, size: cap, lengthMs, members }, project.tempo);
  switch (item.light) {
    case "wash":
      return { look: { intensity: { kind: "value", value: Math.round(cap * 0.6) }, color } };
    case "breathe": {
      const e = effect("intensityWave", 8);
      return { look: { ...e.look, color } };
    }
    case "wave": {
      const e = effect("intensityWave", 2);
      return { look: { ...e.look, color }, spread: e.spread };
    }
    case "chase": {
      // 快歌（>140 BPM）两拍一轮，避免追逐过快
      const e = effect("intensityChase", (project.tempo?.bpm ?? 120) > 140 ? 2 : 1);
      return { look: { ...e.look, color }, spread: e.spread };
    }
    case "rainbow": {
      const e = effect("rainbow", 8);
      return { look: { ...e.look, intensity: { kind: "value", value: cap } }, spread: e.spread };
    }
  }
}

/** 草稿写入结果。 */
export interface DraftResult {
  /** 新建的灯光片段 */
  cueIds: string[];
  /** 新建的分组 */
  groupIds: string[];
}

/**
 * 写入草稿：新建“全部灯具”分组（按舞台从左到右排序）与其轨道，逐段放灯光片段；
 * 有两台以上摇头灯且开启动作时，再建“摇头灯”分组放动作片段。
 *
 * @param d 工程草稿。
 * @param items 计划（[`planDraft`]）。
 * @param options 选项。
 * @param names 分组名。
 * @returns 新建的片段与分组。
 */
export function applyDraft(
  d: ShowProject,
  items: readonly DraftItem[],
  options: DraftOptions,
  names: { all: string; movers: string },
): DraftResult {
  const result: DraftResult = { cueIds: [], groupIds: [] };
  if (items.length === 0 || d.fixtures.length === 0) return result;
  const placed = placeFixtures(d.fixtures, d.stage);
  const byX = [...d.fixtures].sort((a, b) => (placed.get(a.id)?.x ?? 0) - (placed.get(b.id)?.x ?? 0)).map((f) => f.id);
  const cap = Math.min(100, Math.max(0, options.intensity));

  const trackFor = (ids: string[], name: string): string | null => {
    if (ids.length === 1) {
      // 只有一台灯：用它自己的轨道
      return d.tracks.find((t) => t.target.kind === "fixture" && t.target.id === ids[0])?.id ?? null;
    }
    const groupId = createGroup(d, name, ids);
    if (!groupId) return null;
    result.groupIds.push(groupId);
    return d.tracks.find((t) => t.target.kind === "group" && t.target.id === groupId)?.id ?? null;
  };

  const lights = trackFor(byX, names.all);
  if (lights) {
    for (const item of items) {
      const { look, spread } = lightLook(item, byX.length, d, cap);
      const id = addLookCue(d, lights, item.startMs, look, item.endMs - item.startMs, spread);
      if (!id) continue;
      // 段落之间柔和过渡：淡入一拍（不超过片段的四分之一）
      const cue = d.cues.find((c) => c.id === id);
      const beatMs = d.tempo ? 60_000 / d.tempo.bpm : 500;
      if (cue) cue.fadeInMs = Math.round(Math.min(beatMs, (cue.endMs - cue.startMs) / 4));
      result.cueIds.push(id);
    }
  }

  const movers = options.movement ? moverIds(d).sort((a, b) => byX.indexOf(a) - byX.indexOf(b)) : [];
  if (movers.length >= 2 && items.some((i) => i.move !== "none")) {
    const moves = trackFor(movers, names.movers);
    if (moves) {
      for (const item of items) {
        if (item.move === "none") continue;
        const e = buildAttrEffect(
          item.move === "circle" ? "circle" : "panSweep",
          { period: { kind: "beats", beats: item.move === "circle" ? 4 : 8 }, size: item.move === "circle" ? 0.15 : 0.2, lengthMs: item.endMs - item.startMs, members: movers.length },
          d.tempo,
        );
        // 动作轨道只管位置：去掉强度层，由灯光轨道决定亮度
        const look: Look = { attrs: e.look.attrs };
        const id = addLookCue(d, moves, item.startMs, look, item.endMs - item.startMs, e.spread);
        if (id) result.cueIds.push(id);
      }
    }
  }
  return result;
}
