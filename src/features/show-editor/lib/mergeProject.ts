import { newId } from "./ids";
import { footprintOf, nextFreeSlot } from "./patch";
import { parseRef, refOf } from "./fixtureRef";
import type { Look, ShowProject, Track } from "./project";

/**
 * 把另一个节目合并进当前工程（文件菜单“导入节目”）：灯具（连同模型快照与分组）总是导入，
 * 时间线（轨道与片段）、预设、标记与段落可选。
 *
 * 所有导入的对象都换成新 id，彼此之间的引用（轨道 → 灯具 / 分组、片段 → 轨道 / 预设、
 * 场景条目与分组里的灯具 / 像素引用）一并改写，所以同一个节目可以导入多次。
 * 模型按 id 去重（当前工程已有同 id 的模型时沿用当前的）。媒体素材、输出设置、舞台物件、节拍不导入。
 */

/** 导入选项。 */
export interface MergeOptions {
  /** 导入时间线（轨道与片段） */
  timeline: boolean;
  /** 导入全部预设（被导入片段引用的预设无论如何都会导入） */
  presets: boolean;
  /** 导入标记点与段落 */
  markers: boolean;
  /** 片段、标记、段落整体平移（毫秒，≥ 0） */
  offsetMs: number;
  /** 灯具重新配接到当前工程的空闲地址（否则保留原地址，可能与现有灯具冲突） */
  repatch: boolean;
}

/** 导入了多少东西。 */
export interface MergeReport {
  fixtures: number;
  /** 新增的模型快照（同 id 已存在的不算） */
  models: number;
  groups: number;
  tracks: number;
  cues: number;
  presets: number;
  /** 标记点 + 段落 */
  markers: number;
  /** 找不到空闲地址、保留原地址的灯具数（只在 `repatch` 时） */
  unpatched: number;
}

/** 一个节目里有什么（导入对话框的摘要）。 */
export interface ProjectSummary {
  fixtures: number;
  groups: number;
  tracks: number;
  cues: number;
  presets: number;
  markers: number;
  /** 最后一个片段的结束时间（毫秒） */
  endMs: number;
}

/**
 * 统计节目内容。
 *
 * @param p 工程。
 * @returns 摘要。
 */
export function summarizeProject(p: ShowProject): ProjectSummary {
  return {
    fixtures: p.fixtures.length,
    groups: p.groups.length,
    tracks: p.tracks.length,
    cues: p.cues.length,
    presets: p.presets.length,
    markers: p.markers.length + p.sections.length,
    endMs: p.cues.reduce((m, c) => Math.max(m, c.endMs), 0),
  };
}

/**
 * 当前工程里最后一个片段的结束时间（“接在节目末尾”导入时的偏移）。
 *
 * @param p 工程。
 * @returns 毫秒；没有片段时为 0。
 */
export function projectEndMs(p: Pick<ShowProject, "cues">): number {
  return p.cues.reduce((m, c) => Math.max(m, c.endMs), 0);
}

/**
 * 合并（在 immer 草稿上执行，一次调用 = 一步撤销）。
 *
 * @param d 当前工程草稿。
 * @param source 要导入的工程（只读）。
 * @param options 选项。
 * @returns 导入了多少东西。
 */
