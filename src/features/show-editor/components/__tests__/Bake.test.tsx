// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/shared/tauri/events", async () => (await import("@/test/mockTauriEvents")).tauriEventsModule);
import { tauriEvents } from "@/test/mockTauriEvents";

import { useBakeEvents } from "../../hooks/useBakeEvents";
import type { BakeEvent } from "../../stores/useBakeStore";
import { useBakeStore } from "../../stores/useBakeStore";
import { BakeStatus } from "../BakeStatus";

let client: QueryClient;

function Harness() {
  useBakeEvents();
  return <BakeStatus />;
}

const event = (over: Partial<BakeEvent>): BakeEvent => ({
  path: "D:/rec/秀.artrec",
  status: "running",
  progress: 0,
  frames: null,
  bytes: null,
  reason: null,
  ...over,
});

const emit = (e: BakeEvent) => act(async () => void tauriEvents.emit("show:bake", e));

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  for (const fn of Object.values(toast)) fn.mockReset();
  tauriEvents.reset();
  useBakeStore.getState().reset();
  client = new QueryClient();
  vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
});

afterEach(() => cleanup());

describe("保存后的后台烘焙事件", () => {
  it("进行中显示进度；完成后提示帧数、刷新节目库、进度消失", async () => {
    await act(async () => void (await Promise.resolve()));
    await emit(event({ progress: 0.4 }));
    expect(screen.getByRole("status").textContent).toContain("40%");
    expect(client.invalidateQueries).not.toHaveBeenCalled();

    await emit(event({ status: "done", progress: 1, frames: 123, bytes: 4096 }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("回放文件已生成（123 帧）");
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("失败：说明原因并告知工程已保存", async () => {
    await act(async () => void (await Promise.resolve()));
    await emit(event({ status: "failed", reason: "磁盘已满" }));
    expect(String(toast.error.mock.calls[0][0])).toContain("磁盘已满");
    expect(String(toast.error.mock.calls[0][0])).toContain("工程已保存");
  });

  it("跳过：节目正在回放 / 没有灯具各有各的提示", async () => {
    await act(async () => void (await Promise.resolve()));
    await emit(event({ status: "skipped", reason: "in_use" }));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    await emit(event({ status: "skipped", reason: "nothing_to_bake" }));
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("多个节目同时烘焙时显示最慢的进度", async () => {
    await act(async () => void (await Promise.resolve()));
    await emit(event({ path: "a", progress: 0.8 }));
    await emit(event({ path: "b", progress: 0.3 }));
    expect(screen.getByRole("status").textContent).toContain("30%");
  });

  it("卸载时取消订阅", async () => {
    await act(async () => void (await Promise.resolve()));
    expect(tauriEvents.has("show:bake")).toBe(true);
    cleanup();
    expect(tauriEvents.has("show:bake")).toBe(false);
  });
});
