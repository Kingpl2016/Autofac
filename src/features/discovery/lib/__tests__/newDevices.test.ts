import { describe, expect, it } from "vitest";

import type { Device } from "@/shared/domain/device";
import { findNewIps } from "../newDevices";

const dev = (ip: string): Device => ({
  ip,
  hostname: null,
  customName: null,
  mac: null,
  category: "artNet",
  artnetPorts: null,
  online: true,
  lastSeenMs: 0,
});

describe("findNewIps", () => {
  it("只返回未见过的 IP，并保持顺序", () => {
    const known = new Set(["10.0.0.1"]);
    expect(findNewIps(known, [dev("10.0.0.1"), dev("10.0.0.3"), dev("10.0.0.2")])).toEqual([
      "10.0.0.3",
      "10.0.0.2",
    ]);
  });

  it("列表内重复 IP 只算一次；全部已知则为空", () => {
    expect(findNewIps(new Set(), [dev("1.1.1.1"), dev("1.1.1.1")])).toEqual(["1.1.1.1"]);
    expect(findNewIps(new Set(["1.1.1.1"]), [dev("1.1.1.1")])).toEqual([]);
  });
});
