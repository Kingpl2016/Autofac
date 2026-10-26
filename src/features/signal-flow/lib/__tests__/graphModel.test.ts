import { describe, expect, it } from "vitest";

import type { UniverseSnapshot } from "@/shared/domain/engine";
import { newDestination, type ForwardDestination } from "@/features/forwarding/lib/types";
import {
  PLAYER_SOURCE_ID,
  buildGraph,
  type DestinationNodeData,
  type FlowEdgeData,
  type SourceNodeData,
  type UniverseNodeData,
} from "../graphModel";

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

const opts = { simplifyThreshold: 50 };
const node = (g: ReturnType<typeof buildGraph>, id: string) => g.nodes.find((n) => n.id === id);
const edge = (g: ReturnType<typeof buildGraph>, id: string) => g.edges.find((e) => e.id === id);

describe("buildGraph 节点内容", () => {
  it("来源节点汇总 Universe 数、速率与协议", () => {
    const g = buildGraph(
      [
        uni(1, { sources: [{ ip: "10.0.0.1", packets: 0, packetRate: 40 }] }),
        uni(2, { sources: [{ ip: "10.0.0.1", packets: 0, packetRate: 20 }] }),
      ],
      [],
      opts,
    );
    expect(node(g, "src:10.0.0.1")?.data).toMatchObject({
      ip: "10.0.0.1",
      universeCount: 2,
      packetRate: 60,
      protocol: "artNet",
      active: true,
    });
  });

  it("来源同时送 Art-Net 与 sACN 时协议为 mixed", () => {
    const g = buildGraph([uni(1), uni(2, { protocol: "sacn" })], [], opts);
    expect((node(g, "src:10.0.0.1")?.data as SourceNodeData).protocol).toBe("mixed");
  });

  it("Universe 节点带速率、通道、来源数与冲突级别（随合并模式）", () => {
    const u = uni(3, { sourceCount: 2, conflictChannels: 9, activeChannels: 300 });
    const htp = buildGraph([u], [], { ...opts, mergeMode: "htp" });
    const ltp = buildGraph([u], [], { ...opts, mergeMode: "ltp" });
    expect(node(htp, "uni:3")?.data).toMatchObject({
      universe: 3,
      sourceCount: 2,
      packetRate: 44,
      activeChannels: 300,
      conflictChannels: 9,
      conflict: "info",
    });
    expect((node(ltp, "uni:3")?.data as UniverseNodeData).conflict).toBe("warning");
  });

  it("目的地节点带端口、模式、偏移、延迟与发送速率", () => {
    const d = dest("a", {
      port: 7000,
      mode: "selected",
      universeOffset: 100,
      defaultDelayMs: 30,
      overrides: [{ sourceUniverse: 1, action: "forward" }],
    });
    const g = buildGraph([uni(1)], [d], { ...opts, destStats: new Map([["a", { sentRate: 88 }]]) });
    expect(node(g, "dst:a")?.data).toMatchObject({
      name: "a",
      ip: "10.0.1.1",
      port: 7000,
      protocol: "artNet",
      mode: "selected",
      enabled: true,
      universeOffset: 100,
      delayMs: 30,
      sentRate: 88,
      active: true,
    });
  });

  it("目的地：停用、或没有发送速率都不算有信号", () => {
    const stats = new Map([["a", { sentRate: 50 }]]);
    const off = buildGraph([uni(1)], [dest("a", { enabled: false })], { ...opts, destStats: stats });
    expect((node(off, "dst:a")?.data as DestinationNodeData).active).toBe(false);
    const idle = buildGraph([uni(1)], [dest("a")], opts);
    expect((node(idle, "dst:a")?.data as DestinationNodeData).active).toBe(false);
  });
});

describe("buildGraph 排序与布局", () => {
  it("来源按 IP 数值排序（10.0.0.2 在 10.0.0.10 之前）", () => {
    const g = buildGraph(
      [
        uni(1, { sourceIps: ["10.0.0.10"], sources: [] }),
        uni(2, { sourceIps: ["10.0.0.2"], sources: [] }),
      ],
      [],
      opts,
    );
    const ys = (id: string) => node(g, id)?.position.y as number;
    expect(ys("src:10.0.0.2")).toBeLessThan(ys("src:10.0.0.10"));
  });

  it("三列布局：来源、Universe、目的地的 x 依次增大", () => {
    const g = buildGraph([uni(1)], [dest("a")], opts);
    const x = (id: string) => node(g, id)?.position.x as number;
    expect(x("src:10.0.0.1")).toBeLessThan(x("uni:1"));
    expect(x("uni:1")).toBeLessThan(x("dst:a"));
  });
});

