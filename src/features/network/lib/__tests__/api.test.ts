// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/shared/tauri/invoke", () => ({ invoke: core.invoke }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (p: unknown) => void = () => undefined;
  },
}));

import {
  netdevOtaUpload,
  netdevProbe,
  netdevProgramOp,
  netdevSeek,
  netdevUploadFile,
  newTransferId,
} from "../api";

beforeEach(() => {
  core.invoke.mockReset();
});

describe("命令参数", () => {
  it("使用后端期望的 camelCase 参数名", async () => {
    core.invoke.mockResolvedValue(undefined);
    await netdevProgramOp("d1", 7, 3);
    await netdevSeek("d1", 1500);
    expect(core.invoke).toHaveBeenNthCalledWith(1, "netdev_program_op", { id: "d1", no: 7, action: 3 });
    expect(core.invoke).toHaveBeenNthCalledWith(2, "netdev_seek", { id: "d1", posMs: 1500 });
  });

  it("探测时空 Token 传 null", async () => {
    core.invoke.mockResolvedValue({});
    await netdevProbe("10.0.0.2", 80, "");
    expect(core.invoke).toHaveBeenCalledWith("netdev_probe", { host: "10.0.0.2", port: 80, token: null });
  });
});

describe("流式传输", () => {
  it("带上传输 id 与进度通道，并把进度转给回调", async () => {
    let received: Record<string, unknown> = {};
    core.invoke.mockImplementation((_cmd: string, args: Record<string, unknown>) => {
      received = args;
      return Promise.resolve({ name: "a.artrec", size: 1, program: 2 });
    });
    const onProgress = vi.fn();
    const handle = netdevUploadFile("d1", "a.artrec", "C:/a.artrec", onProgress);
    await expect(handle.promise).resolves.toMatchObject({ program: 2 });

    expect(received).toMatchObject({ id: "d1", name: "a.artrec", path: "C:/a.artrec", transferId: handle.id });
    const channel = received.onProgress as { onmessage: (p: unknown) => void };
    channel.onmessage({ done: 1, total: 2, speedBps: 3 });
    expect(onProgress).toHaveBeenCalledWith({ done: 1, total: 2, speedBps: 3 });
  });

  it("cancel 调用 netdev_cancel 且忽略其失败", async () => {
    core.invoke.mockImplementation((cmd: string) =>
      cmd === "netdev_cancel" ? Promise.reject(new Error("gone")) : new Promise(() => undefined),
    );
    const handle = netdevOtaUpload("d1", "C:/fw.bin", vi.fn());
    expect(() => handle.cancel()).not.toThrow();
    await Promise.resolve();
    expect(core.invoke).toHaveBeenCalledWith("netdev_cancel", { transferId: handle.id });
  });

  it("传输 id 唯一", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTransferId()));
    expect(ids.size).toBe(50);
  });
});
