import { describe, expect, it } from "vitest";

import type { UniverseSnapshot } from "@/shared/domain/engine";
import { newDestination, type ForwardDestination } from "@/features/forwarding/lib/types";
import { PLAYER_SOURCE_ID } from "../activity";
import { buildFlowList } from "../listModel";

const uni = (universe: number, over: Partial<UniverseSnapshot> = {}): UniverseSnapshot => ({
  universe,
  protocol: "artNet",
  sourceIps: ["10.0.0.1"],
  sourceCount: 1,
  activeChannels: 100,
  conflictChannels: 0,
  totalPackets: 0,
  packetRate: 44,
  sources: [{ ip: "10.0.0.1", packets: 0, packetRate: 44 }],
  ...over,
});
const dest = (id: string, over: Partial<ForwardDestination> = {}): ForwardDestination => ({
  ...newDestination(),
  id,
  name: id,
  targetIp: "10.0.1.1",
  ...over,
});

describe("buildFlowList Universe 路径", () => {
  it("每个 Universe 一行，带速率、通道与去向", () => {
    const list = buildFlowList([uni(1), uni(2, { packetRate: 0, sources: [] })], [dest("a")]);
    expect(list.rows.map((r) => r.universe)).toEqual([1, 2]);
    expect(list.rows[0]).toMatchObject({ active: true, packetRate: 44, activeChannels: 100 });
    expect(list.rows[1].active).toBe(false);
    expect(list.rows[0].destinations).toEqual([
      { id: "a", name: "a", enabled: true, active: true },
    ]);
    expect(list.rows[1].destinations[0]).toMatchObject({ id: "a", active: false });
  });

  it("来源按 IP 数值排序，并带各自在该 Universe 上的速率", () => {
    const list = buildFlowList(
      [
        uni(1, {
          sourceIps: ["10.0.0.10", "10.0.0.2"],
          sourceCount: 2,
          sources: [
            { ip: "10.0.0.10", packets: 0, packetRate: 30 },
            { ip: "10.0.0.2", packets: 0, packetRate: 0 },
          ],
        }),
      ],
      [],
    );
    expect(list.rows[0].sources).toEqual([
      { ip: "10.0.0.2", isPlayer: false, packetRate: 0, active: false },
      { ip: "10.0.0.10", isPlayer: false, packetRate: 30, active: true },
    ]);
  });

  it("按转发模式与覆盖只列出会收到该 Universe 的目的地", () => {
    const list = buildFlowList(
      [uni(1), uni(2)],
      [
        dest("sel", { mode: "selected", overrides: [{ sourceUniverse: 2, action: "forward" }] }),
        dest("ex", { overrides: [{ sourceUniverse: 1, action: "exclude" }] }),
      ],
    );
    expect(list.rows[0].destinations.map((d) => d.id)).toEqual([]);
    expect(list.rows[1].destinations.map((d) => d.id)).toEqual(["sel", "ex"]);
  });

  it("停用的目的地仍列出，但没有信号", () => {
    const list = buildFlowList([uni(1)], [dest("off", { enabled: false })]);
    expect(list.rows[0].destinations[0]).toMatchObject({ enabled: false, active: false });
  });

  it("冲突级别随合并模式", () => {
    const u = uni(1, { sourceCount: 2, conflictChannels: 5 });
    expect(buildFlowList([u], [], { mergeMode: "htp" }).rows[0].conflict).toBe("info");
    expect(buildFlowList([u], [], { mergeMode: "priority" }).rows[0].conflict).toBe("warning");
  });

  it("不做聚合：Universe 再多也逐行列出", () => {
    const many = Array.from({ length: 120 }, (_, i) => uni(i + 1));
    expect(buildFlowList(many, []).rows).toHaveLength(120);
  });
});

describe("buildFlowList 来源与目的地汇总", () => {
  it("来源汇总 Universe 数、速率与是否有信号", () => {
    const list = buildFlowList(
      [
        uni(1, { sources: [{ ip: "10.0.0.1", packets: 0, packetRate: 40 }] }),
        uni(2, { sources: [{ ip: "10.0.0.1", packets: 0, packetRate: 20 }] }),
      ],
      [],
    );
    expect(list.sources).toEqual([
      { ip: "10.0.0.1", isPlayer: false, packetRate: 60, active: true, universeCount: 2 },
    ]);
  });

  it("目的地行带地址、模式、偏移、延迟、发送速率与转发的 Universe 数", () => {
    const list = buildFlowList(
      [uni(1), uni(2)],
      [dest("a", { port: 7000, universeOffset: 100, defaultDelayMs: 20, mode: "selected", overrides: [{ sourceUniverse: 1, action: "forward" }] })],
      { destStats: new Map([["a", { sentRate: 55 }]]) },
    );
    expect(list.destinations[0]).toEqual({
      id: "a",
      name: "a",
      ip: "10.0.1.1",
      port: 7000,
      protocol: "artNet",
      mode: "selected",
      enabled: true,
      universeOffset: 100,
      delayMs: 20,
      sentRate: 55,
      active: true,
      universeCount: 1,
    });
  });

  it("没有统计或已停用时不算有信号", () => {
    const list = buildFlowList(
      [uni(1)],
      [dest("a"), dest("b", { enabled: false })],
      { destStats: new Map([["b", { sentRate: 99 }]]) },
    );
    expect(list.destinations.map((d) => d.active)).toEqual([false, false]);
  });
});

describe("buildFlowList 回放", () => {
  it("回放伪源：播放中有信号，暂停时没有", () => {
    const u = uni(1, { sourceIps: [PLAYER_SOURCE_ID], packetRate: 0, sources: [] });
    const playing = buildFlowList([u], [dest("a")], { playerActive: true });
    expect(playing.rows[0]).toMatchObject({ active: true });
    expect(playing.rows[0].sources[0]).toMatchObject({ isPlayer: true, active: true });
    expect(playing.sources[0]).toMatchObject({ isPlayer: true, active: true });
    const paused = buildFlowList([u], [dest("a")], { playerActive: false });
    expect(paused.rows[0].active).toBe(false);
  });
});