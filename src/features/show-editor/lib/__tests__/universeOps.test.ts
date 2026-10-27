import { produce } from "immer";
import { describe, expect, it } from "vitest";

import type { Device } from "@/shared/domain/device";
import { addFixtures } from "../ops";
import { analyzePatch, channelOwners, nextFreeSlot, sequentialAddresses, universeUsage, usedUniverses } from "../patch";
import { createEmptyProject, type ShowProject } from "../project";
import { projectIntegrityIssues } from "../schema";
import {
  addMirror,
  addPort,
  addUniverseConfig,
  autoRouteToNodes,
  checkRouting,
  defaultPort,
  fillMissingUniverses,
  isIpv4,
  nodeOutputs,
  portIssue,
  removeMirror,
  repatchSequential,
  routeToNode,
  setFixtureMode,
  setMirror,
  setSync,
  updatePort,
} from "../universeOps";
import { DIMMER, HEAD16, RGBW } from "./testkit";

/** 3 台 RGBW（U0 @1/5/9）+ 1 台 16CH 摇头灯（U0 @13）。 */
function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 3);
    addFixtures(d, HEAD16, 1);
  });
}

describe("多重配接（镜像地址）", () => {
  it("默认放在下一个 Universe 的同一地址；参与冲突检测、占用统计与空位查找", () => {
    const p = produce(base(), (d) => {
      addMirror(d, d.fixtures[0].id);
    });
    const f = p.fixtures[0];
    expect(f.mirrors).toEqual([{ universe: 1, address: 1 }]);
    expect(usedUniverses(p.fixtures)).toEqual([0, 1]);
    expect(universeUsage(p).get(1)).toBe(4);
    // U1 的 1~4 被镜像占用，空位从 5 开始
    expect(nextFreeSlot(p, 4, 1)).toEqual({ universe: 1, address: 5 });
    expect(analyzePatch(p).get(f.id)?.mirrors).toEqual([{ universe: 1, start: 1, end: 4 }]);
    expect(projectIntegrityIssues(p)).toEqual([]);
  });

  it("镜像压在别的灯具上时两边都报冲突；自己的镜像与主地址重叠也算冲突", () => {
    const p = produce(base(), (d) => {
      addMirror(d, d.fixtures[0].id, { universe: 0, address: 6 });
      addMirror(d, d.fixtures[3].id, { universe: 0, address: 14 });
    });
    const status = analyzePatch(p);
    expect(status.get(p.fixtures[0].id)?.conflictsWith).toContain(p.fixtures[1].id);
    expect(status.get(p.fixtures[1].id)?.conflictsWith).toContain(p.fixtures[0].id);
    expect(status.get(p.fixtures[3].id)?.conflictsWith).toContain(p.fixtures[3].id);
  });

  it("修改 / 删除镜像；地址夹回合法范围，删空后去掉字段", () => {
    const p = produce(base(), (d) => {
      const id = d.fixtures[0].id;
      addMirror(d, id);
      setMirror(d, id, 0, { universe: 9999, address: 700 });
    });
    expect(p.fixtures[0].mirrors).toEqual([{ universe: 2047, address: 512 }]);
    expect(analyzePatch(p).get(p.fixtures[0].id)?.overflow).toBe(true);
    const q = produce(p, (d) => removeMirror(d, d.fixtures[0].id, 0));
    expect(q.fixtures[0].mirrors).toBeUndefined();
  });
});

describe("顺序配接", () => {
  it("放不下时自动换到下一个 Universe 的 1 号地址，可以留间隔", () => {
    expect(sequentialAddresses([200, 200, 200], { universe: 3, address: 1 })).toEqual([
      { universe: 3, address: 1 },
      { universe: 3, address: 201 },
      { universe: 4, address: 1 },
    ]);
    expect(sequentialAddresses([4, 4], { universe: 0, address: 1 }, 2)).toEqual([
      { universe: 0, address: 1 },
      { universe: 0, address: 7 },
    ]);
    expect(sequentialAddresses([600, 4], { universe: 0, address: 1 })).toEqual([null, null]);
    expect(sequentialAddresses([4, 4], { universe: 2047, address: 509 })).toEqual([{ universe: 2047, address: 509 }, null]);
  });

  it("按给定顺序重新配接所选灯具，返回实际移动的数量", () => {
    let moved = 0;
    const p = produce(base(), (d) => {
      moved = repatchSequential(d, [d.fixtures[2].id, d.fixtures[0].id], { universe: 5, address: 510 });
    });
    expect(moved).toBe(2);
    expect(p.fixtures[2]).toMatchObject({ universe: 6, address: 1 });
    expect(p.fixtures[0]).toMatchObject({ universe: 6, address: 5 });
    expect(p.fixtures[1]).toMatchObject({ universe: 0, address: 5 });
  });
});

