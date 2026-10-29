// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { useFixtureStore } from "@/features/fixtures";
import i18n from "@/shared/i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));

import { DIMMER, fakeFile, PIXEL_BAR, RGBW } from "../../lib/__tests__/testkit";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { DEFAULT_FIXTURE_ADD, DEFAULT_FIXTURE_LIBRARY, useEditorPrefsStore } from "../../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../../stores/useEditorUiStore";
import { useProjectStore } from "../../stores/useProjectStore";
import { InspectorPanel } from "../InspectorPanel";
import { LibraryFixturesTab } from "../LibraryFixturesTab";
import { EditorToolbar } from "../EditorToolbar";

const scrolled = vi.fn();

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled(this);
  };
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  invoke.mockReset();
  scrolled.mockReset();
  useProjectStore.getState().load(createEmptyProject(""));
  useEditorUiStore.getState().clearSelection();
  useEditorUiStore.setState({ fixtureAddModelId: null, revealRequest: null, inspectorTab: "patch" });
  await act(async () => {
    await useEditorPrefsStore.setState({ fixtureAdd: DEFAULT_FIXTURE_ADD, fixtureLibrary: DEFAULT_FIXTURE_LIBRARY, patchSections: {}, programSections: {}, cueSections: {} });
  });
  useFixtureStore.setState({ models: [RGBW, DIMMER], status: "ready", error: null });
});

afterEach(() => cleanup());

const project = () => useProjectStore.getState().project;
const ui = () => useEditorUiStore.getState();

/** 同时渲染素材库的“灯具”标签、右侧属性区和工具条，模拟真实的编辑流程。 */
function renderEditor() {
  return render(
    <>
      <EditorToolbar file={fakeFile()} />
      <LibraryFixturesTab />
      <InspectorPanel />
    </>,
  );
}

