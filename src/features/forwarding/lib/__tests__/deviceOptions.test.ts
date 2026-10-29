import { describe, expect, it } from "vitest";

import type { Device } from "@/shared/domain/device";
import {
  applyDeviceSelection,
  applyProtocol,
  defaultPort,
  groupOnlineDevices,
} from "../deviceOptions";
import { newDestination, type ForwardDestination } from "../types";
import { makeDevice } from "@/test/factories";

const dev = (ip: string, over: Partial<Device> = {}): Device => makeDevice({ ip, ...over });

const draft = (over: Partial<ForwardDestination> = {}): ForwardDestination => ({
  ...newDestination(),
  ...over,
});

describe("groupOnlineDevices", () => {
  it("只收录在线设备，空分组不返回，分组顺序固定", () => {
    const groups = groupOnlineDevices(
      [
        dev("10.0.0.3", { category: "computer" }),
        dev("10.0.0.2", { category: "sacn" }),
        dev("10.0.0.1"),
        dev("10.0.0.9", { online: false }),
      ],
      { sacnEnabled: true },
    );
    expect(groups.map((g) => g.id)).toEqual(["artNet", "sacn", "other"]);
    expect(groups.flatMap((g) => g.devices.map((d) => d.ip))).toEqual([
      "10.0.0.1",
      "10.0.0.2",
      "10.0.0.3",
    ]);
  });

  it("sACN 关闭时不收录 sACN 设备", () => {
    const groups = groupOnlineDevices([dev("10.0.0.2", { category: "sacn" }), dev("10.0.0.1")], {
      sacnEnabled: false,
    });
    expect(groups.map((g) => g.id)).toEqual(["artNet"]);
  });

  it("集群与网络设备归入“其他”", () => {
    const groups = groupOnlineDevices(
      [dev("10.0.0.1", { category: "cluster" }), dev("10.0.0.2", { category: "network" })],
      { sacnEnabled: false },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("other");
    expect(groups[0].devices).toHaveLength(2);
  });

  it("组内先按显示名、再按 IP 数值排序", () => {
    const groups = groupOnlineDevices(
      [
        dev("10.0.0.10", { customName: "B灯" }),
        dev("10.0.0.2", { customName: "B灯" }),
        dev("10.0.0.5", { customName: "A灯" }),
      ],
      { sacnEnabled: false },
    );
    expect(groups[0].devices.map((d) => d.ip)).toEqual(["10.0.0.5", "10.0.0.2", "10.0.0.10"]);
  });

  it("没有设备时返回空数组", () => {
    expect(groupOnlineDevices([], { sacnEnabled: true })).toEqual([]);
  });
});

describe("applyProtocol", () => {
  it("端口还是旧协议默认值时，跟随新协议默认值", () => {
    const d = applyProtocol(draft({ protocol: "artNet", port: 6454 }), "sacn");
    expect(d).toMatchObject({ protocol: "sacn", port: 5568 });
    expect(applyProtocol(d, "artNet")).toMatchObject({ protocol: "artNet", port: 6454 });
  });

  it("用户改过的端口保持不变", () => {
    const d = applyProtocol(draft({ protocol: "artNet", port: 7000 }), "sacn");
    expect(d).toMatchObject({ protocol: "sacn", port: 7000 });
  });

  it("协议不变时原样返回", () => {
    const d = draft();
    expect(applyProtocol(d, d.protocol)).toBe(d);
  });

  it("defaultPort", () => {
    expect(defaultPort("artNet")).toBe(6454);
    expect(defaultPort("sacn")).toBe(5568);
  });
});

describe("applyDeviceSelection", () => {
  it("名称为空时自动填入设备名", () => {
    const d = applyDeviceSelection(draft(), dev("10.0.0.5", { customName: "舞台左" }), false);
    expect(d).toMatchObject({ targetIp: "10.0.0.5", name: "舞台左" });
  });

  it("名称只有空白也算空", () => {
    const d = applyDeviceSelection(draft({ name: "   " }), dev("10.0.0.5", { hostname: "node-1" }), false);
    expect(d.name).toBe("node-1");
  });

  it("已有名称时不覆盖", () => {
    const d = applyDeviceSelection(
      draft({ name: "我的名字" }),
      dev("10.0.0.5", { customName: "设备名" }),
      false,
    );
    expect(d.name).toBe("我的名字");
    expect(d.targetIp).toBe("10.0.0.5");
  });

  it("没有任何名称信息时退回 IP", () => {
    expect(applyDeviceSelection(draft(), dev("10.0.0.5"), false).name).toBe("10.0.0.5");
  });

  it("选中 sACN 设备且 sACN 开启：切到 sACN 并换默认端口", () => {
    const d = applyDeviceSelection(draft(), dev("10.0.0.5", { category: "sacn" }), true);
    expect(d).toMatchObject({ protocol: "sacn", port: 5568 });
  });

  it("sACN 关闭时不会切到 sACN", () => {
    const d = applyDeviceSelection(draft(), dev("10.0.0.5", { category: "sacn" }), false);
    expect(d).toMatchObject({ protocol: "artNet", port: 6454 });
  });

  it("从 sACN 目的地改选 Art-Net 设备：回到 Art-Net，自定义端口保留", () => {
    const start = draft({ protocol: "sacn", port: 5568 });
    expect(applyDeviceSelection(start, dev("10.0.0.5"), true)).toMatchObject({
      protocol: "artNet",
      port: 6454,
    });
    const custom = draft({ protocol: "sacn", port: 9000 });
    expect(applyDeviceSelection(custom, dev("10.0.0.5"), true)).toMatchObject({
      protocol: "artNet",
      port: 9000,
    });
  });

  it("其他类设备只填 IP 与名称，协议端口不变", () => {
    const start = draft({ protocol: "sacn", port: 5568 });
    const d = applyDeviceSelection(start, dev("10.0.0.5", { category: "computer" }), true);
    expect(d).toMatchObject({ protocol: "sacn", port: 5568, targetIp: "10.0.0.5" });
  });

  it("不修改入参", () => {
    const start = draft();
    applyDeviceSelection(start, dev("10.0.0.5"), true);
    expect(start.targetIp).toBe("");
  });
});