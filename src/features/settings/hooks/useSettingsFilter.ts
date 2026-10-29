import { createContext, useContext } from "react";

import type { SettingsSectionId } from "../lib/sections";
import { textMatches, type SectionMatch } from "../lib/settingsSearch";

/** 设置页搜索状态：查询词与命中的分区。 */
export interface SettingsFilter {
  /** 归一化后的查询词；空字符串表示不在搜索 */
  query: string;
  /** 命中的分区及匹配方式；不在搜索时为 `null`（全部显示） */
  matches: ReadonlyMap<SettingsSectionId, SectionMatch> | null;
}

/** 页面级搜索上下文；没有提供者时等同“不在搜索”（例如单独渲染表单的测试）。 */
export const SettingsFilterContext = createContext<SettingsFilter>({ query: "", matches: null });

/** 分区级上下文：当前分区是否整体命中（标题 / 说明命中时分区内的行全部显示）。 */
export const SectionMatchContext = createContext<SectionMatch>("section");

/**
 * 分区是否应该显示。
 *
 * # Arguments
 *
 * * `id` - 分区标识。
 *
 * # Returns
 *
 * 匹配方式；分区被搜索过滤掉时为 `null`。
 */
export function useSectionMatch(id: SettingsSectionId): SectionMatch | null {
  const { matches } = useContext(SettingsFilterContext);
  if (matches === null) return "section";
  return matches.get(id) ?? null;
}

/**
 * 设置行在当前搜索下的状态。
 *
 * # Arguments
 *
 * * `label` - 行标签。
 * * `hint` - 行说明。
 *
 * # Returns
 *
 * `visible`：是否显示；`highlighted`：是否是搜索命中的行（用于轻微高亮）。
 */
export function useRowFilter(label: string, hint?: string): { visible: boolean; highlighted: boolean } {
  const { query } = useContext(SettingsFilterContext);
  const sectionMatch = useContext(SectionMatchContext);
  if (query === "") return { visible: true, highlighted: false };
  const hit = textMatches(query, label, hint);
  return { visible: hit || sectionMatch === "section", highlighted: hit };
}
