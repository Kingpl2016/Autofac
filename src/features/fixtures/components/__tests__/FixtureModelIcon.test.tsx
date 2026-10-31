// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
  invoke: vi.fn(() => Promise.reject(new Error("no tauri"))),
}));

import "@/shared/i18n";
import type { AssetView } from "../../lib/assetsApi";
import type { FixtureModel } from "../../lib/types";
import { useFixtureAssetStore } from "../../stores/useFixtureAssetStore";
import { FixtureModelIcon } from "../FixtureModelIcon";

const hash = "c".repeat(64);
const model: FixtureModel = {
  id: "m",
  name: "Spot",
  system: "",
  productType: "",
  builtin: false,
  properties: [{ name: "P", code: "P", function: "pan", channel: 1, width: 1, bigEndian: true, defaultValue: 0, valueDesc: "", description: "" }],
};
const icon: AssetView = { hash, kind: "icon", format: "svg", bytes: 10, name: "spot.svg", createdAtMs: 0, path: "D:\\data\\fixture-assets\\icons\\x.svg" };

describe("FixtureModelIcon", () => {
  beforeEach(() => useFixtureAssetStore.setState({ byHash: new Map(), status: "ready" }));
  afterEach(cleanup);

  it("没有自己的图标时按外形显示内置图标", () => {
    render(<FixtureModelIcon model={model} />);
    expect(screen.getByRole("img").tagName).toBe("SPAN");
  });

  it("资源库里有图标文件时显示文件；文件缺失时退回内置图标", () => {
    const withIcon: FixtureModel = { ...model, appearance: { shape: "movingHead", origin: "user", icon: { hash, format: "svg", name: "spot.svg" } } };
    const { rerender } = render(<FixtureModelIcon model={withIcon} />);
    expect(screen.getByRole("img").tagName).toBe("SPAN");
    useFixtureAssetStore.setState({ byHash: new Map([[hash, icon]]) });
    rerender(<FixtureModelIcon model={withIcon} />);
    const img = screen.getByRole("img");
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toContain("asset://localhost/");
  });
});
