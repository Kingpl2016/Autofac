import {
  modelProfile,
  type FixtureCapability,
  type FixtureModel,
  type FixtureProfile,
  type FixtureType,
} from "@/features/fixtures";
import { parseRef } from "./fixtureRef";
import { ATTR_KEYS, attrGroup, availableAttrs, type AttrInfo } from "./layers";
import { trackFixtureIds } from "./ops";
import type { AttrKey, Look, ShowProject, Track } from "./project";

/**
 * 节目编辑器的能力汇总：单台灯具的画像来自灯具库（`modelProfile`），
 * 这里按轨道 / 一组灯具汇总，时间线据此显示 / 过滤片段，检查器只显示支持的属性组。
 */

export type { FixtureCapability, FixtureProfile, FixtureType };

/**
 * 推断一台灯具（模型的某个模式）的能力（委托给灯具库的 `modelProfile`）。
 *
 * @param model 模型；缺失时视为没有能力。
 * @param modeId 模式。
 * @returns 类型与能力。
 */
export function fixtureProfile(model: FixtureModel | undefined, modeId?: string): FixtureProfile {
  return modelProfile(model, modeId);
}

/** 灯具引用解析出的模型、模式与像素号。 */
interface ResolvedRef {
  model: FixtureModel | undefined;
  modeId: string | undefined;
  /** 像素号；整灯为 `undefined` */
  head: number | undefined;
}

/**
 * 解析灯具引用（整灯或像素）。
 *
 * @returns 灯具不存在时为 `null`。
 */
function resolveRef(
  project: Pick<ShowProject, "fixtures">,
  models: ReadonlyMap<string, FixtureModel>,
  ref: string,
): ResolvedRef | null {
  const { fixtureId, head } = parseRef(ref);
  const f = project.fixtures.find((x) => x.id === fixtureId);
  if (!f) return null;
  return { model: models.get(f.modelId), modeId: f.modeId, head: head ?? undefined };
}

/** 一条轨道（其上全部灯具）的能力汇总。 */
export interface TrackCapabilities {
  /** 灯具数 */
  total: number;
  /** 至少一台支持的能力 */
  any: ReadonlySet<FixtureCapability>;
  /** 全部支持的能力（没有灯具时为空） */
  all: ReadonlySet<FixtureCapability>;
  /** 每项能力有几台支持 */
  counts: ReadonlyMap<FixtureCapability, number>;
  /** 出现的灯具类型（按台数从多到少） */
  types: readonly FixtureType[];
}

/**
 * 汇总一组灯具的能力。
 *
 * @param project 工程（只读）。
 * @param fixtureIds 灯具。
 * @returns 汇总。
 */
export function fixturesCapabilities(
  project: Pick<ShowProject, "fixtures" | "fixtureModels">,
  fixtureIds: readonly string[],
): TrackCapabilities {
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const counts = new Map<FixtureCapability, number>();
  const typeCounts = new Map<FixtureType, number>();
  let total = 0;
  for (const id of fixtureIds) {
    const r = resolveRef(project, models, id);
    if (!r) continue;
    total += 1;
    const p = modelProfile(r.model, r.modeId, r.head);
    for (const c of p.caps) counts.set(c, (counts.get(c) ?? 0) + 1);
    typeCounts.set(p.type, (typeCounts.get(p.type) ?? 0) + 1);
  }
  const any = new Set(counts.keys());
  const all = new Set(total > 0 ? [...counts].filter(([, n]) => n === total).map(([c]) => c) : []);
  const types = [...typeCounts].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  return { total, any, all, counts, types };
}

/**
 * 轨道的能力汇总（灯具轨道为一台，分组轨道为全部成员，场景轨道为片段里出现的灯具）。
 *
 * @param project 工程（只读）。
 * @param track 轨道。
 * @returns 汇总。
 */
export function trackCapabilities(
  project: Pick<ShowProject, "fixtures" | "fixtureModels" | "groups" | "cues">,
  track: Track,
): TrackCapabilities {
  return fixturesCapabilities(project, trackFixtureIds(project, track));
}

/** 片段上显示的属性徽标（强度每个片段都有，不显示）。 */
export type LayerBadge = "color" | "position" | "beam" | "focus" | "control";

/** 徽标的显示顺序。 */
const BADGE_ORDER: readonly LayerBadge[] = ["color", "position", "beam", "focus", "control"];