describe("通道模式与通道归属", () => {
  it("切换模式改变占用通道数；不存在的模式回到默认", () => {
    const model = { ...RGBW, id: "m2", modes: [{ id: "8ch", name: "8ch", properties: [{ ...RGBW.properties[0], channel: 8 }] }] };
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, model, 1);
      setFixtureMode(d, d.fixtures[0].id, "8ch");
    });
    expect(p.fixtures[0].modeId).toBe("8ch");
    expect(analyzePatch(p).get(p.fixtures[0].id)?.range).toEqual({ universe: 0, start: 1, end: 8 });
    const q = produce(p, (d) => setFixtureMode(d, d.fixtures[0].id, "nope"));
    expect(q.fixtures[0].modeId).toBeUndefined();
  });

  it("查出通道属于哪台灯具的哪个属性，16 位属性区分 Fine", () => {
    const p = base();
    expect(channelOwners(p, 0, 6)).toEqual([
      { fixtureId: p.fixtures[1].id, fixtureName: p.fixtures[1].name, property: "Green", fine: false, mirror: false },
    ]);
    // 摇头灯在 13 起：Pan 占 13~14（小端，13 为 Fine）
    expect(channelOwners(p, 0, 13)[0]).toMatchObject({ property: "Pan", fine: true });
    expect(channelOwners(p, 0, 14)[0]).toMatchObject({ property: "Pan", fine: false });
    expect(channelOwners(p, 0, 17)[0]).toMatchObject({ property: "" });
    expect(channelOwners(p, 0, 100)).toEqual([]);
  });
});

describe("Universe 路由表", () => {
  it("补全用到的 Universe（默认 Art-Net 广播），已有的不重复；表按编号排序", () => {
    const p = produce(base(), (d) => {
      addMirror(d, d.fixtures[0].id, { universe: 3, address: 1 });
      addUniverseConfig(d, 7);
      fillMissingUniverses(d);
      fillMissingUniverses(d);
    });
    expect(p.output.universes.map((u) => u.universe)).toEqual([0, 3, 7]);
    expect(p.output.universes[0].ports[0]).toMatchObject({ protocol: "artNet", mode: "broadcast", ip: "255.255.255.255", remoteUniverse: 0 });
    expect(checkRouting(p)).toMatchObject({ unrouted: [], unused: [7], duplicates: [] });
    expect(projectIntegrityIssues(p)).toEqual([]);
  });

  it("切换协议换成该协议的默认寻址；Art-Net 不能选组播；数值夹回协议范围", () => {
    const p = produce(base(), (d) => {
      addUniverseConfig(d, 0);
      const id = d.output.universes[0].ports[0].id;
      updatePort(d, 0, id, { protocol: "sacn" });
    });
    const port = p.output.universes[0].ports[0];
    expect(port).toMatchObject({ protocol: "sacn", mode: "multicast", port: 5568, remoteUniverse: 1, priority: 100 });
    const q = produce(p, (d) => {
      const id = d.output.universes[0].ports[0].id;
      updatePort(d, 0, id, { remoteUniverse: 0, priority: 999 });
      updatePort(d, 0, id, { protocol: "artNet" });
      updatePort(d, 0, id, { mode: "multicast", remoteUniverse: 99_999 });
    });
    expect(q.output.universes[0].ports[0]).toMatchObject({ protocol: "artNet", mode: "unicast", remoteUniverse: 32767 });
    expect(q.output.universes[0].ports[0].priority).toBeUndefined();
  });

  it("端口校验与后端一致：停用的不校验", () => {
    const ok = defaultPort(0);
    expect(portIssue(ok)).toBeNull();
    expect(portIssue({ ...ok, mode: "unicast", ip: "10.0.0.256" })).toBe("badIp");
    expect(portIssue({ ...ok, mode: "multicast" })).toBe("multicastArtNet");
    expect(portIssue({ ...defaultPort(0, "sacn"), remoteUniverse: 0 })).toBe("remoteUniverse");
    expect(portIssue({ ...ok, ip: "坏地址", mode: "unicast", enabled: false })).toBeNull();
    expect(isIpv4("192.168.1.10")).toBe(true);
    expect(isIpv4("192.168.01.10")).toBe(false);
  });

  it("多个 Universe 发往同一目标时报重复；没有可用端口的 Universe 报未路由", () => {
    const p = produce(base(), (d) => {
      addMirror(d, d.fixtures[0].id, { universe: 1, address: 1 });
      addUniverseConfig(d, 0);
      addUniverseConfig(d, 1);
      const port = d.output.universes[1].ports[0];
      updatePort(d, 1, port.id, { remoteUniverse: 0 });
      addPort(d, 1, { ...defaultPort(1), mode: "unicast", ip: "x" });
    });
    const report = checkRouting(p);
    expect(report.duplicates).toEqual([{ key: "artNet|255.255.255.255|0", universes: [0, 1] }]);
    expect(report.portIssues.size).toBe(1);
    const q = produce(p, (d) => {
      d.output.universes[1].ports = d.output.universes[1].ports.map((x) => ({ ...x, enabled: false }));
    });
    expect(checkRouting(q).unrouted).toEqual([1]);
  });

  it("帧同步：sACN 同步 Universe 夹回 1~63999，null 关闭", () => {
    const p = produce(base(), (d) => {
      setSync(d, { artSync: true, sacnSyncUniverse: 70_000 });
    });
    expect(p.output.sync).toEqual({ artSync: true, sacnSyncUniverse: 63_999 });
    expect(produce(p, (d) => setSync(d, { sacnSyncUniverse: null })).output.sync.sacnSyncUniverse).toBeNull();
  });
});

