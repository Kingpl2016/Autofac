// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { fixed } from "../../lib/looks";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProgrammerStore } from "../../stores/useProgrammerStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { PreviewPanel } from "../../components/PreviewPanel";
import { StageMonitor } from "../StageMonitor";
import { fitStage, placeFixtures, toCanvas } from "../stageGeometry";
import { createFakeContext, type FakeContext } from "./fakeCanvas";

const WIDTH = 600;
const HEIGHT = 400;
let fake: FakeContext;
const restore: Array<() => void> = [];

/** 把原型上的只读尺寸属性临时换成固定值。 */
function stubSize(name: "clientWidth" | "clientHeight", value: number) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  restore.push(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, name, original);
  });
}

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  stubSize("clientWidth", WIDTH);
  stubSize("clientHeight", HEIGHT);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fake.ctx as never);
  loadTestEngine();
});

afterAll(() => {
  for (const r of restore) r();
  vi.restoreAllMocks();
});

const project = () => useProjectStore.getState().project;
const ui = () => useEditorUiStore.getState();
const ids = () => project().fixtures.map((f) => f.id);

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  fake = createFakeContext();
  useProjectStore.getState().load(
    produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 4);
      d.durationMs = 10_000;
      d.output.gamma = 1;
    }),
  );
  useEditorUiStore.setState({ selectedFixtureIds: [], playheadMs: 0, blackout: false, centerView: "stage" });
  useProgrammerStore.setState({ values: {}, live: false });
});

afterEach(() => cleanup());

/** 第 n 台灯（0 起）在画布上的位置，与组件内部同一套几何。 */
function canvasPoint(n: number) {
  const p = project();
  const place = placeFixtures(p.fixtures, p.stage).get(p.fixtures[n].id)!;
  return toCanvas(fitStage(p.stage, WIDTH, HEIGHT), place.x, place.y);
}

const items = () => within(screen.getByRole("list", { name: "舞台上的灯具" })).getAllByRole("button");

