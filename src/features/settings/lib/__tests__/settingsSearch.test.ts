import { describe, expect, it } from "vitest";

import zh from "@/shared/i18n/locales/zh.json";
import en from "@/shared/i18n/locales/en.json";
import { SETTINGS_SECTIONS } from "../sections";
import { matchSections, normalizeQuery, textMatches } from "../settingsSearch";

/** 按点分路径从语言包取值（测试用的简易 t）。 */
const lookup = (pack: unknown) => (key: string): string => {
  const v = key.split(".").reduce<unknown>((node, p) => (node as Record<string, unknown> | undefined)?.[p], pack);
  return typeof v === "string" ? v : key;
};

describe("settingsSearch", () => {
  it("归一化：小写、合并空白、去首尾空白", () => {
    expect(normalizeQuery("  Art-Net   端口 ")).toBe("art-net 端口");
    expect(normalizeQuery("   ")).toBe("");
  });

  it("空查询全部匹配，忽略 undefined", () => {
    expect(textMatches("", undefined)).toBe(true);
    expect(textMatches("sacn", undefined, "启用 sACN")).toBe(true);
    expect(textMatches("sacn", "合并模式")).toBe(false);
  });

  it("标题命中为 section，只有行命中为 rows，没命中不在结果里", () => {
    const t = lookup(zh);
    const byTitle = matchSections(SETTINGS_SECTIONS, normalizeQuery(t("settings.sectionMerge")), t);
    expect(byTitle.get("merge")).toBe("section");

    const byRow = matchSections(SETTINGS_SECTIONS, normalizeQuery(t("settings.sacnPort")), t);
    expect(byRow.get("protocol")).toBe("rows");
    expect(byRow.has("merge")).toBe(false);

    expect(matchSections(SETTINGS_SECTIONS, "zzzz-不存在", t).size).toBe(0);
  });

  it("每个分区的标题 / 说明 / 关键词在中英文语言包里都存在", () => {
    for (const [name, pack] of [["zh", zh], ["en", en]] as const) {
      const t = lookup(pack);
      for (const s of SETTINGS_SECTIONS) {
        for (const key of [s.titleKey, s.descKey, ...s.keywordKeys]) {
          expect(t(key), `${name}: ${key}`).not.toBe(key);
        }
      }
    }
  });

  it("快捷键分区已移除", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).not.toContain("shortcuts");
  });
});
