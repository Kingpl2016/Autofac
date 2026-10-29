// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import i18n from "@/shared/i18n";

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
const pickers = vi.hoisted(() => ({ pickZipFile: vi.fn(), pickDirectory: vi.fn() }));
vi.mock("@/shared/tauri/invoke", () => ({ invoke }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/pickers", () => pickers);

import type { CatalogItem, CatalogQuery, CatalogSummary, ImportOutcome } from "../../lib/types";
import { useFixtureStore } from "../../stores/useFixtureStore";
import { OflCatalogDialog } from "../OflCatalogDialog";

const summary: CatalogSummary = {
  source: "D:\\ofl.zip",
  entries: 3,
  redirects: 1,
  broken: 0,
  manufacturers: [{ key: "acme", name: "ACME", count: 3 }],
  categories: ["Moving Head", "Par"],
};

const item = (key: string, name: string, status: CatalogItem["status"], extra: Partial<CatalogItem> = {}): CatalogItem => ({
  key,
  manufacturerKey: "acme",
  manufacturer: "ACME",
  name,
  categories: ["Moving Head"],
  modes: [
    { name: "9ch", channels: 9 },
    { name: "14ch", channels: 14 },
  ],
  matrix: false,
  modelId: `ofl:${key}`,
  status,
  ...extra,
});

const items = [
  item("acme/spot", "Spot", "outdated"),
  item("acme/par", "Par", "new", { categories: ["Par"], modes: [{ name: "6ch", channels: 6 }] }),
  item("acme/old-spot", "Old Spot", "outdated", { redirectTo: "acme/spot" }),
];

const outcome: ImportOutcome = { added: [], updated: ["ofl:acme/spot"], skipped: [], warnings: [] };

function installBackend(hasCatalog: boolean) {
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const q = args?.query as CatalogQuery | undefined;
    const match = (i: CatalogItem) =>
      (!q?.status || i.status === q.status) && (!q?.text || i.name.toLowerCase().includes(q.text.toLowerCase()));
    switch (cmd) {
      case "ofl_catalog_summary":
        return hasCatalog ? summary : null;
      case "ofl_catalog_open":
        return summary;
      case "ofl_catalog_search": {
        const list = items.filter(match);
        return { total: list.length, items: list.slice(q?.offset ?? 0) };
      }
      case "ofl_catalog_keys":
        return items.filter(match).map((i) => i.key);
      case "ofl_catalog_import":
        return outcome;
      case "fixture_list":
        return [];
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
  pickers.pickZipFile.mockReset();
  useFixtureStore.setState({ models: [], status: "ready", error: null });
});

afterEach(() => cleanup());

describe("OflCatalogDialog", () => {
  it("没有目录时提示打开 zip，打开后列出灯具", async () => {
    installBackend(false);
    render(<OflCatalogDialog open onOpenChange={() => {}} onImported={() => {}} />);
    expect(await screen.findByText(/还没有打开 OFL 库/)).toBeTruthy();

    pickers.pickZipFile.mockResolvedValueOnce("D:\\ofl.zip");
    fireEvent.click(screen.getByRole("button", { name: "打开 zip" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("ofl_catalog_open", { path: "D:\\ofl.zip" }));
    const list = await screen.findByRole("list", { name: "灯具列表" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(toast.success).toHaveBeenCalledWith("已建立目录：3 个灯具");
  });

  it("显示状态、模式摘要与重定向；勾选后导入并回调结果", async () => {
    installBackend(true);
    const onImported = vi.fn();
    const onOpenChange = vi.fn();
    render(<OflCatalogDialog open onOpenChange={onOpenChange} onImported={onImported} />);
    const list = await screen.findByRole("list", { name: "灯具列表" });
    expect(within(list).getAllByText("可更新")).toHaveLength(2);
    expect(within(list).getAllByText(/2 种模式 · 9–14 通道/)).toHaveLength(2);
    expect(within(list).getByText(/1 种模式 · 6 通道/)).toBeTruthy();
    expect(within(list).getByText("重定向到 acme/spot，导入时导入目标灯具")).toBeTruthy();

    fireEvent.click(within(list).getByRole("checkbox", { name: /^Par/ }));
    expect(screen.getByText("已选 1 个")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "选中所有可更新的" }));
    await waitFor(() => expect(screen.getByText("已选 3 个")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "导入 3 个" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(outcome));
    const call = invoke.mock.calls.find((c) => c[0] === "ofl_catalog_import");
    expect([...(call?.[1]?.keys as string[])].sort()).toEqual(["acme/old-spot", "acme/par", "acme/spot"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("搜索与状态筛选交给后端查询", async () => {
    installBackend(true);
    render(<OflCatalogDialog open onOpenChange={() => {}} onImported={() => {}} />);
    await screen.findByRole("list", { name: "灯具列表" });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索名称、制造商或分类" }), { target: { value: "par" } });
    await waitFor(() => expect(screen.getByText("1 个结果")).toBeTruthy());
    fireEvent.click(screen.getByRole("radio", { name: "可更新" }));
    await waitFor(() => expect(screen.getByText("0 个结果")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("ofl_catalog_search", { query: expect.objectContaining({ text: "par", status: "outdated" }) });
  });
});
