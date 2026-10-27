import { describe, expect, it } from "vitest";

import zh from "@/shared/i18n/locales/zh.json";
import en from "@/shared/i18n/locales/en.json";
import { NAV_ITEMS, NAV_SECTIONS } from "../items";

/** 按 `a.b.c` 取语言包里的值。 */
function lookup(pack: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], pack);
}

describe("导航配置", () => {
  it("不再包含已移除的“回路配置”和“场景队列”", () => {
    const paths = NAV_ITEMS.map((i) => i.to);
    expect(paths).not.toContain("/loops");
    expect(paths).not.toContain("/scenes");
    expect(NAV_ITEMS.map((i) => i.labelKey)).not.toContain("nav.loops");
    expect(NAV_ITEMS.map((i) => i.labelKey)).not.toContain("nav.scenes");
  });

  it("“节目”分组里有节目编辑，且排在录制之前", () => {
    const program = NAV_ITEMS.filter((i) => i.section === "program").map((i) => i.to);
    expect(program).toContain("/editor");
    expect(program.indexOf("/editor")).toBeLessThan(program.indexOf("/recording"));
  });

  it("每个导航项的文案在中英文语言包里都存在", () => {
    for (const item of NAV_ITEMS) {
      expect(typeof lookup(zh, item.labelKey), item.labelKey).toBe("string");
      expect(typeof lookup(en, item.labelKey), item.labelKey).toBe("string");
    }
  });

  it("路径不重复，且每个导航项都属于已声明的分组", () => {
    const paths = NAV_ITEMS.map((i) => i.to);
    expect(new Set(paths).size).toBe(paths.length);
    for (const item of NAV_ITEMS) expect(NAV_SECTIONS).toContain(item.section);
  });

  it("旧的回路配置 / 场景队列文案键已从语言包删除", () => {
    for (const pack of [zh, en]) {
      expect(lookup(pack, "nav.loops")).toBeUndefined();
      expect(lookup(pack, "nav.scenes")).toBeUndefined();
    }
  });
});