describe("从发现的节点生成路由", () => {
  const device = (ip: string, ports: number[], over: Partial<Device> = {}): Device => ({
    ip,
    hostname: null,
    customName: null,
    mac: null,
    category: "artNet",
    artnetPorts: ports.length,
    online: true,
    lastSeenMs: 0,
    shortName: `Node ${ip}`,
    ports: ports.map((universe, index) => ({ index, direction: "output", universe, active: false })),
    ...over,
  });

  it("只列在线 Art-Net 节点的输出口，按 IP 数值顺序", () => {
    const outputs = nodeOutputs([
      device("10.0.0.20", [5]),
      device("10.0.0.3", [0, 1]),
      device("10.0.0.4", [9], { online: false }),
      device("10.0.0.5", [9], { category: "sacn" }),
    ]);
    expect(outputs.map((o) => `${o.ip}#${o.index}:${o.remoteUniverse}`)).toEqual([
      "10.0.0.3#0:0",
      "10.0.0.3#1:1",
      "10.0.0.20#0:5",
    ]);
  });

  it("一键分配：用到的 Universe 依次对应节点输出口（单播），替换原有端口", () => {
    const nodes = nodeOutputs([device("10.0.0.3", [16, 17])]);
    let n = 0;
    const p = produce(base(), (d) => {
      addMirror(d, d.fixtures[0].id, { universe: 4, address: 1 });
      fillMissingUniverses(d);
      n = autoRouteToNodes(d, nodes);
    });
    expect(n).toBe(2);
    expect(p.output.universes.map((u) => [u.universe, u.ports.map((x) => `${x.mode}:${x.ip}:${x.remoteUniverse}`)])).toEqual([
      [0, ["unicast:10.0.0.3:16"]],
      [4, ["unicast:10.0.0.3:17"]],
    ]);
    expect(p.output.universes[0].label).toBe("Node 10.0.0.3 #1");
    // 同一目标不重复添加
    const q = produce(p, (d) => routeToNode(d, 0, nodes[0]));
    expect(q.output.universes[0].ports).toHaveLength(1);
    expect(projectIntegrityIssues(q)).toEqual([]);
  });

  it("没有用到 DIMMER 之外的 Universe 时，多余的节点口不分配", () => {
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, DIMMER, 1);
      autoRouteToNodes(d, nodeOutputs([device("10.0.0.3", [0, 1, 2])]));
    });
    expect(p.output.universes.map((u) => u.universe)).toEqual([0]);
  });
});
