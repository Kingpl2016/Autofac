// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import i18n from "@/shared/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
const api = vi.hoisted(() => ({ recordingCheckDir: vi.fn(), recordingOpenDir: vi.fn() }));
const dir = vi.hoisted(() => ({ pickDirectory: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("../../lib/recordingDir", () => api);
vi.mock("@/shared/tauri/directory", () => dir);

import type { DirCheck } from "../../lib/recordingDir";
import { RecordingDirField } from "../RecordingDirField";

const check = (over: Partial<DirCheck> = {}, free: number | null = 5_000_000_000): DirCheck => ({
  path: "D:/rec",
  exists: true,
  isDir: true,
  writable: true,
  disk: {
    path: "D:/rec",
    freeBytes: free,
    level: free !== null && free < 1_000_000_000 ? "low" : "ok",
    canStart: free === null || free >= 500_000_000,
  },
  ...over,
});

/** 受控包装：模拟设置页把草稿存在父组件里。 */
function Harness({ initial = "", onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <RecordingDirField
      value={v}
      onChange={(n) => {
        setV(n);
        onChange?.(n);
      }}
    />
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  api.recordingCheckDir.mockResolvedValue(check());
  api.recordingOpenDir.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("RecordingDirField", () => {
  it("留空时说明使用默认目录，并显示剩余空间", async () => {
    render(<Harness />);
    expect(await screen.findByText("使用默认目录：D:/rec")).toBeTruthy();
    expect(screen.getByText("剩余 5.0 GB")).toBeTruthy();
    expect((screen.getByRole("button", { name: "恢复默认" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("浏览选中目录后写入草稿，并按新目录重新检查", async () => {
    dir.pickDirectory.mockResolvedValue("E:/shows");
    api.recordingCheckDir.mockImplementation((p?: string) =>
      Promise.resolve(check({ path: p || "D:/rec" })),
    );
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "浏览…" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("E:/shows"));
    expect(await screen.findByText("实际使用的目录：E:/shows")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("E:/shows");
  });

  it("取消浏览不改动草稿", async () => {
    dir.pickDirectory.mockResolvedValue(null);
    const onChange = vi.fn();
    render(<Harness initial="D:/rec" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "浏览…" }));
    await waitFor(() => expect(dir.pickDirectory).toHaveBeenCalledWith("D:/rec"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("恢复默认把草稿清空", () => {
    const onChange = vi.fn();
    render(<Harness initial="E:/shows" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("目录不可写：输入框标记无效，并在下方给出可读错误（与输入框关联）", async () => {
    api.recordingCheckDir.mockResolvedValue(check({ writable: false }));
    render(<Harness initial="C:/Windows/System32" />);
    const msg = await screen.findByText("无法写入该目录，请检查权限或换一个目录。");
    const input = screen.getByRole("textbox");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("rec-dir-help");
    expect(msg.closest("#rec-dir-help")).toBeTruthy();
  });

  it("路径是文件时给出专门的提示", async () => {
    api.recordingCheckDir.mockResolvedValue(check({ writable: false, isDir: false }));
    render(<Harness initial="D:/notes.txt" />);
    expect(await screen.findByText("该路径是一个文件，不是目录，请选择文件夹。")).toBeTruthy();
  });

  it("剩余空间偏低或不足以开始时，用文字（不只是颜色）标明", async () => {
    api.recordingCheckDir.mockResolvedValue(check({}, 300_000_000));
    render(<Harness initial="D:/rec" />);
    expect(await screen.findByText(/剩余 300 MB · 不足 500 MB，无法开始录制/)).toBeTruthy();
    cleanup();

    api.recordingCheckDir.mockResolvedValue(check({}, 800_000_000));
    render(<Harness initial="D:/rec" />);
    expect(await screen.findByText(/剩余 800 MB · 偏低/)).toBeTruthy();
  });

  it("打开目录使用当前草稿路径；后端拒绝非目录时提示", async () => {
    render(<Harness initial="E:/shows" />);
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    await waitFor(() => expect(api.recordingOpenDir).toHaveBeenCalledWith("E:/shows"));

    api.recordingOpenDir.mockRejectedValue(new Error("not_a_directory"));
    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("该路径不是已存在的目录，无法打开。"),
    );
  });

  it("无法检查（非桌面环境等）时不显示任何状态，也不报错", async () => {
    api.recordingCheckDir.mockRejectedValue(new Error("desktop only"));
    render(<Harness initial="D:/rec" />);
    await waitFor(() => expect(api.recordingCheckDir).toHaveBeenCalled());
    expect(screen.queryByText(/实际使用的目录/)).toBeNull();
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBeNull();
  });
});
