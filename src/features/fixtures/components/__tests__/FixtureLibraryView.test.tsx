// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import i18n from "@/shared/i18n";

// Radix 的开关 / 选择控件用 ResizeObserver 测量尺寸，jsdom 里没有
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const invoke = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const pickers = vi.hoisted(() => ({ pickXlsxFile: vi.fn() }));
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/pickers", () => pickers);

import type { FixtureModel, FixtureProperty, ImportOutcome } from "../../lib/types";
import { useFixtureStore } from "../../stores/useFixtureStore";
import { FixtureLibraryView } from "../FixtureLibraryView";

function prop(overrides: Partial<FixtureProperty>): FixtureProperty {
  return {
    name: "红光",
    code: "Red",
    function: "red",
    channel: 1,
    width: 1,
    bigEndian: false,
    defaultValue: 0,
    valueDesc: "0~255:红光值",
    description: "",
    ...overrides,
  };
}

const rgb: FixtureModel = {
  id: "1.4.1.4",
  name: "RGB全彩灯",
  system: "照明",
  productType: "全彩",
  builtin: true,
  properties: [
    prop({}),
    prop({ name: "绿光", code: "Green", function: "green", channel: 2 }),
    prop({ name: "蓝光", code: "Blue", function: "blue", channel: 3 }),
  ],
};
const head: FixtureModel = {
  id: "2.1.2.1",
  name: "通用16CH摇头灯",
  system: "电动照明",
  productType: "摇头灯",
  builtin: false,
  properties: [
    prop({ name: "水平", code: "Pan", function: "pan", channel: 1, width: 2, bigEndian: true, defaultValue: 32768 }),
  ],
};

/** 模拟后端：持有一份模型列表，支持保存 / 删除。 */
function installBackend(initial: FixtureModel[], importOutcome?: ImportOutcome) {
  const models = [...initial];
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "fixture_list":
        return structuredClone(models);
      case "fixture_save": {
        const m = args?.model as FixtureModel;
        const i = models.findIndex((x) => x.id === m.id);
        if (i >= 0) models[i] = m;
        else models.push(m);
        return m;
      }
      case "fixture_delete": {
        const i = models.findIndex((x) => x.id === args?.id);
        models.splice(i, 1);
        return undefined;
      }
      case "fixture_import_xlsx":
        return importOutcome;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  invoke.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  pickers.pickXlsxFile.mockReset();
  useFixtureStore.setState({ models: [], status: "idle", error: null });
});

afterEach(() => cleanup());

