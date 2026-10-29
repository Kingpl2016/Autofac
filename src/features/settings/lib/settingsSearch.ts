import type { SettingsSectionId, SettingsSectionMeta } from "./sections";

/** 翻译函数的最小形状（与 i18next 的 `t` 兼容）。 */
type Translate = (key: string) => string;

/**
 * 归一化搜索文本：小写、合并空白、去掉首尾空白。
 *
 * # Arguments
 *
 * * `text` - 原始文本。
 *
 * # Returns
 *
 * 归一化后的文本；只有空白时为空字符串。
 */
export function normalizeQuery(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 判断任一文本是否包含（已归一化的）查询词。空查询视为全部匹配。
 *
 * # Arguments
 *
 * * `query` - 经 {@link normalizeQuery} 处理过的查询词。
 * * `texts` - 候选文本，`undefined` 会被忽略。
 *
 * # Returns
 *
 * 有一个文本包含查询词时为 `true`。
 */
export function textMatches(query: string, ...texts: (string | undefined)[]): boolean {
  if (query === "") return true;
  return texts.some((s) => s !== undefined && normalizeQuery(s).includes(query));
}

/** 某个分区的匹配情况。 */
export type SectionMatch =
  /** 标题或说明命中：分区内全部行都显示 */
  | "section"
  /** 只有某些行命中：只显示命中的行 */
  | "rows";

/**
 * 计算查询词命中的分区。
 *
 * # Arguments
 *
 * * `sections` - 参与搜索的分区（已排除不显示的分区）。
 * * `query` - 经 {@link normalizeQuery} 处理过的查询词；为空时所有分区按 `"section"` 命中。
 * * `t` - 翻译函数，按当前语言取标题 / 说明 / 行标签。
 *
 * # Returns
 *
 * 命中分区到匹配方式的映射；没有命中的分区不在映射里。
 */
export function matchSections(
  sections: readonly SettingsSectionMeta[],
  query: string,
  t: Translate,
): Map<SettingsSectionId, SectionMatch> {
  const out = new Map<SettingsSectionId, SectionMatch>();
  for (const s of sections) {
    if (textMatches(query, t(s.titleKey), t(s.descKey))) out.set(s.id, "section");
    else if (s.keywordKeys.some((k) => textMatches(query, t(k)))) out.set(s.id, "rows");
  }
  return out;
}
