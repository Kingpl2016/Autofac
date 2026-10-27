import { describe, expect, it } from "vitest";

import type { LibraryEntry } from "@/features/recording";
import {
  countByKind,
  DEFAULT_SORT,
  filterEntries,
  nextSort,
  parseLibraryParams,
  sortEntries,
  writeLibraryParams,
} from "../libraryFilters";

const entry = (over: Partial<LibraryEntry>): LibraryEntry => ({
  path: `D:/rec/${over.name ?? "x"}.artrec`,
  fileName: `${over.name ?? "x"}.artrec`,
  name: "x",
  notes: "",
  bytes: 1000,
  modifiedUnixMs: 0,
  durationUs: 1_000_000,
  frames: 10,
  universes: [0],
  sources: [],
  recovered: false,
  valid: true,
  editable: false,
  exported: true,
  header: null,
  ...over,
});

const list = [
  entry({ name: "节目10", durationUs: 5, bytes: 300, modifiedUnixMs: 3, universes: [1, 2] }),
  entry({ name: "节目2", durationUs: 9, bytes: 100, modifiedUnixMs: 1, notes: "彩排" }),
  entry({ name: "秀", editable: true, modifiedUnixMs: 2 }),
  entry({ name: "坏的", valid: false, modifiedUnixMs: 0 }),
  entry({ name: "未导出", editable: true, exported: false, valid: false }),
];
const names = (es: LibraryEntry[]) => es.map((e) => e.name);

describe("节目库筛选与排序", () => {
  it("按类别与搜索词过滤；只有工程的编辑器节目不算“有问题”", () => {
    expect(names(filterEntries(list, { query: "", kind: "editor" }))).toEqual(["秀", "未导出"]);
    expect(names(filterEntries(list, { query: "", kind: "issues" }))).toEqual(["坏的"]);
    expect(names(filterEntries(list, { query: "彩排", kind: "all" }))).toEqual(["节目2"]);
    expect(countByKind(list)).toEqual({ all: 5, recorded: 3, editor: 2, issues: 1 });
  });

  it("名称按自然顺序排序；数值列换列时默认降序", () => {
    const named = sortEntries(list.slice(0, 2), { key: "name", dir: "asc" });
    expect(names(named)).toEqual(["节目2", "节目10"]);
    expect(names(sortEntries(list.slice(0, 2), { key: "size", dir: "desc" }))).toEqual(["节目10", "节目2"]);
    expect(nextSort(DEFAULT_SORT, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort(DEFAULT_SORT, "duration")).toEqual({ key: "duration", dir: "desc" });
    expect(nextSort({ key: "name", dir: "asc" }, "name")).toEqual({ key: "name", dir: "desc" });
  });

  it("地址栏参数：非法值回退默认，默认值不写入，未知参数保留", () => {
    const parsed = parseLibraryParams(new URLSearchParams("sort=bogus&dir=up&kind=x&q=a"));
    expect(parsed).toEqual({ q: "a", kind: "all", sort: DEFAULT_SORT, sel: "" });

    const base = new URLSearchParams("keep=1");
    const written = writeLibraryParams(base, { q: "", kind: "editor", sort: { key: "name", dir: "asc" }, sel: "D:/a b" });
    expect(written.get("keep")).toBe("1");
    expect(written.has("q")).toBe(false);
    expect(parseLibraryParams(written)).toEqual({ q: "", kind: "editor", sort: { key: "name", dir: "asc" }, sel: "D:/a b" });

    const reset = writeLibraryParams(written, { kind: "all", sort: DEFAULT_SORT, sel: "" });
    expect(reset.toString()).toBe("keep=1");
  });
});
