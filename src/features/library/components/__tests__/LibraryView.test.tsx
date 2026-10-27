// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";

import i18n from "@/shared/i18n";

// Radix 菜单 / 复选框依赖 ResizeObserver，jsdom 没有
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({
  recordingsList: vi.fn(),
  recordingsRename: vi.fn(),
  recordingsDelete: vi.fn(),
  recordingsDuplicate: vi.fn(),
  recordingsSetNotes: vi.fn(),
  playerOpen: vi.fn(),
  playerPlay: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/features/network", () => ({
  useActiveDevice: () => ({ device: null, setActive: vi.fn() }),
  useDeviceStatus: () => ({ online: false, status: null, error: null, isLoading: false, refetch: vi.fn() }),
  netdevUploadRecording: vi.fn(),
  errorText: (_t: unknown, e: unknown) => String(e),
  useTransferStore: { getState: () => ({ run: vi.fn() }) },
}));
vi.mock("@/features/recording/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/features/recording/lib/api")>()),
  ...api,
}));

import type { LibraryEntry } from "@/features/recording";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { LibraryView } from "../LibraryView";

const entry = (over: Partial<LibraryEntry>): LibraryEntry => ({
  path: `D:/rec/${over.name ?? "x"}.artrec`,
  fileName: `${over.name ?? "x"}.artrec`,
  name: "x",
  notes: "",
  bytes: 2048,
  modifiedUnixMs: Date.now() - 60_000,
  durationUs: 65_000_000,
  frames: 120,
  universes: [1, 2],
  sources: ["10.0.0.1"],
  recovered: false,
  valid: true,
  editable: false,
  exported: true,
  header: null,
  ...over,
});

const LIST = [
  entry({ name: "开场秀", durationUs: 30_000_000, notes: "第一场" }),
  entry({ name: "收尾曲", durationUs: 90_000_000 }),
  entry({ name: "编辑器秀", editable: true }),
];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderView(route = "/library") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={client}>
        <LibraryView />
        <LocationProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const rowNames = () =>
  screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[3].textContent ?? "");

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  api.recordingsList.mockResolvedValue(structuredClone(LIST));
  useEngineStatusStore.setState({ appMode: "live", recording: false, playing: false });
});
afterEach(() => cleanup());

describe("节目库页面", () => {
  it("以表格列出节目；点击表头按时长排序并写入地址栏", async () => {
    renderView();
    expect(await screen.findByText("开场秀")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "按时长排序" }));
    const th = screen.getByRole("button", { name: "按时长排序" }).closest("th")!;
    expect(th.getAttribute("aria-sort")).toBe("descending");
    expect(rowNames()[0]).toContain("收尾曲");
    expect(screen.getByTestId("location").textContent).toContain("sort=duration");
  });

  it("搜索与类别筛选；没有结果时可一键清除筛选", async () => {
    renderView();
    await screen.findByText("开场秀");
    fireEvent.click(screen.getByRole("button", { name: /^编辑器/ }));
    expect(rowNames()).toHaveLength(1);
    expect(rowNames()[0]).toContain("编辑器秀");

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索节目" }), { target: { value: "不存在" } });
    expect(await screen.findByText("没有符合条件的节目")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "清除筛选" })[0]);
    await waitFor(() => expect(rowNames()).toHaveLength(3));
  });

  it("地址栏 sel 直接打开详情；修改备注后保存", async () => {
    api.recordingsSetNotes.mockResolvedValue(undefined);
    renderView(`/library?sel=${encodeURIComponent("D:/rec/开场秀.artrec")}`);
    const panel = await screen.findByRole("complementary", { name: "节目详情" });
    const notes = within(panel).getByRole("textbox", { name: "备注" });
    expect((notes as HTMLTextAreaElement).value).toBe("第一场");
    fireEvent.change(notes, { target: { value: "第二场" } });
    fireEvent.click(within(panel).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.recordingsSetNotes).toHaveBeenCalledWith("D:/rec/开场秀.artrec", "第二场"));
    expect(toast.success).toHaveBeenCalledWith("备注已保存");
  });

  it("点击行打开详情；复制后选中副本", async () => {
    api.recordingsDuplicate.mockResolvedValue("D:/rec/开场秀 副本.artrec");
    renderView();
    fireEvent.click(await screen.findByText("开场秀"));
    const panel = await screen.findByRole("complementary", { name: "节目详情" });
    fireEvent.click(within(panel).getByRole("button", { name: "复制" }));
    await waitFor(() => expect(api.recordingsDuplicate).toHaveBeenCalledWith("D:/rec/开场秀.artrec", "开场秀 副本"));
    const sel = () => new URLSearchParams(screen.getByTestId("location").textContent!.split("?")[1] ?? "").get("sel");
    await waitFor(() => expect(sel()).toBe("D:/rec/开场秀 副本.artrec"));
  });

  it("勾选多行后出现批量操作条；批量删除逐个执行并汇总失败", async () => {
    api.recordingsDelete.mockResolvedValueOnce(undefined).mockRejectedValueOnce("trash_failed: 回收站不可用");
    renderView();
    await screen.findByText("开场秀");
    fireEvent.click(screen.getByRole("checkbox", { name: "选择“开场秀”" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择“收尾曲”" }));
    const bar = screen.getByRole("region", { name: "批量操作" });
    expect(bar.textContent).toContain("已选 2 个");
    // 表头全选为半选状态
    expect(screen.getByRole("checkbox", { name: "全选当前列出的节目" }).getAttribute("aria-checked")).toBe("mixed");

    fireEvent.click(within(bar).getByRole("button", { name: "删除 2 个" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("移入系统回收站");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(await screen.findByText("部分节目没有删除")).toBeTruthy();
    expect(api.recordingsDelete).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog").textContent).toContain("无法移入回收站，节目已原样保留：回收站不可用");
  });

  it("节目库为空时引导去录制或新建", async () => {
    api.recordingsList.mockResolvedValue([]);
    renderView();
    expect(await screen.findByText("还没有节目")).toBeTruthy();
    expect(screen.getByRole("link", { name: "去录制" }).getAttribute("href")).toBe("/recording");
  });

  it("读取失败时说明原因并可重试", async () => {
    api.recordingsList.mockRejectedValueOnce("磁盘不可用").mockResolvedValue(structuredClone(LIST));
    renderView();
    expect(await screen.findByText("磁盘不可用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("开场秀")).toBeTruthy();
  });

  it("点“回放此节目”直接在本页播放，不跳转到播放器页", async () => {
    // 节目库页面处于播放器模式（由页面规则自动进入）
    useEngineStatusStore.setState({ appMode: "player" });
    api.playerOpen.mockResolvedValue(undefined);
    api.playerPlay.mockResolvedValue(undefined);
    renderView();
    await screen.findByText("开场秀");
    const row = screen.getByText("开场秀").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "回放此节目" }));
    await waitFor(() => expect(api.playerPlay).toHaveBeenCalledTimes(1));
    expect(api.playerOpen).toHaveBeenCalledWith("D:/rec/开场秀.artrec");
    expect(screen.getByTestId("location").textContent).toBe("/library");
  });
});
