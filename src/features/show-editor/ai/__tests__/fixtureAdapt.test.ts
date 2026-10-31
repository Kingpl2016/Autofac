import { produce } from "immer";
import { describe, expect, it } from "vitest";

import type { AssetView, FixtureModel } from "@/features/fixtures";
import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { HEAD16, RGBW } from "../../lib/__tests__/testkit";
import { buildAliases } from "../aliases";
import { listChanges } from "../changes";
import { planOps, type CompileEnv } from "../compile";
import { fixtureAssetsText, fixtureModelText, hexRgb, resolveModelRef } from "../fixtureAdapt";
import { aiOpsSchema } from "../opsSchema";

/** 带色轮的摇头灯（W1 Open、W2 无颜色的 “Congo Blue”、W3 红）。 */
const SPOT: FixtureModel = {
  ...HEAD16,
  id: "ofl:acme/spot",
  name: "Spot",
  source: { kind: "ofl", key: "acme/spot", recognizer: 3 },
  properties: [
    ...HEAD16.properties,
    {
      name: "Color",
      code: "Color",
      function: "colorWheel",
      channel: 17,
      width: 1,
      bigEndian: true,
      defaultValue: 0,
      valueDesc: "",
      description: "",
      capabilities: [
        { range: [0, 63], label: "Open" },
        { range: [64, 127], label: "Congo Blue" },
        { range: [128, 255], label: "Red", color: [255, 0, 0] },
      ],
    },
  ],
};

const assets: AssetView[] = [
  { hash: "a".repeat(64), kind: "icon", format: "svg", bytes: 1, name: "spot.svg", createdAtMs: 0, path: "x" },
  { hash: "b".repeat(64), kind: "model", format: "glb", bytes: 1, name: "spot.glb", createdAtMs: 0, path: "y", stats: { tris: 1200, jointed: true } },
];

const env = (library: FixtureModel[]): CompileEnv => ({
  effects: BUILTIN_EFFECTS,
  templates: BUILTIN_TEMPLATES,
  libraryModels: library,
  fixtureAssets: assets,
  lang: "zh",
  playheadMs: 0,
  selection: [],
});

function show(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 2);
    addFixtures(d, SPOT, 2);
  });
}

const run = (p: ShowProject, ops: unknown[], library: FixtureModel[] = [RGBW, { ...SPOT, builtin: false }]) =>
  planOps(p, aiOpsSchema.parse({ summary: "", ops }).ops, env(library), buildAliases(p));

describe("灯具适配", () => {
  it("get_fixture_model：来源、外形、色轮槽位（缺颜色的标出）、缺什么、哪些灯在用", () => {
    const p = show();
    const target = resolveModelRef("F3", p, buildAliases(p), [RGBW, SPOT]);
    if (typeof target === "string") throw new Error(target);
    const text = fixtureModelText(target, p, buildAliases(p), assets);
    expect(text).toContain("Source: ofl 'acme/spot'");
    expect(text).toMatch(/W2 64–127 "Congo Blue" NO COLOR/);
    expect(text).toMatch(/W3 .* #ff0000/);
    expect(text).toMatch(/Missing: size, beam angle, shape/);
    expect(text).toContain("Used by: F3, F4");
    expect(resolveModelRef("L9", p, buildAliases(p), [RGBW])).toMatch(/no fixture model/);
    expect(fixtureAssetsText(assets)).toMatch(/A2 3D model "spot.glb" \(1200 triangles, pan\/tilt joints\)/);
    expect(hexRgb("#2a0096")).toEqual([42, 0, 150]);
  });

  it("adaptFixtureModel：改工程快照并写回灯具库，列为敏感改动", () => {
    const p = show();
    const r = run(p, [
      {
        op: "adaptFixtureModel",
        model: "F3",
        shape: "movingHead",
        widthMm: 350,
        heightMm: 550,
        depthMm: 300,
        beamMinDeg: 12,
        beamMaxDeg: 30,
        icon: "A1",
        model3d: "A2",
        slotColors: [{ slot: "W2", color: "#2a0096" }],
      },
    ]);
    expect(r.issues).toEqual([]);
    expect(r.sensitive).toBe(true);
    const snap = r.next.fixtureModels.find((m) => m.id === SPOT.id);
    expect(snap?.appearance).toMatchObject({ shape: "movingHead", origin: "ai", icon: { hash: "a".repeat(64) }, model3d: { hash: "b".repeat(64), format: "glb" } });
    expect(snap?.physical).toMatchObject({ dimensionsMm: [350, 550, 300], beamMinDeg: 12, beamMaxDeg: 30 });
    expect(snap?.properties.at(-1)?.capabilities?.[1].color).toEqual([42, 0, 150]);
    expect(r.library.models.map((m) => m.id)).toEqual([SPOT.id]);
    expect(listChanges(p, r.next, "zh", r.library).some((c) => c.collection === "libModels")).toBe(true);
  });

  it("校验：资源种类、尺寸成组、发光体存在；内置模型只改工程", () => {
    const p = show();
    const err = (op: Record<string, unknown>) => run(p, [{ op: "adaptFixtureModel", model: "F3", ...op }]).issues[0]?.message;
    expect(err({ icon: "A2" })).toMatch(/not an icon/);
    expect(err({ model3d: "A9" })).toMatch(/no asset/);
    expect(err({ widthMm: 300 })).toMatch(/widthMm, heightMm and depthMm together/);
    expect(err({ emitters: [{ emitter: "amber", color: "#ffa000" }] })).toMatch(/no 'amber' emitter/);
    expect(err({ slotColors: [{ slot: "W9", color: "#ffffff" }] })).toMatch(/no color wheel slot/);
    expect(err({ beamMinDeg: 30, beamMaxDeg: 10 })).toMatch(/beamMaxDeg/);

    const rgbw = run(p, [{ op: "adaptFixtureModel", model: "F1", emitters: [{ emitter: "red", color: "#ff1800" }], shape: "par" }], [{ ...RGBW, builtin: true }]);
    expect(rgbw.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(rgbw.issues.some((i) => /built-in/.test(i.message))).toBe(true);
    expect(rgbw.library.models).toEqual([]);
    expect(rgbw.next.fixtureModels.find((m) => m.id === RGBW.id)?.emitters).toEqual([{ function: "red", rgb: [255, 24, 0] }]);
  });
});
