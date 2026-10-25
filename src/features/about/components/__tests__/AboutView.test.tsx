// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const updater = vi.hoisted(() => ({ checkForUpdate: vi.fn() }));
const api = vi.hoisted(() => ({ getAppInfo: vi.fn() }));

vi.mock("@/shared/tauri/updater", () => updater);
vi.mock("../../lib/api", () => api);

import i18n from "@/shared/i18n";
import { AboutView } from "../AboutView";

const INFO = {
  name: "Art-Net Studio",
  version: "0.1.0",
  os: "windows",
  arch: "x86_64",
  profile: "release" as const,
};

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AboutView />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  api.getAppInfo.mockResolvedValue(INFO);
});

afterEach(() => cleanup());

describe("AboutView", () => {
  it("展示应用名、版本与运行环境", async () => {
    renderView();
    expect(await screen.findByText("版本 0.1.0")).toBeTruthy();
    // 运行环境清单默认折叠，但内容在 DOM 里，展开后即可见
    expect(screen.getByText("发布构建")).toBeTruthy();
  });

  it("运行环境默认折叠，信息读取成功后复制按钮可用", async () => {
    const { container } = renderView();
    await screen.findByText("版本 0.1.0");

    // 展开/收起由浏览器原生 <details> 负责（jsdom 不模拟），这里只确认默认状态
    expect((container.querySelector("details") as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByRole("button", { name: "复制诊断信息" })).toHaveProperty("disabled", false);
  });

  it("页脚显示版权行", async () => {
    renderView();
    expect(
      await screen.findByText(`© ${new Date().getFullYear()} Art-Net Studio. 保留所有权利。`),
    ).toBeTruthy();
  });

  it("读取应用信息失败时给出提示", async () => {
    api.getAppInfo.mockRejectedValue(new Error("boom"));
    renderView();
    expect(await screen.findByText("读取应用信息失败")).toBeTruthy();
  });

  it("已是最新：显示成功状态，按钮保留为再次检查", async () => {
    updater.checkForUpdate.mockResolvedValue(null);
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("已是最新版本")).toBeTruthy();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeTruthy();
  });

  it("发现新版本：状态行给出版本与发布信息，并可下载安装", async () => {
    const downloadAndInstall = vi.fn(
      async (onEvent: (e: unknown) => void) => {
        onEvent({ event: "Started", data: { contentLength: 2048 } });
        onEvent({ event: "Progress", data: { chunkLength: 1024 } });
        onEvent({ event: "Finished" });
      },
    );
    updater.checkForUpdate.mockResolvedValue({
      version: "9.9.9",
      currentVersion: "0.1.0",
      body: "修复若干问题",
      date: "2026-10-25T08:00:00Z",
      downloadAndInstall,
    });
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("发现新版本 9.9.9")).toBeTruthy();
    expect(screen.getByText(/当前版本 0\.1\.0/)).toBeTruthy();
    // 更新说明收在默认折叠的 details 里，内容仍在 DOM
    expect(screen.getByText("修复若干问题")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下载并安装" }));

    expect(await screen.findByText("更新已安装")).toBeTruthy();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    // 安装完成后不再提供主操作按钮
    expect(screen.queryByRole("button", { name: "下载并安装" })).toBeNull();
  });

  it("检查失败：显示错误原因，重试会再次检查", async () => {
    updater.checkForUpdate.mockRejectedValueOnce(new Error("no endpoint"));
    updater.checkForUpdate.mockResolvedValueOnce(null);
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("no endpoint")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("已是最新版本")).toBeTruthy();
    expect(updater.checkForUpdate).toHaveBeenCalledTimes(2);
  });

});
