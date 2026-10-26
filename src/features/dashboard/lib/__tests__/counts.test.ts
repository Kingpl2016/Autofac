import { describe, expect, it } from "vitest";

import { countDestinations, countDevices } from "../counts";

describe("countDevices", () => {
  it("区分在线与总数", () => {
    expect(countDevices([])).toEqual({ online: 0, total: 0 });
    expect(
      countDevices([{ online: true }, { online: false }, { online: true }]),
    ).toEqual({ online: 2, total: 3 });
  });
});

describe("countDestinations", () => {
  it("区分已启用与总数", () => {
    expect(countDestinations([])).toEqual({ total: 0, enabled: 0 });
    expect(
      countDestinations([{ enabled: true }, { enabled: false }, { enabled: false }]),
    ).toEqual({ total: 3, enabled: 1 });
  });
});