/** 展开某个模型的批量添加面板，填数量并提交。 */
function batchAdd(name: string, count: string) {
  const toggle = screen.getByRole("button", { name: `批量添加 ${name}…` });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  fireEvent.change(screen.getByLabelText("数量"), { target: { value: count } });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^按以上设置添加 \\d+ 个 ${name}$`) }));
}

const list = () => screen.getByRole("listbox", { name: "灯具列表" });
const option = (name: string) => within(list()).getByRole("option", { name });
const detail = () => screen.getByTestId("patch-detail");

/** 提交一个“提交式”输入框（聚焦 → 改值 → 失焦）。 */
function commit(input: HTMLElement, value: string) {
  act(() => input.focus());
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe("灯具与 Patch 面板", () => {
  it("没有灯具时提示去素材库添加", () => {
    renderEditor();
    expect(screen.getByText("还没有灯具。到左侧“灯具”标签页添加。")).toBeTruthy();
  });

  it("从素材库添加多个灯具：地址依次排布、自动选中、占用图给出摘要", () => {
    renderEditor();
    batchAdd("RGBW全彩灯", "3");

    expect(project().fixtures).toHaveLength(3);
    for (const [name, range] of [
      ["RGBW全彩灯 1", "0.1–4"],
      ["RGBW全彩灯 2", "0.5–8"],
      ["RGBW全彩灯 3", "0.9–12"],
    ]) {
      expect(within(option(name)).getByText(range)).toBeTruthy();
      expect(option(name).getAttribute("aria-selected")).toBe("true");
    }
    // 选中后详情区顶部是摘要
    expect(within(detail()).getByText("已选 3 台")).toBeTruthy();
    expect(within(detail()).getByText("RGBW全彩灯 ×3", { selector: "p" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Universe 0：占用 12 \/ 512 个通道，0 个灯具有冲突/ })).toBeTruthy();
  });

  it("数量输入非法时按 1 处理，且上限为 128", () => {
    renderEditor();
    batchAdd("可调白光灯", "abc");
    expect(project().fixtures).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "9999" } });
    expect(screen.getByRole("button", { name: "按以上设置添加 128 个 可调白光灯" })).toBeTruthy();
  });

  it("列表点选：单击单选、Ctrl 追加 / 取消、Shift 连选；↑ / ↓ 移动，Esc 取消选择", () => {
    renderEditor();
    batchAdd("RGBW全彩灯", "4");
    const ids = project().fixtures.map((f) => f.id);
    fireEvent.click(option("RGBW全彩灯 2"));
    expect(ui().selectedFixtureIds).toEqual([ids[1]]);
    expect(within(detail()).getByText("RGBW全彩灯 2", { selector: "p" })).toBeTruthy();
    fireEvent.click(option("RGBW全彩灯 4"), { ctrlKey: true });
    expect(ui().selectedFixtureIds).toEqual([ids[1], ids[3]]);
    fireEvent.click(option("RGBW全彩灯 4"), { ctrlKey: true });
    expect(ui().selectedFixtureIds).toEqual([ids[1]]);
    // Shift 从上次单击 / Ctrl 点选的灯具（锚点）连选
    fireEvent.click(option("RGBW全彩灯 2"));
    fireEvent.click(option("RGBW全彩灯 4"), { shiftKey: true });
    expect(ui().selectedFixtureIds).toEqual([ids[1], ids[2], ids[3]]);

    fireEvent.click(option("RGBW全彩灯 1"));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(ui().selectedFixtureIds).toEqual([ids[1]]);
    fireEvent.keyDown(list(), { key: "ArrowDown", shiftKey: true });
    expect(ui().selectedFixtureIds).toEqual([ids[1], ids[2]]);
    fireEvent.keyDown(list(), { key: "Escape" });
    expect(ui().selectedFixtureIds).toEqual([]);
    expect(within(detail()).getByText("Patch 概况")).toBeTruthy();
  });

  it("搜索与“有问题”筛选", () => {
    renderEditor();
    batchAdd("RGBW全彩灯", "3");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索名称、型号或地址" }), { target: { value: "全彩灯 2" } });
    expect(within(list()).getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual(["RGBW全彩灯 2"]);
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    fireEvent.click(screen.getByRole("radio", { name: "有问题 0" }));
    expect(screen.getByText("没有匹配的灯具")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索与筛选" }));
    expect(within(list()).getAllByRole("option")).toHaveLength(3);
  });

  it("改地址造成重叠：列表与详情标出冲突，概况给出摘要，修正后恢复", () => {
    renderEditor();
    batchAdd("RGBW全彩灯", "2");
    fireEvent.click(option("RGBW全彩灯 2"));

    commit(within(detail()).getByLabelText("RGBW全彩灯 2 的起始地址"), "3");
    expect(within(detail()).getByText("与 1 个灯具冲突")).toBeTruthy();
    expect(option("RGBW全彩灯 1").getAttribute("aria-description")).toContain("与 1 个灯具冲突");
    expect(screen.getByRole("img", { name: /2 个灯具有冲突/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "有问题 2" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消选择" }));
    expect(screen.getByRole("status").textContent).toContain("2 个灯具的地址有问题");

    fireEvent.click(option("RGBW全彩灯 2"));
    const address = within(detail()).getByLabelText("RGBW全彩灯 2 的起始地址");
    act(() => address.focus());
    fireEvent.change(address, { target: { value: "5" } });
    fireEvent.keyDown(address, { key: "Enter" });
    expect(screen.queryByText("与 1 个灯具冲突")).toBeNull();
  });

  it("输入框按 Esc 放弃修改，不产生历史", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个 可调白光灯" }));
    const name = screen.getByLabelText("可调白光灯 1 的名称") as HTMLInputElement;
    act(() => name.focus());
    const steps = useProjectStore.temporal.getState().pastStates.length;
    fireEvent.change(name, { target: { value: "乱改一气" } });
    fireEvent.keyDown(name, { key: "Escape" });
    expect((screen.getByLabelText("可调白光灯 1 的名称") as HTMLInputElement).value).toBe("可调白光灯 1");
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps);
  });

  it("选中两个以上灯具才能编组；编组后在“所属分组”和概况的分组列表里出现，可调整成员顺序", () => {
    renderEditor();
    batchAdd("RGBW全彩灯", "3");

    fireEvent.click(option("RGBW全彩灯 1"));
    expect((screen.getByRole("button", { name: "编为一组" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(option("RGBW全彩灯 3"), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "编为一组" }));

    const { groups, tracks } = project();
    expect(groups).toHaveLength(1);
    expect(groups[0].fixtureIds).toHaveLength(2);
    expect(tracks.filter((t) => t.target.kind === "group")).toHaveLength(1);
    // 所属分组：点标签选中整个分组
    fireEvent.click(within(detail()).getByRole("button", { name: /分组 1/ }));
    expect(ui().selectedGroupId).toBe(groups[0].id);

    fireEvent.click(screen.getByRole("button", { name: "取消选择" }));
    expect(screen.getByDisplayValue("分组 1")).toBeTruthy();
    const before = [...groups[0].fixtureIds];
    fireEvent.click(screen.getByRole("button", { name: "下移 RGBW全彩灯 1" }));
    expect(project().groups[0].fixtureIds).toEqual([before[1], before[0]]);
    // 第一个成员不能再上移，最后一个不能再下移
    expect((screen.getByRole("button", { name: "上移 RGBW全彩灯 3" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "下移 RGBW全彩灯 1" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("删除灯具连同轨道，撤销后恢复；工具条的撤销 / 重做按钮随历史启用", async () => {
    renderEditor();
    const undo = screen.getByRole("button", { name: "撤销" }) as HTMLButtonElement;
    const redo = screen.getByRole("button", { name: "重做" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "添加 1 个 可调白光灯" }));
    await waitFor(() => expect(undo.disabled).toBe(false));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("未命名节目");
    expect(screen.getByText("有未保存的修改")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "删除 可调白光灯 1" }));
    expect(project().fixtures).toHaveLength(0);
    expect(project().tracks).toHaveLength(0);

    fireEvent.click(undo);
    expect(project().fixtures).toHaveLength(1);
    expect(project().tracks).toHaveLength(1);
    await waitFor(() => expect(redo.disabled).toBe(false));

    fireEvent.click(redo);
    expect(project().fixtures).toHaveLength(0);
  });

  it("撤销之后，已被删除灯具的选择不再计入“删除所选”", () => {
    renderEditor();
    batchAdd("RGBW全彩灯", "2");
    expect(screen.getByRole("button", { name: "删除所选（2）" })).toBeTruthy();
    act(() => useProjectStore.temporal.getState().undo());
    // 工程回到空，面板回到空状态；再添加新灯具时不会被旧选择污染
    expect(screen.getByText("还没有灯具。到左侧“灯具”标签页添加。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加 1 个 可调白光灯" }));
    expect(within(detail()).getByText("可调白光灯 1", { selector: "p" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除 可调白光灯 1" })).toBeTruthy();
  });

  it("素材库没有模型时给出提示，加载失败时可重试", () => {
    useFixtureStore.setState({ models: [], status: "ready", error: null });
    const { unmount } = renderEditor();
    expect(screen.getByText("灯具素材库里还没有模型")).toBeTruthy();
    unmount();

    useFixtureStore.setState({ models: [], status: "error", error: "io" });
    invoke.mockResolvedValue([RGBW]);
    renderEditor();
    expect(screen.getByRole("alert").textContent).toBe("无法加载灯具素材库");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(invoke).toHaveBeenCalledWith("fixture_list");
  });
});

describe("多 Universe 配接与详情", () => {
  /** 直接载入 3 台 RGBW（U0 @1/5/9）。 */
  function seed() {
    act(() =>
      useProjectStore.getState().update((d) => {
        d.fixtureModels = [RGBW];
        d.fixtures = [1, 2, 3].map((n) => ({
          id: `f${n}`,
          name: `灯${n}`,
          modelId: RGBW.id,
          universe: 0,
          address: 1 + (n - 1) * 4,
        }));
        d.tracks = d.fixtures.map((f) => ({ id: `t-${f.id}`, target: { kind: "fixture", id: f.id }, mute: false, solo: false, lock: false }));
      }),
    );
  }

  it("加镜像地址后列出镜像行，可修改、删除，并计入占用图", () => {
    seed();
    render(<InspectorPanel />);
    fireEvent.click(option("灯1"));
    fireEvent.click(within(detail()).getByRole("button", { name: "给 灯1 加一个镜像地址（多重配接）" }));
    expect(project().fixtures[0].mirrors).toEqual([{ universe: 1, address: 1 }]);
    expect(screen.getByRole("img", { name: /Universe 1：占用 4 \/ 512/ })).toBeTruthy();
    expect(within(option("灯1")).getByText("+1")).toBeTruthy();

    commit(within(detail()).getByRole("textbox", { name: "灯1 镜像 1 的起始地址" }), "101");
    expect(project().fixtures[0].mirrors).toEqual([{ universe: 1, address: 101 }]);

    fireEvent.click(within(detail()).getByRole("button", { name: "删除 灯1 的镜像 1" }));
    expect(project().fixtures[0].mirrors).toBeUndefined();
  });

  it("选中多台后顺序配接：放不下时进到下一个 Universe", () => {
    seed();
    act(() => ui().setSelectedFixtures(["f1", "f2", "f3"]));
    render(<InspectorPanel />);
    const form = screen.getByRole("group", { name: "顺序配接所选灯具" });
    const [u, a] = within(form).getAllByRole("textbox");
    fireEvent.change(u, { target: { value: "3" } });
    fireEvent.change(a, { target: { value: "507" } });
    fireEvent.click(within(form).getByRole("button", { name: "配接 3 个" }));
    expect(project().fixtures.map((f) => [f.universe, f.address])).toEqual([
      [3, 507],
      [4, 1],
      [4, 5],
    ]);
  });

  it("多台的共同属性：值不同显示“混合”，修改作用于全部（一步撤销）", () => {
    seed();
    act(() =>
      useProjectStore.getState().update((d) => {
        d.fixtures[0].stage = { x: 0, y: 0, z: 3 };
      }),
    );
    act(() => ui().setSelectedFixtures(["f1", "f2", "f3"]));
    render(<InspectorPanel />);
    const height = within(detail()).getByRole("textbox", { name: "高度" }) as HTMLInputElement;
    expect(height.value).toBe("");
    expect(height.placeholder).toBe("（混合值）");
    // 多台时没有 X / Y（各自的位置不同）：高度 / 朝向一行、吊挂 / 复位一行
    expect(within(detail()).queryByRole("textbox", { name: "X（左右）" })).toBeNull();
    const rows = within(detail()).getAllByTestId("placement-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getAllByRole("textbox").map((x) => x.getAttribute("aria-label"))).toEqual(["高度", "朝向"]);
    const steps = useProjectStore.temporal.getState().pastStates.length;
    commit(height, "4.5");
    expect(project().fixtures.map((f) => f.stage?.z)).toEqual([4.5, 4.5, 4.5]);
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps + 1);
    expect((within(detail()).getByRole("textbox", { name: "高度" }) as HTMLInputElement).value).toBe("4.5");
  });

  it("单台可直接改舞台坐标", () => {
    seed();
    act(() => ui().setSelectedFixtures(["f2"]));
    render(<InspectorPanel />);
    // 单台：X / Y 一行在最前
    const rows = within(detail()).getAllByTestId("placement-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getAllByRole("textbox").map((x) => x.getAttribute("aria-label"))).toEqual(["X（左右）", "Y（前后）"]);
    commit(within(detail()).getByRole("textbox", { name: "X（左右）" }), "1.5");
    commit(within(detail()).getByRole("textbox", { name: "Y（前后）" }), "2");
    expect(project().fixtures[1].stage).toMatchObject({ x: 1.5, y: 2 });
  });

  it("批量同步（默认收起，展开状态会记住）、按模板重命名（一步撤销）、补建缺少的轨道", () => {
    seed();
    act(() =>
      useProjectStore.getState().update((d) => {
        d.fixtures[0].stage = { x: 0, y: 0, z: 3, hanging: true };
        d.tracks = d.tracks.slice(0, 2);
      }),
    );
    act(() => ui().setSelectedFixtures(["f3", "f1", "f2"]));
    const { unmount } = render(<InspectorPanel />);
    expect(screen.queryByRole("group", { name: "批量设置所选 3 台灯具" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "批量同步" }));
    expect(useEditorPrefsStore.getState().patchSections.sync).toBe(true);
    const bar = screen.getByRole("group", { name: "批量设置所选 3 台灯具" });
    // 基准是 Patch 列表里的第一台，与选择顺序无关
    fireEvent.click(within(bar).getByRole("button", { name: "以“灯1”为准同步" }));
    expect(project().fixtures.map((f) => f.stage?.hanging)).toEqual([true, true, true]);
    expect(project().fixtures[2].stage?.z).toBe(3);

    const steps = useProjectStore.temporal.getState().pastStates.length;
    fireEvent.change(within(detail()).getByRole("textbox", { name: "名称模板" }), { target: { value: "前排 {n}" } });
    fireEvent.click(within(detail()).getByRole("button", { name: "重命名 3 台" }));
    expect(project().fixtures.map((f) => f.name)).toEqual(["前排 1", "前排 2", "前排 3"]);
    expect(useProjectStore.temporal.getState().pastStates.length).toBe(steps + 1);

    // 重新打开：批量同步仍是展开的
    unmount();
    render(<InspectorPanel />);
    expect(screen.getByRole("group", { name: "批量设置所选 3 台灯具" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消选择" }));
    fireEvent.click(screen.getByRole("button", { name: "补建 1 条缺少的轨道" }));
    expect(project().tracks).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /补建/ })).toBeNull();
  });

  it("在 Patch 中定位：滚动到目标灯具；被搜索挡住时先清掉搜索；请求被消费", () => {
    seed();
    render(<InspectorPanel />);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索名称、型号或地址" }), { target: { value: "灯1" } });
    expect(within(list()).queryByRole("option", { name: "灯3" })).toBeNull();
    act(() => {
      ui().setSelectedFixtures(["f3"]);
      ui().revealFixtures(["f3"]);
    });
    expect((screen.getByRole("searchbox", { name: "搜索名称、型号或地址" }) as HTMLInputElement).value).toBe("");
    expect(scrolled).toHaveBeenCalledWith(option("灯3"));
    expect(ui().revealRequest).toBeNull();
    expect(option("灯3").getAttribute("aria-selected")).toBe("true");
    // 同一台再请求一次也会滚动
    scrolled.mockReset();
    act(() => ui().revealFixtures(["f3"]));
    expect(scrolled).toHaveBeenCalledWith(option("灯3"));
  });

  it("Universe 卡片：默认一行摘要，展开后列出灯具；悬停色块与舞台互相高亮；通道格 512 格（64 × 8）", () => {
    seed();
    render(<InspectorPanel />);
    const card = screen.getByRole("region", { name: "U0" });
    // 收起时清单只给读屏
    const cardList = within(card).getByRole("list", { name: "Universe 0 的灯具（按地址）" });
    expect(cardList.className).toContain("sr-only");
    fireEvent.click(within(card).getByRole("button", { name: "展开 U0" }));
    const open = within(screen.getByRole("region", { name: "U0" })).getByRole("list", { name: "Universe 0 的灯具（按地址）" });
    expect(open.className).not.toContain("sr-only");
    expect(within(open).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1–4灯1", "5–8灯2", "9–12灯3"]);
    const block = card.querySelector('[data-bar] [data-owner="f2"]') as HTMLElement;
    fireEvent.pointerMove(block);
    expect(ui().hoverFixtureId).toBe("f2");
    expect(within(open).getAllByRole("listitem")[1].className).toContain("bg-accent");
    // 列表里的同一台也高亮
    expect(option("灯2").className).toContain("bg-accent");
    fireEvent.pointerLeave(card.closest("ul") as HTMLElement);
    expect(ui().hoverFixtureId).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "通道格" }));
    const grid = within(screen.getByRole("region", { name: "U0" })).getByRole("img", { name: /Universe 0：占用 12/ });
    expect(grid.children).toHaveLength(512);
    expect(grid.style.gridTemplateColumns).toContain("64");
    expect(grid.children[4].getAttribute("title")).toBe("通道 5 · 灯2");
    act(() => ui().setUniverseView("cards"));
  });

  it("DMX 通道视图（默认收起）：输入通道号说明归属", () => {
    seed();
    render(<InspectorPanel />);
    fireEvent.click(screen.getByRole("button", { name: "DMX 通道" }));
    const input = screen.getByRole("textbox", { name: "要查看的通道号" });
    fireEvent.change(input, { target: { value: "6" } });
    fireEvent.blur(input);
    expect(screen.getByText(/通道 6 = 0 · 灯2 · Green/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "要查看的通道号" }), { target: { value: "200" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "要查看的通道号" }));
    expect(screen.getByText("通道 200 = 0，没有灯具占用")).toBeTruthy();
  });
});

describe("像素行", () => {
  /** 往工程里加 2 台 3 像素灯条，返回灯具 id。 */
  function seedBars(): string[] {
    let ids: string[] = [];
    act(() => {
      useProjectStore.getState().update((d) => {
        ids = addFixtures(d, PIXEL_BAR, 2);
      });
    });
    return ids;
  }

  it("展开像素行，像素可以单选 / Ctrl 追加；← 回到灯具行再收起", () => {
    render(<InspectorPanel />);
    const [a] = seedBars();
    expect(within(list()).getAllByRole("option")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "展开 灯条 1 的 3 个像素" }));
    expect(within(list()).getAllByRole("option").map((o) => o.getAttribute("aria-label"))).toEqual([
      "灯条 1",
      "灯条 1 · 像素 1",
      "灯条 1 · 像素 2",
      "灯条 1 · 像素 3",
      "灯条 2",
    ]);
    // 点像素不会展开或选中灯具本身
    fireEvent.click(option("灯条 1 · 像素 1"));
    fireEvent.click(option("灯条 1 · 像素 3"), { ctrlKey: true });
    expect(ui().selectedFixtureIds).toEqual([`${a}#1`, `${a}#3`]);
    expect(within(detail()).getByText("已选 2 个像素")).toBeTruthy();
    // Shift 连选按可见行的顺序
    fireEvent.click(option("灯条 1"));
    fireEvent.click(option("灯条 1 · 像素 2"), { shiftKey: true });
    expect(ui().selectedFixtureIds).toEqual([a, `${a}#1`, `${a}#2`]);

    // 键盘：↓ 到像素行，← 回到灯具行，再 ← 收起
    fireEvent.click(option("灯条 1"));
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(ui().selectedFixtureIds).toEqual([`${a}#1`]);
    fireEvent.keyDown(list(), { key: "ArrowLeft" });
    fireEvent.keyDown(list(), { key: "ArrowLeft" });
    expect(within(list()).getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(list(), { key: "ArrowRight" });
    expect(within(list()).getAllByRole("option")).toHaveLength(5);
  });

  it("为所选像素建轨道（已有的不重复建）、用所选像素建组", () => {
    render(<InspectorPanel />);
    const [a] = seedBars();
    fireEvent.click(screen.getByRole("button", { name: "展开 灯条 1 的 3 个像素" }));
    fireEvent.click(option("灯条 1 · 像素 1"));
    fireEvent.click(option("灯条 1 · 像素 2"), { ctrlKey: true });

    const pixelTracks = () => project().tracks.filter((t) => t.target.kind === "fixture" && t.target.id.includes("#"));
    fireEvent.click(screen.getByRole("button", { name: "为所选像素建轨道" }));
    expect(pixelTracks().map((t) => (t.target.kind === "fixture" ? t.target.id : ""))).toEqual([`${a}#1`, `${a}#2`]);
    fireEvent.click(screen.getByRole("button", { name: "为所选像素建轨道" }));
    expect(pixelTracks()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "用所选像素建组" }));
    const group = project().groups.at(-1);
    expect(group?.name).toBe("像素组 1");
    expect(group?.fixtureIds).toEqual([`${a}#1`, `${a}#2`]);
  });
});
