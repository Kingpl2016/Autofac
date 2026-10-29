import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/shared/tauri/tauriStorage", () => ({
  createTauriPersistStorage: (file?: string) => ({ file }),
}));

import { persistPrefs, prefsSanitizer } from "../persistPrefs";

const schema = z.object({
  view: z.enum(["a", "b"]).catch("a"),
  nested: z.object({ on: z.boolean().catch(true), n: z.number().catch(1) }).catch({ on: true, n: 1 }),
});

describe("prefsSanitizer", () => {
  const sanitize = prefsSanitizer(schema);

  it("没有数据或不是对象时得到全部默认值", () => {
    expect(sanitize(undefined)).toEqual({ view: "a", nested: { on: true, n: 1 } });
    expect(sanitize("garbage")).toEqual({ view: "a", nested: { on: true, n: 1 } });
  });

  it("逐字段兜底：合法字段保留，非法字段回落默认值", () => {
    expect(sanitize({ view: "b", nested: { on: false, n: "x" } })).toEqual({ view: "b", nested: { on: false, n: 1 } });
    expect(sanitize({ view: "zzz" })).toEqual({ view: "a", nested: { on: true, n: 1 } });
  });

  it("丢弃 schema 外的字段（旧版本残留）", () => {
    expect(sanitize({ view: "b", legacy: 1 })).not.toHaveProperty("legacy");
  });
});

describe("persistPrefs", () => {
  type State = { view: "a" | "b"; nested: { on: boolean; n: number }; transient: string; set: () => void };
  const options = persistPrefs<State, z.infer<typeof schema>>({ name: "demo", version: 3, schema, file: "x.json" });
  const current: State = { view: "a", nested: { on: true, n: 1 }, transient: "keep", set: () => undefined };

  it("键名、版本与文件原样保留", () => {
    expect(options.name).toBe("demo");
    expect(options.version).toBe(3);
    expect(options.storage).toEqual({ file: "x.json" });
  });

  it("只保存 schema 里的字段", () => {
    expect(options.partialize?.({ ...current, view: "b" })).toEqual({ view: "b", nested: { on: true, n: 1 } });
  });

  it("没有已保存数据时保持当前值；有数据时清洗后合并", () => {
    expect(options.merge?.(undefined, current)).toBe(current);
    const merged = options.merge?.({ view: "b", nested: { on: "no" } }, current);
    expect(merged).toMatchObject({ view: "b", nested: { on: true, n: 1 }, transient: "keep" });
  });
});
