import { describe, expect, it } from "vitest";
import { produce } from "immer";

import type { FixtureModel } from "@/features/fixtures";
import {
  ensureFixtureTracks,
  fixturesOfTracks,
  groupFixtures,
  renameByPattern,
  sameModelIds,
  syncFixtures,
  tracksOfFixtures,
} from "../fixtureBatch";
import { addFixtures } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { parseProject } from "../schema";
import { DIMMER, RGBW } from "./testkit";

/** 带一个附加模式的 RGBW。 */
const RGBW_MODES: FixtureModel = { ...RGBW, modes: [{ id: "m8", name: "8CH", properties: RGBW.properties }] };

/** 3 台 RGBW（地址 1 / 5 / 9）+ 1 台调光灯；第一台设了模式、安装参数和一个镜像。 */
function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW_MODES, 3);
    addFixtures(d, DIMMER, 1);
    const f = d.fixtures[0];
    f.modeId = "m8";
    f.stage = { x: 1, y: 2, z: 4, rotation: 90, hanging: true };
    f.mirrors = [{ universe: 1, address: 101 }];
  });
}

const ids = (p: ShowProject) => p.fixtures.map((f) => f.id);

describe("灯具批量操作", () => {
  it("同步：模式只给同型号，安装参数全部复制，位置不动；镜像按相对地址", () => {
    const p = base();
    let r = { changed: 0, modeSkipped: 0 };
    const q = produce(p, (d) => {
      r = syncFixtures(d, ids(p)[0], ids(p), ["mode", "height", "rotation", "hanging", "mirrors"]);
    });
    expect(r).toEqual({ changed: 3, modeSkipped: 1 });
    expect(q.fixtures.map((f) => f.modeId)).toEqual(["m8", "m8", "m8", undefined]);
    for (const f of q.fixtures.slice(1)) expect(f.stage).toMatchObject({ z: 4, rotation: 90, hanging: true });
    // 基准灯不变；其它灯保持各自的位置
    expect(q.fixtures[0]).toEqual(p.fixtures[0]);
    expect(new Set(q.fixtures.map((f) => f.stage?.x)).size).toBeGreaterThan(1);
    // 源灯镜像 = 地址 +1 Universe、+100 通道
    expect(q.fixtures[1].mirrors).toEqual([{ universe: 1, address: 105 }]);
    expect(q.fixtures[2].mirrors).toEqual([{ universe: 1, address: 109 }]);
    expect(parseProject(JSON.stringify(q)).ok).toBe(true);
  });

  it("只勾选部分设置项：没勾的不动；没有可改的返回 0", () => {
    const p = base();
    const q = produce(p, (d) => void syncFixtures(d, ids(p)[0], [ids(p)[1]], ["hanging"]));
    expect(q.fixtures[1].modeId).toBeUndefined();
    expect(q.fixtures[1].stage?.hanging).toBe(true);
    expect(q.fixtures[1].mirrors).toBeUndefined();
    let r = { changed: -1, modeSkipped: -1 };
    produce(p, (d) => {
      r = syncFixtures(d, ids(p)[0], [ids(p)[0]], ["mode"]);
    });
    expect(r).toEqual({ changed: 0, modeSkipped: 0 });
  });

  it("按模板重命名：{n} 为序号、{name} 为原名，没有 {n} 时补在末尾", () => {
    const p = base();
    const a = produce(p, (d) => void renameByPattern(d, ids(p).slice(0, 3), "前排 {n}", 1));
    expect(a.fixtures.map((f) => f.name).slice(0, 3)).toEqual(["前排 1", "前排 2", "前排 3"]);
    const b = produce(p, (d) => void renameByPattern(d, [ids(p)[3]], "后排", 5));
    expect(b.fixtures[3].name).toBe("后排 5");
    const c = produce(p, (d) => void renameByPattern(d, [ids(p)[0]], "{name}-L{n}"));
    expect(c.fixtures[0].name).toBe("RGBW全彩灯 1-L1");
    let n = -1;
    produce(p, (d) => {
      n = renameByPattern(d, ids(p), "   ");
    });
    expect(n).toBe(0);
  });

  it("同型号、轨道与灯具互查、编组（按 Patch 顺序）", () => {
    const p = base();
    expect(sameModelIds(p, [ids(p)[1]])).toEqual(ids(p).slice(0, 3));
    const tracks = tracksOfFixtures(p, [ids(p)[2], ids(p)[0]]);
    expect(tracks).toHaveLength(2);
    expect(fixturesOfTracks(p, tracks)).toEqual([ids(p)[0], ids(p)[2]]);
    const q = produce(p, (d) => void groupFixtures(d, "侧光", [ids(p)[2], ids(p)[0]]));
    expect(q.groups[0]).toMatchObject({ name: "侧光", fixtureIds: [ids(p)[0], ids(p)[2]] });
    expect(q.tracks.at(-1)?.target).toEqual({ kind: "group", id: q.groups[0].id });
  });

  it("补建缺少的轨道", () => {
    const p = produce(base(), (d) => {
      d.tracks = d.tracks.slice(1);
    });
    let n = 0;
    const q = produce(p, (d) => {
      n = ensureFixtureTracks(d);
    });
    expect(n).toBe(1);
    expect(fixturesOfTracks(q, q.tracks.map((t) => t.id)).sort()).toEqual([...ids(p)].sort());
  });
});
