import { describe, expect, it } from "vitest";

import type { UniverseSnapshot } from "@/shared/domain/engine";
import { conflictLevel } from "@/shared/lib/conflict";
import { UNIVERSE_CARD_LIMIT, portAddress, sourcesOf, visibleUniverses } from "../universeView";

const snap = (universe: number, over: Partial<UniverseSnapshot> = {}): UniverseSnapshot => ({
  universe,
  protocol: "artNet",
  sourceIps: [],
  sourceCount: 0,
  activeChannels: 0,
  conflictChannels: 0,
  totalPackets: 0,
  packetRate: 0,
  sources: [],
  ...over,
});

describe("conflictLevel", () => {
  it("没有冲突通道时为 none，与模式无关", () => {
    expect(conflictLevel("htp", 0)).toBe("none");
    expect(conflictLevel("ltp", 0)).toBe("none");
  });

  it("HTP 下只是提示，LTP / Priority 才是警告", () => {
    expect(conflictLevel("htp", 12)).toBe("info");
    expect(conflictLevel("ltp", 12)).toBe("warning");
    expect(conflictLevel("priority", 1)).toBe("warning");
  });
});

describe("portAddress", () => {
  it("拆成 Net:Sub:Uni", () => {
    expect(portAddress(0)).toBe("0:0:0");
    expect(portAddress(1)).toBe("0:0:1");
    expect(portAddress((2 << 8) | (1 << 4) | 3)).toBe("2:1:3");
    expect(portAddress(0x7fff)).toBe("127:15:15");
  });
});

describe("sourcesOf", () => {
  it("按 IP 数值排序", () => {
    const u = snap(1, {
      sources: [
        { ip: "10.0.0.10", packets: 1, packetRate: 5 },
        { ip: "10.0.0.2", packets: 1, packetRate: 7 },
      ],
    });
    expect(sourcesOf(u).map((s) => s.ip)).toEqual(["10.0.0.2", "10.0.0.10"]);
  });

  it("没有逐源统计时退回 sourceIps，速率为 0", () => {
    const u = snap(1, { sourceIps: ["PLAYER"] });
    expect(sourcesOf(u)).toEqual([{ ip: "PLAYER", packets: 0, packetRate: 0 }]);
  });

  it("不修改快照里原有的数组", () => {
    const sources = [
      { ip: "10.0.0.10", packets: 1, packetRate: 0 },
      { ip: "10.0.0.2", packets: 1, packetRate: 0 },
    ];
    sourcesOf(snap(1, { sources }));
    expect(sources[0].ip).toBe("10.0.0.10");
  });
});

describe("visibleUniverses", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => snap(i));

  it("卡片视图超过上限时截取并报告隐藏数", () => {
    const r = visibleUniverses(many(UNIVERSE_CARD_LIMIT + 20), "cards");
    expect(r.items).toHaveLength(UNIVERSE_CARD_LIMIT);
    expect(r.hidden).toBe(20);
  });

  it("恰好等于上限时不截取", () => {
    const r = visibleUniverses(many(UNIVERSE_CARD_LIMIT), "cards");
    expect(r.hidden).toBe(0);
  });

  it("表格视图永远显示全部", () => {
    const r = visibleUniverses(many(200), "table");
    expect(r.items).toHaveLength(200);
    expect(r.hidden).toBe(0);
  });
});