// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import i18n from "@/shared/i18n";

const api = vi.hoisted(() => ({ playerSeries: vi.fn() }));

vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));

import { ChannelCurves } from "../ChannelCurves";

const PATH = "D:/rec/show.artrec";

function renderCurves(posUs = 0) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChannelCurves path={PATH} durationUs={600_000_000} posUs={posUs} universes={[5, 6]} />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  api.playerSeries.mockResolvedValue([
    {
      channel: 0,
      points: [
        { tUs: 0, min: 0, max: 0 },
        { tUs: 1_000_000, min: 10, max: 200 },
      ],
    },
  ]);
});

afterEach(() => cleanup());

describe("ChannelCurves", () => {
  it("默认查询第一路 Universe 的通道 1，整段节目", async () => {
    renderCurves();
    await waitFor(() => expect(api.playerSeries).toHaveBeenCalled());
    const q = api.playerSeries.mock.calls[0][0];
    expect(q).toMatchObject({
      path: PATH,
      universe: 5,
      channels: [0],
      t0Us: 0,
      t1Us: 600_000_000,
    });
    expect(q.maxPoints).toBeGreaterThanOrEqual(64);
  });

  it("显示图例，并为屏幕阅读器提供每个通道的范围摘要", async () => {
    renderCurves();
    expect(await screen.findByText("通道 1")).toBeTruthy();
    const row = (await screen.findByRole("rowheader", { name: "1" })).closest("tr")!;
    expect(row.textContent).toContain("0");
    expect(row.textContent).toContain("200");
  });

  it("输入通道列表后防抖再查询（1 起输入转 0 起）", async () => {
    renderCurves();
    await waitFor(() => expect(api.playerSeries).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("通道（1-512）"), { target: { value: "3, 10-11" } });
    await waitFor(() =>
      expect(api.playerSeries).toHaveBeenLastCalledWith(
        expect.objectContaining({ channels: [2, 9, 10] }),
      ),
    );
  });

  it("清空通道后不再请求，并提示输入通道", async () => {
    renderCurves();
    await waitFor(() => expect(api.playerSeries).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("通道（1-512）"), { target: { value: "" } });
    expect(await screen.findByText(/输入要查看的通道/)).toBeTruthy();
    expect(screen.queryByText("通道 1")).toBeNull();
    expect(api.playerSeries).toHaveBeenCalledTimes(1);
  });

  it("后端失败时给出提示而不是崩溃", async () => {
    api.playerSeries.mockRejectedValue(new Error("boom"));
    renderCurves();
    expect(await screen.findByText("无法读取通道曲线")).toBeTruthy();
  });
});