export function mergeProject(d: ShowProject, source: ShowProject, options: MergeOptions): MergeReport {
  const src = structuredClone(source);
  const offset = Math.max(0, Math.round(Number.isFinite(options.offsetMs) ? options.offsetMs : 0));
  const report: MergeReport = { fixtures: 0, models: 0, groups: 0, tracks: 0, cues: 0, presets: 0, markers: 0, unpatched: 0 };

  // 模型快照：按 id 去重
  const modelIds = new Set(d.fixtureModels.map((m) => m.id));
  for (const m of src.fixtureModels) {
    if (modelIds.has(m.id)) continue;
    d.fixtureModels.push(m);
    modelIds.add(m.id);
    report.models += 1;
  }

  // 灯具：新 id；需要时重新配接（逐台找空位，后一台能看到前一台占的地址）
  const fixtureIds = new Map<string, string>();
  const models = new Map(d.fixtureModels.map((m) => [m.id, m]));
  for (const f of src.fixtures) {
    const id = newId();
    fixtureIds.set(f.id, id);
    const next = { ...f, id };
    if (options.repatch) {
      const slot = nextFreeSlot(d, footprintOf(models.get(f.modelId), f.modeId));
      if (slot) {
        next.universe = slot.universe;
        next.address = slot.address;
        delete next.mirrors;
      } else {
        report.unpatched += 1;
      }
    }
    d.fixtures.push(next);
    report.fixtures += 1;
  }
  /** 改写灯具 / 像素引用；灯具不在导入范围内时为 `null`。 */
  const mapRef = (ref: string): string | null => {
    const { fixtureId, head } = parseRef(ref);
    const id = fixtureIds.get(fixtureId);
    return id ? refOf(id, head) : null;
  };

  const groupIds = new Map<string, string>();
  for (const g of src.groups) {
    const id = newId();
    groupIds.set(g.id, id);
    d.groups.push({ ...g, id, fixtureIds: g.fixtureIds.map(mapRef).filter((x): x is string => x !== null) });
    report.groups += 1;
  }

  // 预设：全部，或只要被导入片段引用的
  const usedPresets = new Set<string>();
  const notePreset = (look: Look | undefined) => {
    if (look?.presetId) usedPresets.add(look.presetId);
  };
  if (options.timeline) {
    for (const c of src.cues) {
      if (c.kind === "look") notePreset(c.look);
      if (c.kind === "scene") for (const e of c.entries) notePreset(e.look);
    }
  }
  const presetIds = new Map<string, string>();
  for (const p of src.presets) {
    if (!options.presets && !usedPresets.has(p.id)) continue;
    presetIds.set(p.id, newId());
  }
  const mapLook = (look: Look): Look => {
    if (!look.presetId) return look;
    const id = presetIds.get(look.presetId);
    const next = { ...look };
    if (id) next.presetId = id;
    else delete next.presetId;
    return next;
  };
  for (const p of src.presets) {
    const id = presetIds.get(p.id);
    if (!id) continue;
    d.presets.push({ ...p, id, look: mapLook(p.look) });
    report.presets += 1;
  }

  let endMs = 0;
  if (options.timeline) {
    const trackIds = new Map<string, string>();
    for (const t of src.tracks) {
      if (t.onTop) continue;
      let target: Track["target"] | null = t.target;
      if (t.target.kind === "fixture") {
        const ref = mapRef(t.target.id);
        target = ref ? { kind: "fixture", id: ref } : null;
      } else if (t.target.kind === "group") {
        const id = groupIds.get(t.target.id);
        target = id ? { kind: "group", id } : null;
      }
      if (!target) continue;
      const id = newId();
      trackIds.set(t.id, id);
      d.tracks.push({ ...t, id, target });
      report.tracks += 1;
    }
    for (const c of src.cues) {
      const trackId = trackIds.get(c.trackId);
      if (!trackId) continue;
      const base = { ...c, id: newId(), trackId, startMs: c.startMs + offset, endMs: c.endMs + offset };
      if (base.kind === "look") base.look = mapLook(base.look);
      if (base.kind === "scene") {
        base.entries = base.entries.flatMap((e) => {
          const ref = mapRef(e.fixtureId);
          return ref ? [{ fixtureId: ref, look: mapLook(e.look) }] : [];
        });
      }
      d.cues.push(base);
      endMs = Math.max(endMs, base.endMs);
      report.cues += 1;
    }
  }

  if (options.markers) {
    for (const m of src.markers) {
      d.markers.push({ ...m, id: newId(), timeMs: m.timeMs + offset });
      endMs = Math.max(endMs, m.timeMs + offset);
      report.markers += 1;
    }
    for (const s of src.sections) {
      d.sections.push({ ...s, id: newId(), startMs: s.startMs + offset, endMs: s.endMs + offset });
      endMs = Math.max(endMs, s.endMs + offset);
      report.markers += 1;
    }
    d.markers.sort((a, b) => a.timeMs - b.timeMs);
  }

  d.durationMs = Math.max(d.durationMs, endMs);
  return report;
}
