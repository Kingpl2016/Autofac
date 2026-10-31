import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { BUILTIN_SKILL_NAMES, ensureSkills, useEnabledSkillInfos } from "@/features/ai";

/**
 * 斜杠调用技能的数据：可以点名的技能列表、按输入过滤，以及把 `/技能名` 插进输入框的文字。
 */

/** 列表项的来源。 */
type SkillSource = "builtin" | "user";

/** 列表项。 */
export interface SlashSkill {
  /** 技能名（`/` 后面的部分） */
  name: string;
  title: string;
  description: string;
  source: SkillSource;
}

/**
 * 可以点名的技能：内置的在前（固定顺序），用户技能按名称排；同名时用户技能不重复列出。
 *
 * @returns 技能列表。
 */
export function useSlashSkills(): SlashSkill[] {
  const { t } = useTranslation();
  const user = useEnabledSkillInfos();
  useEffect(() => {
    void ensureSkills().catch(() => undefined);
  }, []);
  return useMemo(() => {
    const builtin: SlashSkill[] = BUILTIN_SKILL_NAMES.map((name) => ({
      name,
      title: t(`ai.skills.builtin.${name}.title`),
      description: t(`ai.skills.builtin.${name}.desc`),
      source: "builtin",
    }));
    const taken = new Set<string>(BUILTIN_SKILL_NAMES);
    const mine = [...user]
      .filter((s) => !taken.has(s.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map<SlashSkill>((s) => ({ name: s.name, title: s.title ?? s.name, description: s.description, source: "user" }));
    return [...builtin, ...mine];
  }, [t, user]);
}

/**
 * 按输入过滤：名称、标题或说明包含输入（不区分大小写）；名称以输入开头的排前面。
 *
 * @param skills 技能。
 * @param query `/` 后面已经输入的文字。
 * @returns 匹配的技能。
 */
export function filterSkills(skills: readonly SlashSkill[], query: string): SlashSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...skills];
  const hit = skills.filter((s) => [s.name, s.title, s.description].some((x) => x.toLowerCase().includes(q)));
  return [...hit.filter((s) => s.name.startsWith(q)), ...hit.filter((s) => !s.name.startsWith(q))];
}

/**
 * 把 `/技能名` 插到输入框文字的开头（已经点名过的不重复插）。
 *
 * @param text 输入框现在的文字。
 * @param name 技能名。
 * @returns 新文字。
 */
export function withSkill(text: string, name: string): string {
  const token = `/${name}`;
  if (text.split(/\s+/).includes(token)) return text;
  return `${token} ${text.replace(/^\s+/, "")}`;
}
