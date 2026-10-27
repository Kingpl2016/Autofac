import { current, isDraft, type Draft } from "immer";

import { newId } from "./ids";
import { resolveLook } from "./looks";
import type { AttrKey, Look, Preset, ShowProject } from "./project";

/** 预设分类（素材库筛选用），顺序即显示顺序。 */
export const PRESET_GROUPS = ["all", "intensity", "color", "position", "beam"] as const satisfies readonly Preset["group"][];

/** 位置类属性（推断分类用）。 */
const POSITION_ATTRS: readonly AttrKey[] = ["pan", "tilt"];

/**
 * immer 草稿（Proxy）不能 structuredClone，先取出当前快照；普通对象原样返回。
 *
 * @param value 草稿或普通对象。
 * @returns 普通对象。
 */
function plain<T>(value: T): T {
  return isDraft(value) ? (current(value as Draft<T>) as T) : value;
}

/**
 * 深拷贝一个外观（必须是普通对象，不能是草稿），并去掉预设引用（预设不能再引用预设）。
 *
 * @param look 外观。
 * @returns 独立的副本。
 */
function cloneLook(look: Look): Look {
  const copy = structuredClone(look);
  delete copy.presetId;
  if (copy.attrs && Object.keys(copy.attrs).length === 0) delete copy.attrs;
  if (copy.intensity === undefined) delete copy.intensity;
  if (copy.color === undefined) delete copy.color;
  return copy;
}

/**
 * 按外观里出现的层推断预设分类：只有强度为 `intensity`、只有颜色为 `color`、只有 Pan / Tilt 为 `position`，
 * 只有其它属性为 `beam`，混合为 `all`。
 *
 * @param look 外观。
 * @returns 分类。
 */
export function inferPresetGroup(look: Look): Preset["group"] {
  const attrs = Object.keys(look.attrs ?? {}) as AttrKey[];
  const kinds = new Set<Preset["group"]>();
  if (look.intensity) kinds.add("intensity");
  if (look.color) kinds.add("color");
  for (const a of attrs) kinds.add(POSITION_ATTRS.includes(a) ? "position" : "beam");
  return kinds.size === 1 ? [...kinds][0] : "all";
}

/**
 * 新建预设。外观会被深拷贝；外观若引用了别的预设，先展开（预设不嵌套）。
 *
 * @param draft 工程草稿。
 * @param name 名称（空白时用 `fallbackName`）。
 * @param look 外观。
 * @param fallbackName 名称为空时的默认名。
 * @returns 新预设的 id。
 */
export function createPreset(draft: ShowProject, name: string, look: Look, fallbackName: string): string {
  const resolved = cloneLook(resolveLook(plain(look), plain(draft.presets)));
  const preset: Preset = {
    id: newId(),
    name: name.trim() || fallbackName,
    group: inferPresetGroup(resolved),
    look: resolved,
  };
  draft.presets.push(preset);
  return preset.id;
}

/**
 * 重命名预设（空白名称忽略）。
 *
 * @param draft 工程草稿。
 * @param id 预设 id。
 * @param name 新名称。
 */
export function renamePreset(draft: ShowProject, id: string, name: string): void {
  const preset = draft.presets.find((p) => p.id === id);
  if (preset && name.trim()) preset.name = name.trim();
}

/**
 * 删除预设。引用它的片段把预设内容“烘焙”进自己的外观（画面不变，只是不再随预设联动）。
 *
 * @param draft 工程草稿。
 * @param id 预设 id。
 * @returns 被烘焙的外观数量。
 */
export function removePreset(draft: ShowProject, id: string): number {
  const found = draft.presets.find((p) => p.id === id);
  if (!found) return 0;
  const preset = plain(found);
  let baked = 0;
  const bake = (look: Look): Look => {
    if (look.presetId !== id) return look;
    baked += 1;
    return cloneLook(resolveLook(plain(look), [preset]));
  };
  for (const cue of draft.cues) {
    if (cue.kind === "look") cue.look = bake(cue.look);
    if (cue.kind === "scene") for (const e of cue.entries) e.look = bake(e.look);
  }
  draft.presets = draft.presets.filter((p) => p.id !== id);
  return baked;
}

/**
 * 统计引用某个预设的外观数量。
 *
 * @param project 工程（只读）。
 * @param id 预设 id。
 * @returns 引用数。
 */
export function presetUsage(project: Pick<ShowProject, "cues">, id: string): number {
  let n = 0;
  for (const cue of project.cues) {
    if (cue.kind === "look" && cue.look.presetId === id) n += 1;
    if (cue.kind === "scene") n += cue.entries.filter((e) => e.look.presetId === id).length;
  }
  return n;
}
