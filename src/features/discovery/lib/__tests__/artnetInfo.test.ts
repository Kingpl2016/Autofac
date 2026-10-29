import { describe, expect, it } from "vitest";

import type { NodePort } from "@/shared/domain/device";
import { artnetInfo } from "../artnetInfo";
import { makeDevice } from "@/test/factories";

const dev = makeDevice;

const port = (index: number, universe: number, direction: NodePort["direction"] = "output"): NodePort => ({
  index,
  direction,
  universe,
  active: true,
});

describe("artnetInfo", () => {
  it("统计去重后的 Universe 数，并带上固件版本", () => {
    const info = artnetInfo(
      dev({ firmware: " 2.5 ", ports: [port(0, 1), port(1, 2), port(2, 1, "input")] }),
    );
    expect(info).toEqual({ universes: 2, firmware: "2.5", haPeer: false });
  });

  it("没有端口信息时 Universe 数为 null，固件为空串时视为未上报", () => {
    expect(artnetInfo(dev({ firmware: "  " }))).toEqual({
      universes: null,
      firmware: null,
      haPeer: false,
    });
    expect(artnetInfo(dev({ ports: [] }))?.universes).toBeNull();
  });

  it("集群设备标记为 HA 对端", () => {
    expect(artnetInfo(dev({ category: "cluster", firmware: "1.0" }))).toEqual({
      universes: null,
      firmware: null,
      haPeer: true,
    });
  });

  it("sACN、计算机、其它设备没有这一列的信息", () => {
    for (const category of ["sacn", "computer", "network"] as const) {
      expect(artnetInfo(dev({ category, firmware: "1.0" }))).toBeNull();
    }
  });
});