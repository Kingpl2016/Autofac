import { describe, expect, it } from "vitest";

import { folderOf, relativeTime } from "../../lib/relativeTime";
import { fileStem, MAX_RECENT, pushRecent, sanitizeRecent, type RecentFile } from "../useRecentFilesStore";

const item = (path: string, openedAt = 0, kind: RecentFile["kind"] = "external"): RecentFile => ({ path, kind, name: fileStem(path), openedAt });

describe("最近文件", () => {
  it("同一路径（不分大小写与分隔符）移到最前，最多保留 10 个", () => {
    let list: RecentFile[] = [];
    for (let i = 0; i < 12; i += 1) list = pushRecent(list, item(`D:/show/${i}.artshow`, i));
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].path).toBe("D:/show/11.artshow");
    list = pushRecent(list, item("d:\\SHOW\\5.artshow", 99));
    expect(list[0].openedAt).toBe(99);
    expect(list.filter((x) => x.name.toLowerCase() === "5")).toHaveLength(1);
  });

  it("读回时丢掉不合法的项，按时间排序并去重", () => {
    const data = sanitizeRecent({
      items: [
        item("a.artshow", 1),
        { path: "", kind: "external", name: "x", openedAt: 2 },
        { path: "b.artrec", kind: "weird", name: "b", openedAt: 3 },
        item("c.artrec", 5, "library"),
        item("A.artshow", 0),
      ],
    });
    expect(data.items.map((x) => x.path)).toEqual(["c.artrec", "a.artshow"]);
    expect(sanitizeRecent(null).items).toEqual([]);
  });

  it("文件名主干、所在文件夹与相对时间", () => {
    expect(fileStem("D:\\rec\\开场.artrec")).toBe("开场");
    expect(fileStem("D:/x/备份.artshow")).toBe("备份");
    expect(folderOf("D:\\rec\\开场.artrec")).toBe("D:\\rec");
    const now = Date.UTC(2026, 9, 27, 12);
    expect(relativeTime(now - 3 * 60_000, now, "zh-CN")).toBe("3分钟前");
    expect(relativeTime(now - 24 * 3600_000, now, "zh-CN")).toBe("昨天");
    expect(relativeTime(now - 2 * 3600_000, now, "en")).toBe("2 hours ago");
  });
});
