import { addDefaultLook } from "./cueDefaults";
import { addLookCue, DEFAULT_CUE_MS, normalizeFades } from "./cueOps";
import { CUSTOM_GROUP, templateKind, uniqueTemplateId, type CueTemplate, type TemplateColor } from "./cueTemplates";
import { addEffectDefCue, legacyEffectFx } from "./effectLibrary";
import { periodMs } from "./effects";
import { paramHead, resolveLook } from "./looks";
import type { ColorValue, Cue, Look, Preset, ShowProject } from "./project";

/**
 * 用户 Cue 模板的编辑（纯函数，返回新的用户模板列表）与模板插入。内置模板只读：要改先“复制为我的模板”。
 */

/**
 * 把一个模板复制为用户模板（放进“我的”分组，名字后加“副本”）。
 *
 * @param user 现有用户模板。
 * @param all 全部模板（取不重复的 `id`）。
 * @param source 要复制的模板。
 * @param copySuffix 名字后缀（界面传入本地化的“ 副本”）。
 * @returns 新列表与新模板。
 */
export function copyToUser(
  user: readonly CueTemplate[],
  all: readonly CueTemplate[],
  source: CueTemplate,
  copySuffix: string,
): { next: CueTemplate[]; created: CueTemplate } {
  const name =
    typeof source.name === "string"
      ? `${source.name}${copySuffix}`
      : {
          ...(source.name.zh ? { zh: `${source.name.zh}${copySuffix}` } : {}),
          ...(source.name.en ? { en: `${source.name.en}${copySuffix}` } : {}),
        };
  const { builtin: _b, ...rest } = structuredClone(source);
  void _b;
  const created: CueTemplate = { ...rest, id: uniqueTemplateId([...all, ...user], "my"), name, group: CUSTOM_GROUP };
  return { next: [...user, created], created };
}

/**
 * 改名（只改用户模板；名称首尾空白去掉，为空时不改）。
 *
 * @param user 用户模板。
 * @param id 模板。
 * @param name 新名称。
 * @returns 新列表；没有改动时为原列表。
 */
export function renameTemplate(user: readonly CueTemplate[], id: string, name: string): CueTemplate[] {
  const n = name.trim();
  if (!n || !user.some((t) => t.id === id)) return [...user];
  return user.map((t) => (t.id === id ? { ...t, name: n } : t));
}

/**
 * 改分组。
 *
 * @param user 用户模板。
 * @param id 模板。
 * @param group 新分组（首尾空白去掉，为空时归入“我的”）。
 * @returns 新列表。
 */
export function setTemplateGroup(user: readonly CueTemplate[], id: string, group: string): CueTemplate[] {
  const g = group.trim() || CUSTOM_GROUP;
  return user.map((t) => (t.id === id ? { ...t, group: g } : t));
}

/**
 * 搜索模板：按空白分词，每个词都要出现在名称（中英文都算）、`id`、分组、标签或说明里（不区分大小写）。
 *
 * @param templates 模板。
 * @param query 搜索词。
 * @returns 匹配的模板（保持原顺序）；搜索词为空时为全部。
 */
