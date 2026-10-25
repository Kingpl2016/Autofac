import { describe, expect, it } from "vitest";

import en from "../en.json";
import zh from "../zh.json";

/** 把嵌套对象拍平为 `a.b.c` 形式的键列表。 */
function flatKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === "object"
      ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

describe("语言包", () => {
  it("中英文键集合完全一致", () => {
    expect(flatKeys(en).sort()).toEqual(flatKeys(zh).sort());
  });

  it("没有空文案", () => {
    for (const pack of [zh, en]) {
      const empty = flatKeys(pack).filter((k) => {
        const value = k
          .split(".")
          .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], pack);
        return typeof value !== "string" || value.trim() === "";
      });
      expect(empty).toEqual([]);
    }
  });
});
