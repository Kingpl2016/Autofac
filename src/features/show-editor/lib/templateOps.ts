import { CUSTOM_GROUP, uniqueTemplateId, type CueTemplate, type TemplateColor } from "./cueTemplates";
import { paramHead } from "./looks";
import type { ColorValue, Cue } from "./project";

/**
 * 用户 Cue 模板的编辑（纯函数，返回新的用户模板列表）。内置模板只读：要改先“复制为我的模板”。
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
 * 片段 → 模板的颜色、亮度与淡入淡出（右键“存为 Cue 模板”）。外观片段取颜色层在开头的值，
 * 静态片段取它的颜色；按发光体直给的颜色、没有颜色的片段和场景 / 特效片段不能存。
 *
 * @param cue 片段。
 * @returns 模板内容；不能存时为 `null`。
 */
export function templateFromCue(cue: Cue): Omit<CueTemplate, "id" | "name" | "group"> | null {
  const base = { brightness: cue.brightness, fadeInMs: cue.fadeInMs, fadeOutMs: cue.fadeOutMs };
  if (cue.kind === "static") return { ...base, color: { kind: "rgb", rgb: [...cue.rgb] } };
  if (cue.kind !== "look") return null;
  const c = cue.look.color ? (paramHead(cue.look.color) as ColorValue | undefined) : undefined;
  if (!c || c.kind === "manual") return null;
  const color: TemplateColor = c.kind === "rgb" ? { kind: "rgb", rgb: [...c.rgb] } : { kind: "kelvin", kelvin: c.kelvin };
  return { ...base, color };
}
