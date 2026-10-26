import { describe, expect, it } from "vitest";

import type { UniverseSnapshot } from "@/shared/domain/engine";
import {
  EMPTY_FILTER,
  buildFileStem,
  expandRanges,
  formatBytes,
  formatDurationUs,
  matchesParts,
  parseUniverseRanges,
  previewUniverses,
} from "../filter";

const snap = (
  universe: number,
  ips: string[],
  protocol: UniverseSnapshot["protocol"] = "artNet",
): UniverseSnapshot => ({
  universe,
  protocol,
  sourceIps: ips,
  sourceCount: ips.length,
  activeChannels: 1,
  conflictChannels: 0,
  totalPackets: 1,
  packetRate: 0,
  sources: [],
});

describe("parseUniverseRanges", () => {
  it("解析单值与范围，忽略非法片段，交换反向范围", () => {
    expect(parseUniverseRanges("0-3, 10 ,abc, 9-5")).toEqual([
      { start: 0, end: 3 },
      { start: 10, end: 10 },
      { start: 5, end: 9 },
    ]);
    expect(parseUniverseRanges("")).toEqual([]);
  });

  it("支持中文逗号并限制上界", () => {
    expect(parseUniverseRanges("1，2")).toEqual([
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ]);
    expect(parseUniverseRanges("99999")[0].start).toBe(65535);
  });
});

describe("expandRanges", () => {
  it("去重升序并受 limit 保护", () => {
    expect(
      expandRanges([
        { start: 3, end: 5 },
        { start: 4, end: 6 },
      ]),
    ).toEqual([3, 4, 5, 6]);
    expect(expandRanges([{ start: 0, end: 65535 }], 10)).toHaveLength(10);
  });
});

describe("matchesParts（与后端语义一致）", () => {
  it("来源白名单 / 黑名单 / 未知来源", () => {
    const wl = { ...EMPTY_FILTER, sources: ["10.0.0.1"] };
    expect(matchesParts(wl, "artNet", 1, "10.0.0.1")).toBe(true);
    expect(matchesParts(wl, "artNet", 1, "10.0.0.2")).toBe(false);
    expect(matchesParts(wl, "artNet", 1, null)).toBe(false);
    const bl = { ...wl, excludeSources: true };
    expect(matchesParts(bl, "artNet", 1, "10.0.0.1")).toBe(false);
    expect(matchesParts(bl, "artNet", 1, null)).toBe(true);
  });

  it("Universe 范围与协议取交集", () => {
    const f = {
      ...EMPTY_FILTER,
      universes: [{ start: 0, end: 3 }],
      protocols: ["artNet" as const],
    };
    expect(matchesParts(f, "artNet", 2, null)).toBe(true);
    expect(matchesParts(f, "artNet", 4, null)).toBe(false);
    expect(matchesParts(f, "sacn", 2, null)).toBe(false);
  });
});

describe("previewUniverses", () => {
  it("按来源过滤当前活跃 Universe，并并入手动指定项", () => {
    const filter = { ...EMPTY_FILTER, sources: ["10.0.0.1"] };
    const plan = previewUniverses(
      [snap(1, ["10.0.0.1"]), snap(2, ["10.0.0.2"]), snap(3, ["10.0.0.1", "10.0.0.2"])],
      filter,
      [40],
    );
    expect(plan.accepted).toEqual([1, 3, 40]);
  });

  it("超出 2047 的 Universe 与超过 127 路的部分被拒绝", () => {
    const many = Array.from({ length: 130 }, (_, i) => snap(i, ["10.0.0.1"]));
    const plan = previewUniverses([...many, snap(3000, ["10.0.0.1"])], EMPTY_FILTER, []);
    expect(plan.accepted).toHaveLength(127);
    expect(plan.rejectedOverCapacity).toEqual([127, 128, 129]);
    expect(plan.rejectedOutOfRange).toEqual([3000]);
  });
});

describe("格式化", () => {
  it("文件名主干含本地时间戳", () => {
    const d = new Date(2026, 9, 25, 14, 3, 9);
    expect(buildFileStem(d, "开场")).toBe("20261025-140309_开场");
    expect(buildFileStem(d, "  ")).toBe("20261025-140309");
  });

  it("时长与字节数", () => {
    expect(formatDurationUs(0)).toBe("0:00.0");
    expect(formatDurationUs(65_300_000)).toBe("1:05.3");
    expect(formatDurationUs(3_725_000_000)).toBe("1:02:05.0");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});
