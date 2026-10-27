import { describe, expect, it } from "vitest";

import { DEFAULT_STAGE } from "../../lib/project";
import { Canvas2DStageRenderer, type StageFixture, type StageTheme } from "../StageRenderer";
import { fitStage } from "../stageGeometry";
import { createFakeContext } from "./fakeCanvas";

const THEME: StageTheme = {
  background: "black",
  grid: "gray",
  outline: "gray",
  selection: "white",
  programmed: "orange",
  text: "silver",
};

function fixture(over: Partial<StageFixture> = {}): StageFixture {
  return {
    id: "a",
    name: "A",
    x: 0,
    y: 4,
    rotation: 0,
    rgb: [255, 0, 0],
    pan: null,
    tilt: null,
    panRange: 540,
    selected: false,
    programmed: false,
    parked: false,
    ...over,
  };
}

function setup() {
  const { ctx, calls } = createFakeContext();
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  const renderer = new Canvas2DStageRenderer(canvas);
  renderer.resize(300, 200, 2);
  return { renderer, calls, canvas };
}

describe("Canvas2DStageRenderer", () => {
  it("按设备像素比设置画布尺寸", () => {
    const { canvas } = setup();
    expect([canvas.width, canvas.height]).toEqual([600, 400]);
  });

  it("亮灯画光晕（径向渐变），关闭光晕或灯全黑时不画", () => {
    const frame = (bloom: number, rgb: [number, number, number]) => ({
      stage: DEFAULT_STAGE,
      view: fitStage(DEFAULT_STAGE, 300, 200),
      fixtures: [fixture({ rgb })],
      theme: THEME,
      hover: null,
      lasso: null,
      bloom,
    });
    const lit = setup();
    lit.renderer.render(frame(1, [255, 0, 0]));
    expect(lit.calls).toContain("createRadialGradient");
    expect(lit.calls).toContain("arc");

    const off = setup();
    off.renderer.render(frame(0, [255, 0, 0]));
    expect(off.calls).not.toContain("createRadialGradient");

    const dark = setup();
    dark.renderer.render(frame(1, [0, 0, 0]));
    expect(dark.calls).not.toContain("createRadialGradient");
  });

  it("摇头灯、选中、悬停、框选、Park 等状态都能画出来且不抛错", () => {
    const { renderer, calls } = setup();
    renderer.render({
      stage: { ...DEFAULT_STAGE, objects: [] },
      view: fitStage(DEFAULT_STAGE, 300, 200),
      fixtures: [fixture({ pan: 0.7, tilt: 0.9, selected: true, programmed: true, parked: true })],
      theme: THEME,
      hover: "a",
      lasso: { x0: 10, y0: 10, x1: 80, y1: 60 },
      bloom: 1,
    });
    expect(calls).toContain("fillText");
    expect(calls).toContain("strokeRect");
    renderer.dispose();
  });
});
