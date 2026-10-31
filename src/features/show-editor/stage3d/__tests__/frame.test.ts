import { describe, expect, it } from "vitest";

import { FIXTURE_SHAPES, type FixtureModel } from "@/features/fixtures";
import { HEAD16, RGBW } from "../../lib/__tests__/testkit";
import type { SheetRow } from "../../lib/fixtureSheet";
import type { FixtureInstance } from "../../lib/project";
import { fixtureStatics, frameFixtures } from "../frame";
import { fixtureBasis } from "../math";
import { buildShape, disposeMeshSet, localDims } from "../shapes";
import { attitudeOf } from "../useFixtureGizmo";

const inst = (id: string, modelId: string, stage?: FixtureInstance["stage"]): FixtureInstance => ({ id, name: id, modelId, universe: 0, address: 1, ...(stage ? { stage } : {}) });

describe("fixtureStatics / frameFixtures", () => {
  it("按模型取外形、尺寸、行程；资源库里有 3D 文件时用它，否则记为缺失", () => {
    const hash = "d".repeat(64);
    const head: FixtureModel = {
      ...HEAD16,
      physical: { panRangeDeg: 630, tiltRangeDeg: 265, beamMinDeg: 8, beamMaxDeg: 30, dimensionsMm: [400, 600, 300] },
      appearance: { shape: "movingHead", origin: "user", model3d: { hash, format: "glb", name: "" } },
    };
    const models = new Map([
      [RGBW.id, RGBW],
      [head.id, head],
    ]);
    const fixtures = [inst("a", RGBW.id), inst("b", head.id, { x: 1, y: 2, z: 6, rotation: 90, hanging: true })];
    const placements = new Map([["a", { x: -1, y: 1 }]]);
    const missing = fixtureStatics(fixtures, models, placements, () => false);
    expect(missing[0]).toMatchObject({ shape: "par", mover: false, model3d: null, missing3d: false, placement: { x: -1, y: 1 } });
    expect(missing[1]).toMatchObject({ shape: "movingHead", mover: true, panRange: 630, tiltRange: 265, model3d: null, missing3d: true });
    expect(missing[1].dims).toEqual([0.4, 0.6, 0.3]);
    expect(missing[1].basis.up[2]).toBeCloseTo(-1, 9);
    const found = fixtureStatics(fixtures, models, placements, (h) => h === hash);
    expect(found[1].model3d).toBe(hash);

    const cells = new Map([
      ["pan", { fraction: 0.75 }],
      ["tilt", { fraction: 0.5 }],
    ]) as unknown as SheetRow["cells"];
    const frame = frameFixtures(found, new Map([["b", [255, 0, 0]]]), new Map([["b", { cells } as SheetRow]]), new Set(["b"]));
    expect(frame[0]).toMatchObject({ template: "shape:par", head: null, rgb: [0, 0, 0], selected: false, beamDeg: 30 });
    expect(frame[1]).toMatchObject({ template: `glb:${hash}`, rgb: [255, 0, 0], selected: true, position: [1, 2, 6] });
    expect(frame[1].head?.pan).toBeCloseTo((0.25 * 630 * Math.PI) / 180, 9);
    // 没有变焦通道：取最小 / 最大光束角的中间
    expect(frame[1].beamDeg).toBe(19);
  });
});

describe("attitudeOf", () => {
  it("由姿态反求朝向与俯仰，与 fixtureBasis 互逆", () => {
    for (const [rot, pitch, hanging] of [
      [0, 0, false],
      [90, 30, false],
      [-120, -45, false],
      [180, 45, true],
      [35, 10, true],
    ] as const) {
      const b = fixtureBasis(rot, pitch, hanging);
      expect(attitudeOf(b.up, b.front, hanging)).toEqual({ rotation: rot, pitch });
    }
  });
});

describe("外形几何体", () => {
  it("每种外形都能生成，面数很低；尺寸按光轴方向换算", () => {
    for (const shape of FIXTURE_SHAPES) {
      const set = buildShape(shape);
      expect(set.tris).toBeGreaterThan(0);
      expect(set.tris).toBeLessThan(400);
      expect(set.base.getAttribute("color")).toBeDefined();
      expect(Boolean(set.yoke && set.head)).toBe(shape === "movingHead");
      disposeMeshSet(set);
    }
    // 帕灯的光轴沿 OFL 的“深”，摇头灯沿“高”
    expect(localDims("par", [200, 250, 300])).toEqual([0.2, 0.3, 0.25]);
    expect(localDims("movingHead", [200, 250, 300])).toEqual([0.2, 0.25, 0.3]);
    expect(localDims("generic", undefined)).toEqual([0.3, 0.3, 0.3]);
  });
});
