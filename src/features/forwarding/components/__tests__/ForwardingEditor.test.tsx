// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({ saveForwarding: vi.fn() }));
const flags = vi.hoisted(() => ({ sacnEnabled: false }));

vi.mock("sonner", () => ({ toast }));
vi.mock("@/features/settings", () => ({
  useProtocolFlags: () => ({ sacnEnabled: flags.sacnEnabled }),
}));
vi.mock("../../lib/api", async (orig) => ({
  ...(await orig<typeof import("../../lib/api")>()),
  ...api,
}));

import { newDestination, type ForwardDestination } from "../../lib/types";
import { ForwardingEditor } from "../ForwardingEditor";
import { DestinationDialog } from "../DestinationDialog";

const dest = (name: string, protocol: ForwardDestination["protocol"]): ForwardDestination => ({
  ...newDestination(),
  id: name,
  name,
  protocol,
  targetIp: "10.0.0.5",
  port: protocol === "sacn" ? 5568 : 6454,
});

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  api.saveForwarding.mockResolvedValue(undefined);
  flags.sacnEnabled = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ForwardingEditor 的 sACN 开关", () => {
  const table = { destinations: [dest("Art灯", "artNet"), dest("SACN灯", "sacn")] };

  it("sACN 关闭时不显示 sACN 目的地，也不显示协议徽标", () => {
    render(<ForwardingEditor initial={table} />);

    expect(screen.getByText("Art灯")).toBeTruthy();
    expect(screen.queryByText("SACN灯")).toBeNull();
    expect(screen.queryByText("sACN")).toBeNull();
    expect(screen.queryByText("Art-Net")).toBeNull();
  });

  it("sACN 开启时显示全部目的地与协议徽标", () => {
    flags.sacnEnabled = true;
    render(<ForwardingEditor initial={table} />);

    expect(screen.getByText("Art灯")).toBeTruthy();
    expect(screen.getByText("SACN灯")).toBeTruthy();
    expect(screen.getByText("sACN")).toBeTruthy();
    expect(screen.getByText("Art-Net")).toBeTruthy();
  });

  it("隐藏的 sACN 目的地不会因为编辑其它目的地而从保存的数据里丢失", () => {
    vi.useFakeTimers();
    render(<ForwardingEditor initial={table} />);

    // 只有一个可见目的地，也就只有一个启停开关
    fireEvent.click(screen.getByRole("switch"));
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(api.saveForwarding).toHaveBeenCalledTimes(1);
    const saved = api.saveForwarding.mock.calls[0][0] as { destinations: ForwardDestination[] };
    expect(saved.destinations.map((d) => d.name)).toEqual(["Art灯", "SACN灯"]);
    expect(saved.destinations[0].enabled).toBe(false);
    expect(saved.destinations[1]).toEqual(table.destinations[1]);
  });

  it("全部目的地都是 sACN 且已关闭时，显示空状态而不是空列表", () => {
    render(<ForwardingEditor initial={{ destinations: [dest("SACN灯", "sacn")] }} />);
    expect(screen.getByText("暂无转发目的地，点击右上角添加")).toBeTruthy();
  });
});

describe("ForwardingEditor 的设备发现预填", () => {
  const table = { destinations: [dest("已有灯", "artNet")] }; // targetIp 10.0.0.5

  it("新 IP：直接打开预填好名称与目标 IP 的对话框，并提示", () => {
    render(
      <ForwardingEditor
        initial={table}
        prefill={{ name: "舞台左", targetIp: "10.0.0.99" }}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByDisplayValue("舞台左") as HTMLInputElement).value).toBe("舞台左");
    expect(screen.getByDisplayValue("10.0.0.99")).toBeTruthy();
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info.mock.calls[0][0]).toContain("10.0.0.99");
  });

  it("该 IP 已有目的地：打开它编辑，而不是新建重复项", () => {
    render(
      <ForwardingEditor initial={table} prefill={{ name: "别名", targetIp: "10.0.0.5" }} />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByDisplayValue("已有灯")).toBeTruthy();
    expect(screen.queryByDisplayValue("别名")).toBeNull();
    expect(toast.info.mock.calls[0][0]).toContain("已有转发目的地");
  });

  it("没有预填时不打开对话框", () => {
    render(<ForwardingEditor initial={table} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
  });
});

describe("DestinationDialog 的 sACN 开关", () => {
  const renderDialog = () =>
    render(
      <DestinationDialog
        open
        onOpenChange={vi.fn()}
        initial={newDestination()}
        onSave={vi.fn()}
      />,
    );

  it("sACN 关闭时不显示协议选择", () => {
    renderDialog();
    expect(screen.queryByText("协议")).toBeNull();
  });

  it("sACN 开启时显示协议选择", () => {
    flags.sacnEnabled = true;
    renderDialog();
    expect(screen.getByText("协议")).toBeTruthy();
  });
});