describe("FixtureLibraryView", () => {
  it("加载后列出内置与自定义两组，并默认选中第一项显示通道属性", async () => {
    installBackend([rgb, head]);
    render(<FixtureLibraryView />);

    expect(await screen.findByRole("region", { name: "内置标准模型" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "自定义模型" })).toBeTruthy();
    // 默认选中的 RGB 灯：详情里有三行属性，且内置模型没有“编辑 / 删除”
    const table = screen.getByRole("table", { name: "RGB全彩灯 的通道属性" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.getByRole("button", { name: "复制为自定义" })).toBeTruthy();
  });

  it("选中自定义模型后可编辑 / 删除，16 位属性显示字节序", async () => {
    installBackend([rgb, head]);
    render(<FixtureLibraryView />);
    fireEvent.click(await screen.findByRole("button", { name: /通用16CH摇头灯/ }));

    expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.getByText("16 位（大端）")).toBeTruthy();
    expect(screen.getByText("1–2")).toBeTruthy();
  });

  it("搜索按名称或编号过滤，没有匹配时给出提示", async () => {
    installBackend([rgb, head]);
    render(<FixtureLibraryView />);
    await screen.findByRole("button", { name: /RGB全彩灯/ });

    const search = screen.getByRole("searchbox", { name: "搜索名称或编号" });
    fireEvent.change(search, { target: { value: "2.1.2" } });
    expect(screen.queryByRole("button", { name: /RGB全彩灯/ })).toBeNull();
    expect(screen.getByRole("button", { name: /通用16CH摇头灯/ })).toBeTruthy();

    fireEvent.change(search, { target: { value: "没有这个" } });
    expect(screen.getByText("没有匹配的模型")).toBeTruthy();
  });

  it("新建自定义模型：填写后保存，列表出现新模型并提示成功", async () => {
    installBackend([rgb]);
    render(<FixtureLibraryView />);
    await screen.findByRole("button", { name: /RGB全彩灯/ });

    fireEvent.click(screen.getByRole("button", { name: "新建自定义模型" }));
    const dialog = await screen.findByRole("dialog");
    // 建议的编号是 2.1.1.2
    expect((within(dialog).getByLabelText("模型编号") as HTMLInputElement).value).toBe("2.1.1.2");

    // 缺名称、缺属性时，提交被拦下并逐步说明原因，不会调用后端
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByText("请填写模型名称")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("模型名称"), { target: { value: "我的灯" } });
    expect(await within(dialog).findByText("至少添加一个通道属性")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("fixture_save", expect.anything());

    fireEvent.click(within(dialog).getByRole("button", { name: "添加属性" }));
    fireEvent.change(within(dialog).getByLabelText("第 1 行 属性名"), { target: { value: "亮度" } });
    fireEvent.change(within(dialog).getByLabelText("第 1 行 英文代码"), { target: { value: "Bright" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const saved = invoke.mock.calls.find((c) => c[0] === "fixture_save")?.[1]?.model as FixtureModel;
    expect(saved).toMatchObject({ id: "2.1.1.2", name: "我的灯", builtin: false });
    expect(saved.properties).toHaveLength(1);
    expect(saved.properties[0]).toMatchObject({ channel: 1, width: 1, code: "Bright" });
    expect(toast.success).toHaveBeenCalledWith("已保存模型“我的灯”");
    expect(await screen.findByRole("button", { name: /我的灯/ })).toBeTruthy();
  });

  it("复制内置模型：编号可改、名称带副本后缀，编号被占用时提示", async () => {
    installBackend([rgb]);
    render(<FixtureLibraryView />);
    fireEvent.click(await screen.findByRole("button", { name: "复制为自定义" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("模型名称") as HTMLInputElement).value).toBe("RGB全彩灯（副本）");

    fireEvent.change(within(dialog).getByLabelText("模型编号"), { target: { value: "1.4.1.4" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByText("这个模型编号已被占用")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("fixture_save", expect.anything());
  });

  it("删除自定义模型需要确认，确认后调用后端", async () => {
    installBackend([rgb, head]);
    render(<FixtureLibraryView />);
    fireEvent.click(await screen.findByRole("button", { name: /通用16CH摇头灯/ }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("删除模型“通用16CH摇头灯”？")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("fixture_delete", expect.anything());
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fixture_delete", { id: "2.1.2.1" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /通用16CH摇头灯/ })).toBeNull());
  });

  it("导入 Excel：展示统计与警告；取消选择时什么都不做", async () => {
    installBackend([rgb, head], {
      added: ["2.2.1.4"],
      updated: ["2.1.2.1"],
      skipped: ["1.4.1.4"],
      warnings: [{ kind: "channelsReassigned", sheet: "1-标准物模型", row: 8, modelId: "1.4.1.4", detail: null }],
    });
    render(<FixtureLibraryView />);
    await screen.findByRole("button", { name: /RGB全彩灯/ });

    pickers.pickXlsxFile.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "导入物模型表" }));
    await waitFor(() => expect(pickers.pickXlsxFile).toHaveBeenCalledTimes(1));
    expect(invoke).not.toHaveBeenCalledWith("fixture_import_xlsx", expect.anything());

    pickers.pickXlsxFile.mockResolvedValueOnce("D:\\doc\\DMX物模型表.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "导入物模型表" }));
    const dialog = await screen.findByRole("dialog", { name: "导入完成" });
    expect(invoke).toHaveBeenCalledWith("fixture_import_xlsx", { path: "D:\\doc\\DMX物模型表.xlsx" });
    expect(within(dialog).getByText("新增 1 个，覆盖 1 个，忽略 1 个。")).toBeTruthy();
    expect(
      within(dialog).getByText("模型 1.4.1.4（1-标准物模型 第 8 行起）的起始通道重叠，已按书写顺序依次排布。"),
    ).toBeTruthy();
  });

  it("导入失败时用 toast 说明原因", async () => {
    installBackend([rgb]);
    pickers.pickXlsxFile.mockResolvedValue("D:\\bad.xlsx");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fixture_list") return [rgb];
      throw "import_failed:no_models";
    });
    render(<FixtureLibraryView />);
    await screen.findByRole("button", { name: /RGB全彩灯/ });
    fireEvent.click(screen.getByRole("button", { name: "导入物模型表" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("导入失败：文件里没有找到可导入的物模型"),
    );
  });

  it("加载失败时显示错误并可重试", async () => {
    invoke.mockRejectedValueOnce("io");
    render(<FixtureLibraryView />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/无法加载灯具库/)).toBeTruthy();

    installBackend([rgb]);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: /RGB全彩灯/ })).toBeTruthy();
  });
});