export function searchTemplates(templates: readonly CueTemplate[], query: string): CueTemplate[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...templates];
  return templates.filter((t) => {
    const names = typeof t.name === "string" ? [t.name] : [t.name.zh ?? "", t.name.en ?? ""];
    const hay = [...names, t.id, t.group, t.note ?? "", ...(t.tags ?? [])].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * 新增或替换一个用户模板（模板编辑器保存）。
 *
 * @param user 用户模板。
 * @param template 模板（去掉运行时标记后保存）。
 * @returns 新列表：同 `id` 的原位替换，否则追加。
 */
export function upsertTemplate(user: readonly CueTemplate[], template: CueTemplate): CueTemplate[] {
  const { builtin: _b, ...clean } = structuredClone(template);
  void _b;
  return user.some((t) => t.id === clean.id) ? user.map((t) => (t.id === clean.id ? clean : t)) : [...user, clean];
}

/**
 * 删除用户模板。
 *
 * @param user 用户模板。
 * @param id 模板。
 * @returns 新列表。
 */
export function removeTemplate(user: readonly CueTemplate[], id: string): CueTemplate[] {
  return user.filter((t) => t.id !== id);
}

/**
 * 导入：同 `id` 的替换，其余追加。
 *
 * @param user 用户模板。
 * @param imported 文件里解析出的模板。
 * @returns 新列表与新增 / 替换的数量。
 */
export function importTemplates(
  user: readonly CueTemplate[],
  imported: readonly CueTemplate[],
): { next: CueTemplate[]; added: number; replaced: number } {
  const byId = new Map(user.map((t) => [t.id, t]));
  let added = 0;
  let replaced = 0;
  for (const t of imported) {
    if (byId.has(t.id)) replaced += 1;
    else added += 1;
    byId.set(t.id, { ...t, builtin: undefined });
  }
  const next = [...byId.values()].map(({ builtin: _b, ...t }) => {
    void _b;
    return t;
  });
  return { next, added, replaced };
}

/**
 * 模板的片段长度（毫秒）：按拍时按工程节拍换算；省略时为默认长度。
 *
 * @param template 模板。
 * @param tempo 工程节拍。
 * @returns 毫秒。
 */
export function templateLengthMs(template: Pick<CueTemplate, "length">, tempo: ShowProject["tempo"]): number {
  return template.length ? Math.max(100, Math.round(periodMs(template.length, tempo))) : DEFAULT_CUE_MS;
}

/**
 * 在轨道上按模板新建一个片段：
 *
 * - 颜色模板：按灯具类型给默认外观（只写支持的层），颜色取模板的；带多色分布时一并写入；
 * - 外观模板：模板的外观与分布原样写入；
 * - 特效预设模板：按模板里的特效快照与参数生成（插入后仍可改参数）。
 *
 * 亮度、淡入淡出、缓动、长度取模板的（特效预设模板没给长度时按特效的默认长度）；场景轨道不新建。
 *
 * @param d 工程草稿。
 * @param trackId 轨道。
 * @param timeMs 起点。
 * @param template 模板。
 * @param label 片段名称（界面语言下的模板名）。
 * @returns 新片段 id；放不下或轨道不可用时为 `null`。
 */
export function addTemplateCue(d: ShowProject, trackId: string, timeMs: number, template: CueTemplate, label?: string): string | null {
  const track = d.tracks.find((t) => t.id === trackId);
  if (!track || track.target.kind === "scene") return null;
  const lengthMs = templateLengthMs(template, d.tempo);
  const kind = templateKind(template);
  let id: string | null;
  if (kind === "effect" && template.fx) {
    // 特效预设没给长度时按特效自己的默认长度（与从特效库插入一致）
    const fxLength = template.length ? lengthMs : undefined;
    id = addEffectDefCue(d, trackId, timeMs, template.fx.def, template.fx.params, label, fxLength);
  } else if (kind === "look" && template.look) {
    id = addLookCue(d, trackId, timeMs, template.look, lengthMs, template.spread);
    const cue = id ? d.cues.find((c) => c.id === id) : undefined;
    if (cue?.kind === "look" && label?.trim()) cue.label = label.trim();
  } else {
    id = addDefaultLook(d, trackId, timeMs, { color: structuredClone(template.color), lengthMs, label });
    const cue = id ? d.cues.find((c) => c.id === id) : undefined;
    if (cue?.kind === "look" && template.spread) cue.spread = structuredClone(template.spread);
  }
  const cue = id ? d.cues.find((c) => c.id === id) : undefined;
  if (cue) {
    cue.brightness = template.brightness;
    cue.fadeInMs = template.fadeInMs;
    cue.fadeOutMs = template.fadeOutMs;
    if (template.easing) cue.easing = template.easing;
    normalizeFades(cue);
  }
  return id;
}

/** 外观的代表色（素材库色块用）：颜色层开头的值；没有颜色层时为白光。 */
function representativeColor(look: Look): TemplateColor {
  const head = look.color ? (paramHead(look.color) as ColorValue | undefined) : undefined;
  return head ? structuredClone(head) : { kind: "rgb", rgb: [255, 255, 255] };
}

/**
 * 片段 → 模板内容（右键“存为 Cue 模板”）：
 *
 * - 静态片段、只有固定颜色（与固定强度）的外观片段 → 颜色模板（RGB / 色温 / 按发光体直给都可以；多色分布一并保存）；
 * - 特效生成的片段 → 特效预设模板（快照与当前参数）；
 * - 其余外观片段（属性层、曲线、关键帧、颜色序列、分布）→ 外观模板；
 * - 经典 RGB 特效片段 → 换算成对应的可配置特效，存为特效预设模板。
 *
 * 场景片段（按灯分别记录）不能存。长度一并保存（毫秒）。
 *
 * @param cue 片段。
 * @returns 模板内容；不能存时为 `null`。
 */
export function templateFromCue(cue: Cue, presets: readonly Preset[] = []): Omit<CueTemplate, "id" | "name" | "group"> | null {
  const base = {
    brightness: cue.brightness,
    fadeInMs: cue.fadeInMs,
    fadeOutMs: cue.fadeOutMs,
    length: { kind: "ms" as const, ms: Math.max(100, cue.endMs - cue.startMs) },
    ...(cue.easing !== "linear" ? { easing: cue.easing } : {}),
  };
  if (cue.kind === "static") return { ...base, color: { kind: "rgb", rgb: [...cue.rgb] } };
  if (cue.kind === "effect") {
    const fx = legacyEffectFx(cue);
    return fx ? { ...base, kind: "effect", color: { kind: "rgb", rgb: [...(cue.colors[0] ?? [255, 255, 255])] }, fx } : null;
  }
  if (cue.kind !== "look") return null;
  if (cue.fx) return { ...base, kind: "effect", color: representativeColor(cue.look), fx: structuredClone(cue.fx) };
  // 引用了预设的片段：把预设的层合并进来（模板不依赖某个工程里的预设）
  const resolved = resolveLook(cue.look, presets);
  const { intensity, color, attrs } = resolved;
  const plain =
    color?.kind === "value" &&
    (intensity === undefined || intensity.kind === "value") &&
    Object.keys(attrs ?? {}).length === 0 &&
    (!cue.spread || Object.keys(cue.spread).every((k) => k === "colors" || k === "order"));
  if (plain) {
    return { ...base, color: structuredClone(color.value), ...(cue.spread ? { spread: structuredClone(cue.spread) } : {}) };
  }
  const look: Look = structuredClone(resolved);
  for (const k of Object.keys(look) as (keyof Look)[]) if (look[k] === undefined) delete look[k];
  if (look.attrs && Object.keys(look.attrs).length === 0) delete look.attrs;
  if (!look.intensity && !look.color && !look.attrs) return null;
  return { ...base, kind: "look", color: representativeColor(resolved), look, ...(cue.spread ? { spread: structuredClone(cue.spread) } : {}) };
}
