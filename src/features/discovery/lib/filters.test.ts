import { describe, expect, it } from "vitest";

import type { Device } from "@/shared/domain/device";
import {
  countByCategory,
  displayName,
  filterDevices,
  ipToNumber,
  isFiltering,
  nextSort,
  sortDevices,
  type DeviceFilter,
} from "./filters";

const dev = (over: Partial<Device> & { ip: string }): Device => ({
  hostname: null,
  customName: null,
  mac: null,
  category: "artNet",
  artnetPorts: null,
  online: true,
  lastSeenMs: 0,
  ...over,
});

const ALL: DeviceFilter = { category: "all", status: "all", query: "" };

describe("ipToNumber / displayName", () => {
  it("按数值而不是字典序比较 IP", () => {
    expect(ipToNumber("10.0.0.9")).toBeLessThan(ipToNumber("10.0.0.10"));
    expect(ipToNumber("2.0.0.1")).toBeLessThan(ipToNumber("10.0.0.1"));
  });

  it("展示名优先级：自定义名 > 主机名 > 短名 > IP", () => {
    const base = { ip: "1.1.1.1" };
    expect(displayName(dev({ ...base, customName: "A", hostname: "B", shortName: "C" }))).toBe("A");
    expect(displayName(dev({ ...base, hostname: "B", shortName: "C" }))).toBe("B");
    expect(displayName(dev({ ...base, shortName: "C" }))).toBe("C");
    expect(displayName(dev(base))).toBe("1.1.1.1");
  });
});

describe("countByCategory", () => {
  it("统计各分类与总数", () => {
    const c = countByCategory([
      dev({ ip: "1.1.1.1" }),
      dev({ ip: "1.1.1.2", category: "sacn" }),
      dev({ ip: "1.1.1.3", category: "sacn" }),
    ]);
    expect(c).toMatchObject({ all: 3, artNet: 1, sacn: 2, cluster: 0 });
  });
});

describe("filterDevices", () => {
  const list = [
    dev({ ip: "10.0.0.1", hostname: "Stage-Left", mac: "AA:BB:CC:00:00:01" }),
    dev({ ip: "10.0.0.2", category: "sacn", online: false, customName: "舞台右" }),
    dev({ ip: "10.0.0.3", shortName: "Truss", online: false }),
  ];

  it("无筛选时原样返回", () => {
    expect(filterDevices(list, ALL)).toHaveLength(3);
  });

  it("按分类与在线状态组合过滤", () => {
    expect(filterDevices(list, { ...ALL, category: "artNet" })).toHaveLength(2);
    expect(filterDevices(list, { ...ALL, status: "offline" })).toHaveLength(2);
    expect(
      filterDevices(list, { ...ALL, category: "artNet", status: "offline" }).map((d) => d.ip),
    ).toEqual(["10.0.0.3"]);
  });

  it("搜索覆盖 IP / 主机名 / 自定义名 / 短名 / MAC，且不区分大小写", () => {
    expect(filterDevices(list, { ...ALL, query: "stage" })).toHaveLength(1);
    expect(filterDevices(list, { ...ALL, query: "舞台" })).toHaveLength(1);
    expect(filterDevices(list, { ...ALL, query: "TRUSS" })).toHaveLength(1);
    expect(filterDevices(list, { ...ALL, query: "aa:bb" })).toHaveLength(1);
    expect(filterDevices(list, { ...ALL, query: "10.0.0." })).toHaveLength(3);
    expect(filterDevices(list, { ...ALL, query: "  nomatch " })).toHaveLength(0);
  });
});

describe("isFiltering", () => {
  it("仅在有条件偏离默认时为真", () => {
    expect(isFiltering(ALL)).toBe(false);
    expect(isFiltering({ ...ALL, query: "   " })).toBe(false);
    expect(isFiltering({ ...ALL, query: "x" })).toBe(true);
    expect(isFiltering({ ...ALL, status: "online" })).toBe(true);
    expect(isFiltering({ ...ALL, category: "sacn" })).toBe(true);
  });
});

describe("sortDevices", () => {
  const list = [
    dev({ ip: "10.0.0.10", online: false, lastSeenMs: 100, artnetPorts: 2, customName: "b" }),
    dev({ ip: "10.0.0.2", online: true, lastSeenMs: 50, artnetPorts: 8, customName: "a" }),
    dev({ ip: "10.0.0.5", online: true, lastSeenMs: 90, artnetPorts: null, category: "sacn", customName: "c" }),
  ];
  const ips = (ds: Device[]) => ds.map((d) => d.ip);

  it("状态：在线优先，同状态最近活动在前", () => {
    expect(ips(sortDevices(list, "status", "asc"))).toEqual([
      "10.0.0.5",
      "10.0.0.2",
      "10.0.0.10",
    ]);
  });

  it("IP 按数值升降序", () => {
    expect(ips(sortDevices(list, "ip", "asc"))).toEqual(["10.0.0.2", "10.0.0.5", "10.0.0.10"]);
    expect(ips(sortDevices(list, "ip", "desc"))).toEqual(["10.0.0.10", "10.0.0.5", "10.0.0.2"]);
  });

  it("名称与端口数排序；缺失端口数排在最小端", () => {
    expect(ips(sortDevices(list, "name", "asc"))).toEqual(["10.0.0.2", "10.0.0.10", "10.0.0.5"]);
    expect(ips(sortDevices(list, "ports", "desc"))).toEqual(["10.0.0.2", "10.0.0.10", "10.0.0.5"]);
  });

  it("类别：Art-Net 在前；主键相同按 IP 稳定", () => {
    expect(ips(sortDevices(list, "category", "asc"))).toEqual(["10.0.0.2", "10.0.0.10", "10.0.0.5"]);
  });

  it("不修改原数组", () => {
    const copy = [...list];
    sortDevices(list, "ip", "desc");
    expect(list).toEqual(copy);
  });
});

describe("nextSort", () => {
  it("同列切换方向，换列回到升序", () => {
    expect(nextSort({ key: "ip", dir: "asc" }, "ip")).toEqual({ key: "ip", dir: "desc" });
    expect(nextSort({ key: "ip", dir: "desc" }, "ip")).toEqual({ key: "ip", dir: "asc" });
    expect(nextSort({ key: "ip", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
  });
});
