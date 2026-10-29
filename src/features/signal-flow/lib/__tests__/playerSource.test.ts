import { describe, expect, it } from "vitest";

import { EMPTY_PLAYBACK, type PlaybackStatus } from "@/features/recording/lib/types";
import type { ForwardDestination } from "@/features/forwarding/lib/types";
import { PLAYER_SOURCE_ID } from "../activity";
import { buildGraph } from "../graphModel";
import { PLAYER_DIRECT_ID, playerDestinations, playerUniverses } from "../playerSource";

const status = (over: Partial<PlaybackStatus> = {}): PlaybackStatus => ({
  ...EMPTY_PLAYBACK,
  loaded: true,
  name: "开场秀",
  universes: [5, 6],
  ...over,
});

const dest = (id: string, enabled = true): ForwardDestination => ({
  id,
  name: id,
  targetIp: "10.0.0.2",
  protocol: "artNet",
  port: 6454,
  mode: "all",
  universeOffset: 0,
  defaultDelayMs: 0,
  description: "",
  enabled,
  overrides: [],
});

describe("playerUniverses / playerDestinations", () => {
  it("节目里的 Universe 都以回放伪源作为唯一来源", () => {
    const u = playerUniverses(status());
    expect(u.map((x) => x.universe)).toEqual([5, 6]);
    expect(u.every((x) => x.sourceIps.length === 1 && x.sourceIps[0] === PLAYER_SOURCE_ID)).toBe(true);
  });

  it("走转发表时沿用转发表目的地", () => {
    const table = [dest("a"), dest("b")];
    expect(playerDestinations(status(), table)).toBe(table);
  });

  it("直发时只有一个直发目的地", () => {
    const d = playerDestinations(
      status({ target: { kind: "direct", ip: "192.168.1.9", protocol: "sacn", port: 5568 } }),
      [dest("a")],
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      id: PLAYER_DIRECT_ID,
      targetIp: "192.168.1.9",
      protocol: "sacn",
      port: 5568,
      enabled: true,
    });
  });
});

describe("buildGraph 回放源节点", () => {
  it("回放伪源生成 player 类型节点，并连到 Universe 与目的地", () => {
    const g = buildGraph(playerUniverses(status()), [dest("a")], {
      simplifyThreshold: 50,
      playerName: "开场秀",
      playerActive: true,
    });
    const player = g.nodes.find((n) => n.id === `src:${PLAYER_SOURCE_ID}`);
    expect(player?.type).toBe("player");
    expect(player?.data).toMatchObject({ name: "开场秀", universeCount: 2 });
    expect(g.nodes.filter((n) => n.type === "source")).toHaveLength(0);
    // 源 → 2 个 Universe，2 个 Universe → 目的地
    expect(g.edges.filter((e) => e.source === `src:${PLAYER_SOURCE_ID}`)).toHaveLength(2);
    expect(g.edges.filter((e) => e.target === "dst:a")).toHaveLength(2);
  });

  it("聚合模式下回放源仍是 player 节点", () => {
    const g = buildGraph(playerUniverses(status({ universes: [1, 2, 3] })), [dest("a")], {
      simplifyThreshold: 2,
      playerName: "x",
    });
    expect(g.simplified).toBe(true);
    expect(g.nodes.find((n) => n.id === `src:${PLAYER_SOURCE_ID}`)?.type).toBe("player");
  });

  it("不播放时边没有信号；禁用的目的地标记为 disabled", () => {
    const g = buildGraph(playerUniverses(status()), [dest("a", false)], {
      simplifyThreshold: 50,
      playerName: "x",
      playerActive: false,
    });
    expect(g.edges.every((e) => (e.data as { active: boolean }).active === false)).toBe(true);
    const toDest = g.edges.find((e) => e.target === "dst:a");
    expect(toDest?.data).toMatchObject({ disabled: true });
  });

  it("普通来源仍是 source 节点（回归）", () => {
    const g = buildGraph(
      [
        {
          universe: 1,
          protocol: "artNet",
          sourceIps: ["10.0.0.1"],
          sourceCount: 1,
          activeChannels: 1,
          conflictChannels: 0,
          totalPackets: 1,
          packetRate: 0,
          sources: [],
        },
      ],
      [],
      { simplifyThreshold: 50 },
    );
    expect(g.nodes.find((n) => n.id === "src:10.0.0.1")?.type).toBe("source");
  });
});