/**
 * 外观里出现的属性组（时间线片段上的徽标）。引用预设的层不展开。
 *
 * @param look 外观。
 * @returns 属性组（按固定顺序）。
 */
export function lookBadges(look: Look): LayerBadge[] {
  const set = new Set<LayerBadge>();
  if (look.color) set.add("color");
  for (const key of Object.keys(look.attrs ?? {}) as AttrKey[]) {
    if (!look.attrs?.[key]) continue;
    const g = attrGroup(key);
    if (g !== "intensity") set.add(g);
  }
  return BADGE_ORDER.filter((b) => set.has(b));
}

/** 一组灯具对外观各层的支持情况。 */
export interface LayerSupport {
  caps: TrackCapabilities;
  /** 每个属性有几台灯支持 */
  attrs: ReadonlyMap<AttrKey, number>;
}

/**
 * 一组灯具对外观各层的支持情况。
 *
 * @param project 工程（只读）。
 * @param fixtureIds 灯具。
 * @returns 能力汇总与按属性的支持台数。
 */
export function layerSupport(
  project: Pick<ShowProject, "fixtures" | "fixtureModels">,
  fixtureIds: readonly string[],
): LayerSupport {
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const attrs = new Map<AttrKey, number>();
  for (const id of fixtureIds) {
    const r = resolveRef(project, models, id);
    if (!r) continue;
    for (const a of availableAttrs(r.model, r.modeId, r.head)) attrs.set(a.key, (attrs.get(a.key) ?? 0) + 1);
  }
  return { caps: fixturesCapabilities(project, fixtureIds), attrs };
}

/**
 * 外观里没有任何一台灯支持的层（时间线片段上的警告点、检查器提示）。
 *
 * @param look 外观。
 * @param support 轨道上灯具的支持情况。
 * @returns 层键：`intensity`、`color` 或属性键；没有灯具时为空（不报警）。
 */
export function unsupportedLayers(look: Look, support: LayerSupport): ("intensity" | "color" | AttrKey)[] {
  if (support.caps.total === 0) return [];
  const out: ("intensity" | "color" | AttrKey)[] = [];
  if (look.intensity && !support.caps.any.has("intensity")) out.push("intensity");
  if (look.color && !supportsColor(support.caps)) out.push("color");
  for (const key of Object.keys(look.attrs ?? {}) as AttrKey[]) {
    if (look.attrs?.[key] && !support.attrs.get(key)) out.push(key);
  }
  return out;
}

/**
 * 能否表现颜色层（混色、调色温或颜色轮）。
 *
 * @param caps 能力汇总。
 * @returns 至少一台支持时为 `true`。
 */
export function supportsColor(caps: Pick<TrackCapabilities, "any">): boolean {
  return caps.any.has("mixing") || caps.any.has("colorTemp") || caps.any.has("colorWheel");
}

/**
 * 支持颜色层的灯具台数（取混色 / 调色温 / 颜色轮里支持最多的一项，近似值）。
 *
 * @param caps 能力汇总。
 * @returns 台数。
 */
export function colorSupportCount(caps: Pick<TrackCapabilities, "counts">): number {
  return Math.max(caps.counts.get("mixing") ?? 0, caps.counts.get("colorTemp") ?? 0, caps.counts.get("colorWheel") ?? 0);
}

/**
 * 一组灯具可编辑的属性层（并集：任一台有的功能都列出，带支持台数；通道信息取第一台有该功能的灯）。
 *
 * @param project 工程（只读）。
 * @param fixtureIds 灯具。
 * @returns 按功能表顺序的属性。
 */
export function availableAttrsOf(
  project: Pick<ShowProject, "fixtures" | "fixtureModels">,
  fixtureIds: readonly string[],
): (AttrInfo & { supported: number })[] {
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const byKey = new Map<AttrKey, AttrInfo & { supported: number }>();
  for (const id of fixtureIds) {
    const r = resolveRef(project, models, id);
    if (!r) continue;
    for (const a of availableAttrs(r.model, r.modeId, r.head)) {
      const prev = byKey.get(a.key);
      if (prev) prev.supported += 1;
      else byKey.set(a.key, { ...a, supported: 1 });
    }
  }
  return ATTR_KEYS.flatMap((k) => {
    const a = byKey.get(k);
    return a ? [a] : [];
  });
}
