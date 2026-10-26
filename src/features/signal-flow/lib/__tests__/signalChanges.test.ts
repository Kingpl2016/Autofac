import { describe, expect, it } from "vitest";

import type { FlowList } from "../listModel";
import { diffSignal, signalItems, type SignalItem } from "../signalChanges";

const item = (key: string, active: boolean, kind: SignalItem["kind"] = "source"): SignalItem => ({
  key,
  kind,
  label: key,
  active,
});
const map = (...items: SignalItem[]) => new Map(items.map((i) => [i.key, i]));

describe("diffSignal", () => {
  it("第一次（没有上一次）不产生任何变化", () => {
    expect(diffSignal(null, [item("a", true)])).toEqual({ gained: [], lost: [] });
  });

  it("状态没变不播报", () => {
    const prev = map(item("a", true), item("b", false));
    expect(diffSignal(prev, [item("a", true), item("b", false)])).toEqual({ gained: [], lost: [] });
  });

  it("无信号 → 有信号 / 有信号 → 无信号", () => {
    const prev = map(item("a", true), item("b", false));
    const r = diffSignal(prev, [item("a", false), item("b", true)]);
    expect(r.gained.map((i) => i.key)).toEqual(["b"]);
    expect(r.lost.map((i) => i.key)).toEqual(["a"]);
  });

  it("新出现且有信号算“有信号”；新出现但没信号不播报", () => {
    const r = diffSignal(map(), [item("a", true), item("b", false)]);
    expect(r.gained.map((i) => i.key)).toEqual(["a"]);
    expect(r.lost).toEqual([]);
  });

  it("消失的对象：原先有信号算“信号中断”，原先就没信号不播报", () => {
    const prev = map(item("a", true), item("b", false));
    const r = diffSignal(prev, []);
    expect(r.lost.map((i) => i.key)).toEqual(["a"]);
    expect(r.lost[0].active).toBe(false);
  });
});

describe("signalItems", () => {
  it("取来源与目的地，回放伪源用节目名", () => {
    const list: FlowList = {
      rows: [],
      sources: [
        { ip: "10.0.0.1", isPlayer: false, packetRate: 1, active: true, universeCount: 1 },
        { ip: "__player__", isPlayer: true, packetRate: 0, active: false, universeCount: 2 },
      ],
      destinations: [
        {
          id: "d1", name: "舞台左", ip: "10.0.0.5", port: 6454, protocol: "artNet", mode: "all",
          enabled: true, universeOffset: 0, delayMs: 0, sentRate: 1, active: true, universeCount: 1,
        },
      ],
    };
    expect(signalItems(list, "开场秀")).toEqual([
      { key: "src:10.0.0.1", kind: "source", label: "10.0.0.1", active: true },
      { key: "src:__player__", kind: "source", label: "开场秀", active: false },
      { key: "dst:d1", kind: "destination", label: "舞台左", active: true },
    ]);
  });
});