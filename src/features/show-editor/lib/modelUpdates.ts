import { layoutOf, type FixtureModel } from "@/features/fixtures";
import { prunePixelRefs } from "./fixtureRef";
import type { ShowProject } from "./project";

/**
 * 工程里的灯具模型快照与素材库的比对与替换。
 *
 * 工程保存模型快照，素材库之后的修改（例如按新识别规则重新导入 OFL）不会自动影响已有节目。
 * 编辑器发现快照与库里同编号的模型不一致时提示用户，确认后在一次可撤销的步骤里替换快照；
 * 灯具选用的模式在新模型里不存在时回到默认模式。
 */

/** 一个模型快照的更新摘要。 */
export interface SnapshotUpdate {
  /** 模型编号 */
  modelId: string;
  /** 素材库里的名称 */
  name: string;
  /** 默认模式的通道数：快照 → 库 */
  channels: [number, number];
  /** 库里新增的模式名 */
  modesAdded: string[];
  /** 库里已不存在的模式名（用这些模式的灯具会回到默认模式） */
  modesRemoved: string[];
  /** 默认模式里功能或位置变化的通道数 */
  changedChannels: number;
  /** 工程里用这个模型的灯具数 */
  fixtures: number;
}

/** 按键排序、省略 `undefined` 的 JSON：两个结构相同的对象得到同一个字符串。 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(obj)
          .filter((k) => obj[k] !== undefined)
          .sort()
          .map((k) => [k, obj[k]]),
      );
    }
    return v;
  });
}

/** 默认模式的通道数。 */
function footprintOf(model: FixtureModel): number {
  return Math.max(0, ...model.properties.map((p) => p.channel + p.width - 1));
}

/**
 * 找出与素材库不一致的模型快照。
 *
 * @param project 工程（只读）。
 * @param library 素材库里的全部模型。
 * @returns 每个需要更新的快照的摘要；库里没有的模型（已删除）不列出。
 */
export function snapshotUpdates(
  project: Pick<ShowProject, "fixtureModels" | "fixtures">,
  library: readonly FixtureModel[],
): SnapshotUpdate[] {
  const byId = new Map(library.map((m) => [m.id, m]));
  const out: SnapshotUpdate[] = [];
  for (const snap of project.fixtureModels) {
    const lib = byId.get(snap.id);
    if (!lib || canonical(snap) === canonical(lib)) continue;
    const oldModes = new Map((snap.modes ?? []).map((m) => [m.id, m.name]));
    const newModes = new Map((lib.modes ?? []).map((m) => [m.id, m.name]));
    const sig = (m: FixtureModel) =>
      new Set((layoutOf(m) ?? []).map((p) => `${p.channel}:${p.width}:${p.function}:${p.head ?? 0}`));
    const before = sig(snap);
    const after = sig(lib);
    const changed = [...after].filter((s) => !before.has(s)).length + [...before].filter((s) => !after.has(s)).length;
    out.push({
      modelId: snap.id,
      name: lib.name,
      channels: [footprintOf(snap), footprintOf(lib)],
      modesAdded: [...newModes].filter(([id]) => !oldModes.has(id)).map(([, n]) => n),
      modesRemoved: [...oldModes].filter(([id]) => !newModes.has(id)).map(([, n]) => n),
      changedChannels: Math.ceil(changed / 2),
      fixtures: project.fixtures.filter((f) => f.modelId === snap.id).length,
    });
  }
  return out;
}

/**
 * 用素材库里的模型替换工程里的快照（没有时加入）；用这个模型、但所选模式已不存在的灯具回到默认模式。
 *
 * @param draft 工程草稿。
 * @param model 素材库里的模型。
 * @returns 回到默认模式的灯具 id。
 */
export function replaceModelSnapshot(draft: ShowProject, model: FixtureModel): string[] {
  const copy = structuredClone(model);
  const index = draft.fixtureModels.findIndex((m) => m.id === model.id);
  if (index >= 0) draft.fixtureModels[index] = copy;
  else draft.fixtureModels.push(copy);
  const modes = new Set((model.modes ?? []).map((m) => m.id));
  const reset: string[] = [];
  for (const f of draft.fixtures) {
    if (f.modelId === model.id && f.modeId && !modes.has(f.modeId)) {
      delete f.modeId;
      reset.push(f.id);
    }
  }
  // 新模型的像素可能更少：清理失效的像素引用
  prunePixelRefs(draft);
  return reset;
}

/**
 * 批量替换模型快照。
 *
 * @param draft 工程草稿。
 * @param models 素材库里的模型。
 * @returns 回到默认模式的灯具 id。
 */
export function applySnapshotUpdates(draft: ShowProject, models: readonly FixtureModel[]): string[] {
  return models.flatMap((m) => replaceModelSnapshot(draft, m));
}