describe("舞台监视器", () => {
  it("默认中间区显示舞台；画布带名称并实际绘制了每台灯", () => {
    render(<PreviewPanel />);
    expect(screen.getByRole("radio", { name: "舞台" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("img", { name: "舞台监视器：4 台灯具，已选 0 台" })).toBeTruthy();
    expect(fake.calls.filter((c) => c === "arc").length).toBeGreaterThanOrEqual(4);
  });

  it("没有灯具时提示添加", () => {
    act(() => useProjectStore.getState().load(createEmptyProject("空")));
    render(<StageMonitor />);
    expect(screen.getByText(/添加灯具后/)).toBeTruthy();
  });

  it("点击画布上的灯具选中它，Ctrl 追加；点空白处清空选择", () => {
    render(<StageMonitor />);
    const canvas = screen.getByRole("img");
    const a = canvasPoint(0);
    const c = canvasPoint(2);
    fireEvent.pointerDown(canvas, { button: 0, clientX: a.x, clientY: a.y });
    expect(ui().selectedFixtureIds).toEqual([ids()[0]]);
    fireEvent.pointerDown(canvas, { button: 0, clientX: c.x, clientY: c.y, ctrlKey: true });
    expect(ui().selectedFixtureIds).toEqual([ids()[0], ids()[2]]);
    expect(screen.getByText("已选 2 / 4")).toBeTruthy();
    fireEvent.pointerDown(canvas, { button: 0, clientX: 2, clientY: 2 });
    fireEvent.pointerUp(canvas, { clientX: 2, clientY: 2 });
    expect(ui().selectedFixtureIds).toEqual([]);
  });

  it("从空白处拖出矩形框选所有灯具", () => {
    render(<StageMonitor />);
    const canvas = screen.getByRole("img");
    fireEvent.pointerDown(canvas, { button: 0, clientX: 1, clientY: 1 });
    fireEvent.pointerMove(canvas, { clientX: WIDTH - 1, clientY: HEIGHT - 1 });
    fireEvent.pointerUp(canvas, { clientX: WIDTH - 1, clientY: HEIGHT - 1 });
    expect(ui().selectedFixtureIds).toEqual(ids());
  });

  it("双击灯具：选中并切到属性面板的编程器页", () => {
    act(() => ui().setInspectorTab("patch"));
    render(<StageMonitor />);
    const b = canvasPoint(1);
    fireEvent.doubleClick(screen.getByRole("img"), { clientX: b.x, clientY: b.y });
    expect(ui().selectedFixtureIds).toEqual([ids()[1]]);
    expect(ui().inspectorTab).toBe("program");
  });

  it("读屏列表：显示编程器叠加后的颜色，按钮可选灯", () => {
    act(() =>
      useProgrammerStore.getState().setValues({
        [ids()[0]]: { intensity: fixed(100), color: fixed({ kind: "rgb", rgb: [255, 0, 0] }) },
      }),
    );
    render(<StageMonitor />);
    expect(items()[0].textContent).toContain("红 255");
    expect(items()[1].textContent).toContain("红 0");
    fireEvent.click(items()[3]);
    expect(ui().selectedFixtureIds).toEqual([ids()[3]]);
    expect(items()[3].getAttribute("aria-pressed")).toBe("true");
  });

  it("布置模式：拖动灯具按 0.25 m 吸附摆位（一步撤销），未拖动的灯固定在原位", () => {
    render(<StageMonitor />);
    fireEvent.click(screen.getByRole("button", { name: "布置" }));
    const canvas = screen.getByRole("img");
    expect(canvas.getAttribute("aria-label")).toContain("舞台布置");
    const view = fitStage(project().stage, WIDTH, HEIGHT);
    const start = canvasPoint(0);
    const before = placeFixtures(project().fixtures, project().stage);
    const steps = useProjectStore.temporal.getState().pastStates.length;
    fireEvent.pointerDown(canvas, { button: 0, clientX: start.x, clientY: start.y });
    fireEvent.pointerMove(canvas, { clientX: start.x + view.scale * 1.1, clientY: start.y - view.scale * 0.4 });
    fireEvent.pointerUp(canvas, { clientX: start.x + view.scale * 1.1, clientY: start.y - view.scale * 0.4 });
    const moved = project().fixtures[0].stage!;
    const target0 = before.get(ids()[0])!;
    expect(moved.x).toBeCloseTo(Math.round((target0.x + 1.1) / 0.25) * 0.25, 3);
    expect(moved.y).toBeCloseTo(Math.round((target0.y + 0.4) / 0.25) * 0.25, 3);
    expect(project().fixtures[1].stage!.x).toBeCloseTo(before.get(ids()[1])!.x, 2);
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps + 1);
    expect(ui().selectedFixtureIds).toEqual([ids()[0]]);
  });

  it("布置模式：方向键微调选中的灯；工具条添加物件、改尺寸、删除物件", () => {
    act(() => ui().setSelectedFixtures([ids()[0], ids()[1]]));
    render(<StageMonitor />);
    fireEvent.click(screen.getByRole("button", { name: "布置" }));
    const canvas = screen.getByRole("img");
    fireEvent.keyDown(canvas, { key: "ArrowRight", shiftKey: true });
    const a = project().fixtures[0].stage!;
    const b = project().fixtures[1].stage!;
    fireEvent.keyDown(canvas, { key: "ArrowUp" });
    expect(project().fixtures[0].stage!.x).toBeCloseTo(a.x, 3);
    expect(project().fixtures[0].stage!.y).toBeCloseTo(a.y + 0.1, 3);
    expect(project().fixtures[1].stage!.y).toBeCloseTo(b.y + 0.1, 3);

    const bar = screen.getByRole("toolbar", { name: "舞台布置" });
    fireEvent.click(within(bar).getByRole("button", { name: "桁架" }));
    expect(project().stage.objects).toHaveLength(1);
    const objGroup = screen.getByRole("group", { name: "布景物件" });
    const w = within(objGroup).getByRole("textbox", { name: "宽" });
    fireEvent.change(w, { target: { value: "8" } });
    fireEvent.blur(w);
    expect(project().stage.objects[0].w).toBe(8);

    const width = within(bar).getByRole("textbox", { name: "舞台宽" });
    fireEvent.change(width, { target: { value: "20" } });
    fireEvent.blur(width);
    expect(project().stage.width).toBe(20);

    // 选中物件时方向键移动物件，Delete 删除
    const ox = project().stage.objects[0].x;
    fireEvent.keyDown(canvas, { key: "ArrowLeft" });
    expect(project().stage.objects[0].x).toBeCloseTo(ox - 0.1, 3);
    fireEvent.keyDown(canvas, { key: "Delete" });
    expect(project().stage.objects).toHaveLength(0);
  });

  it("布置模式：选中两台以上可排成直线；吊挂开关", () => {
    act(() => ui().setSelectedFixtures(ids()));
    render(<StageMonitor />);
    fireEvent.click(screen.getByRole("button", { name: "布置" }));
    const group = screen.getByRole("group", { name: "4 台灯具" });
    fireEvent.click(within(group).getByRole("button", { name: "排成直线" }));
    const ys = new Set(project().fixtures.map((f) => f.stage!.y.toFixed(3)));
    expect(ys.size).toBe(1);
    fireEvent.click(within(group).getByRole("switch", { name: "吊挂" }));
    expect(project().fixtures.every((f) => f.stage!.hanging)).toBe(true);
  });

  it("布置模式：拖动布景物件", () => {
    render(<StageMonitor />);
    fireEvent.click(screen.getByRole("button", { name: "布置" }));
    fireEvent.click(within(screen.getByRole("toolbar", { name: "舞台布置" })).getByRole("button", { name: "矩形" }));
    // 把灯具挪开，免得与物件重叠
    act(() =>
      useProjectStore.getState().update((d) => {
        for (const f of d.fixtures) f.stage = { x: -5, y: 7 };
      }),
    );
    const o = project().stage.objects[0];
    const view = fitStage(project().stage, WIDTH, HEIGHT);
    const c = toCanvas(view, o.x, o.y);
    const canvas = screen.getByRole("img");
    fireEvent.pointerDown(canvas, { button: 0, clientX: c.x, clientY: c.y });
    fireEvent.pointerMove(canvas, { clientX: c.x + view.scale * 2, clientY: c.y });
    fireEvent.pointerUp(canvas, { clientX: c.x + view.scale * 2, clientY: c.y });
    expect(project().stage.objects[0].x).toBeCloseTo(o.x + 2, 3);
    expect(project().stage.objects[0].y).toBeCloseTo(o.y, 3);
  });

  it("黑场：预览全暗并显示状态；盲改按钮切换编程器实时输出", () => {
    act(() =>
      useProgrammerStore.getState().setValues({
        [ids()[0]]: { intensity: fixed(100), color: fixed({ kind: "rgb", rgb: [255, 0, 0] }) },
      }),
    );
    render(<StageMonitor />);
    const blackout = screen.getByRole("button", { name: /黑场/ });
    fireEvent.click(blackout);
    expect(ui().blackout).toBe(true);
    expect(blackout.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("黑场中 · 输出全暗")).toBeTruthy();
    expect(items()[0].textContent).toContain("红 0");
    fireEvent.click(blackout);
    expect(items()[0].textContent).toContain("红 255");

    const blind = screen.getByRole("button", { name: /盲改/ });
    expect(blind.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(blind);
    expect(useProgrammerStore.getState().live).toBe(true);
    expect(blind.getAttribute("aria-pressed")).toBe("false");
  });
});