describe("buildGraph 边的有信号 / 停用状态", () => {
  it("来源 → Universe：看该来源在该 Universe 上的速率", () => {
    const g = buildGraph(
      [
        uni(1, {
          sourceIps: ["10.0.0.1", "10.0.0.2"],
          sourceCount: 2,
          sources: [
            { ip: "10.0.0.1", packets: 0, packetRate: 44 },
            { ip: "10.0.0.2", packets: 0, packetRate: 0 },
          ],
        }),
      ],
      [],
      opts,
    );
    expect((edge(g, "src:10.0.0.1->uni:1")?.data as FlowEdgeData).active).toBe(true);
    expect((edge(g, "src:10.0.0.2->uni:1")?.data as FlowEdgeData).active).toBe(false);
  });

  it("没有逐源统计时退化为整个 Universe 的速率", () => {
    const g = buildGraph([uni(1, { sources: [], packetRate: 10 })], [], opts);
    expect((edge(g, "src:10.0.0.1->uni:1")?.data as FlowEdgeData).active).toBe(true);
    const idle = buildGraph([uni(1, { sources: [], packetRate: 0 })], [], opts);
    expect((edge(idle, "src:10.0.0.1->uni:1")?.data as FlowEdgeData).active).toBe(false);
  });

  it("Universe → 目的地：启用且上游有信号才算活跃；停用的目的地标记 disabled", () => {
    const g = buildGraph(
      [uni(1), uni(2, { packetRate: 0, sources: [] })],
      [dest("on"), dest("off", { enabled: false })],
      opts,
    );
    expect(edge(g, "uni:1->dst:on")?.data).toEqual({ active: true, disabled: false });
    expect(edge(g, "uni:2->dst:on")?.data).toEqual({ active: false, disabled: false });
    expect(edge(g, "uni:1->dst:off")?.data).toEqual({ active: false, disabled: true });
  });

  it("按转发模式与覆盖决定是否有连线", () => {
    const g = buildGraph(
      [uni(1), uni(2)],
      [
        dest("sel", { mode: "selected", overrides: [{ sourceUniverse: 2, action: "forward" }] }),
        dest("ex", { overrides: [{ sourceUniverse: 1, action: "exclude" }] }),
      ],
      opts,
    );
    expect(edge(g, "uni:1->dst:sel")).toBeUndefined();
    expect(edge(g, "uni:2->dst:sel")).toBeTruthy();
    expect(edge(g, "uni:1->dst:ex")).toBeUndefined();
    expect(edge(g, "uni:2->dst:ex")).toBeTruthy();
  });

  it("所有边都是自定义的 flow 类型，不再使用 React Flow 内置动画", () => {
    const g = buildGraph([uni(1)], [dest("a")], opts);
    expect(g.edges.length).toBeGreaterThan(0);
    for (const e of g.edges) {
      expect(e.type).toBe("flow");
      expect(e.animated).toBeUndefined();
    }
  });
});

describe("buildGraph 聚合", () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    uni(i + 1, { packetRate: i < 2 ? 40 : 0, sources: [] }),
  );

  it("阈值使用 >=：恰好等于阈值时聚合，少一个则展开", () => {
    expect(buildGraph(many, [], { simplifyThreshold: 5 }).simplified).toBe(true);
    expect(buildGraph(many, [], { simplifyThreshold: 6 }).simplified).toBe(false);
  });

  it("聚合节点汇总总数、活跃数与总速率", () => {
    const g = buildGraph(many, [dest("a")], { simplifyThreshold: 5 });
    expect(g.nodes.filter((n) => n.type === "universe")).toHaveLength(1);
    expect(node(g, "uni:agg")?.data).toMatchObject({
      aggregate: true,
      totalUniverses: 5,
      activeUniverses: 2,
      packetRate: 80,
      active: true,
    });
  });

  it("聚合后到目的地只有一条边，且按是否有信号 / 是否停用着色", () => {
    const on = buildGraph(many, [dest("a")], { simplifyThreshold: 5 });
    expect(edge(on, "uni:agg->dst:a")?.data).toEqual({ active: true, disabled: false });
    const off = buildGraph(many, [dest("a", { enabled: false })], { simplifyThreshold: 5 });
    expect(edge(off, "uni:agg->dst:a")?.data).toEqual({ active: false, disabled: true });
  });

  it("目的地一个 Universe 都不转发时不连线", () => {
    const d = dest("a", { mode: "selected" });
    const g = buildGraph(many, [d], { simplifyThreshold: 5 });
    expect(g.edges.filter((e) => e.target === "dst:a")).toHaveLength(0);
  });
});

describe("buildGraph 回放", () => {
  const playerUni = (n: number): UniverseSnapshot =>
    uni(n, { sourceIps: [PLAYER_SOURCE_ID], packetRate: 0, sources: [] });

  it("回放源节点：播放中有信号，暂停时没有", () => {
    const playing = buildGraph([playerUni(1)], [dest("a")], { ...opts, playerActive: true, playerName: "开场" });
    const paused = buildGraph([playerUni(1)], [dest("a")], { ...opts, playerActive: false });
    expect(node(playing, `src:${PLAYER_SOURCE_ID}`)?.data).toMatchObject({ name: "开场", active: true });
    expect((node(paused, `src:${PLAYER_SOURCE_ID}`)?.data as { active: boolean }).active).toBe(false);
    expect((node(playing, "uni:1")?.data as UniverseNodeData).active).toBe(true);
    expect((edge(playing, `src:${PLAYER_SOURCE_ID}->uni:1`)?.data as FlowEdgeData).active).toBe(true);
    expect((edge(paused, "uni:1->dst:a")?.data as FlowEdgeData).active).toBe(false);
  });
});