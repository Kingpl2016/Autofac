// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";

const api = vi.hoisted(() => ({ saveForwarding: vi.fn() }));
const flags = vi.hoisted(() => ({ sacnEnabled: false }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/features/settings", () => ({
  useProtocolFlags: () => ({ sacnEnabled: flags.sacnEnabled }),
}));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));

import { useOutputStore } from "@/shared/stores/outputStore";
import { newDestination, type ForwardDestination } from "../../lib/types";
import { ForwardingEditor } from "../ForwardingEditor";

const dest = (
  id: string,
  protocol: ForwardDestination["protocol"] = "artNet",
): ForwardDestination => ({
  ...newDestination(),
  id,
  name: id,
  protocol,
  targetIp: "10.0.0.5",
});

/** 按页面从上到下的顺序读出各卡片的名称。 */
function names(): string[] {
  return screen
    .getAllByRole("button", { name: /^上移 / })
    .map((b) => (b.getAttribute("aria-label") ?? "").replace("上移 ", ""));
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  api.saveForwarding.mockResolvedValue(undefined);
  flags.sacnEnabled = false;
  useOutputStore.setState({ output: null, receivedAt: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("目的地排序", () => {
  const table = { destinations: [dest("A"), dest("B"), dest("C")] };

  it("首项不能上移，末项不能下移", () => {
    render(<ForwardingEditor initial={table} />);
    expect((screen.getByRole("button", { name: "上移 A" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "下移 A" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "下移 C" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("下移后顺序改变，并随自动保存写入", async () => {
    vi.useFakeTimers();
    render(<ForwardingEditor initial={table} />);
    fireEvent.click(screen.getByRole("button", { name: "下移 A" }));
    expect(names()).toEqual(["B", "A", "C"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const saved = api.saveForwarding.mock.calls[0][0] as { destinations: ForwardDestination[] };
    expect(saved.destinations.map((d) => d.id)).toEqual(["B", "A", "C"]);
  });

  it("上移同样生效", () => {
    render(<ForwardingEditor initial={table} />);
    fireEvent.click(screen.getByRole("button", { name: "上移 C" }));
    expect(names()).toEqual(["A", "C", "B"]);
  });

  it("sACN 关闭时，隐藏的 sACN 目的地不参与交换，保存后仍在原位", async () => {
    vi.useFakeTimers();
    const mixed = { destinations: [dest("A"), dest("S", "sacn"), dest("B")] };
    render(<ForwardingEditor initial={mixed} />);
    expect(names()).toEqual(["A", "B"]);

    fireEvent.click(screen.getByRole("button", { name: "上移 B" }));
    expect(names()).toEqual(["B", "A"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const saved = api.saveForwarding.mock.calls[0][0] as { destinations: ForwardDestination[] };
    // B 与可见邻居 A 交换；隐藏的 S 没有被丢掉，仍然在列表中
    expect(saved.destinations.map((d) => d.id).sort()).toEqual(["A", "B", "S"]);
    expect(saved.destinations.map((d) => d.id)).toEqual(["B", "S", "A"]);
  });
});

describe("目的地统计行", () => {
  it("收到输出统计后，启用的目的地显示累计发送数", () => {
    useOutputStore.setState({
      output: {
        state: "sending",
        sent: 10,
        sendErrors: 0,
        dropped: 0,
        sentRate: 0,
        lastError: null,
        lastErrorAgoMs: null,
        sender: "ready",
        destinations: [
          { id: "A", sent: 4321, errors: 0, dropped: 0, sentRate: 0, lastSendAgoMs: 0 },
        ],
      },
      receivedAt: Date.now(),
    });
    render(<ForwardingEditor initial={{ destinations: [dest("A"), dest("B")] }} />);
    expect(screen.getByText("4,321")).toBeTruthy();
    // B 启用但没有记录
    expect(screen.getByText("尚未发送数据")).toBeTruthy();
  });
});