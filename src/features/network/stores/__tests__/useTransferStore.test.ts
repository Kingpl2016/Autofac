// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TransferHandle } from "../../lib/api";
import type { Progress } from "../../lib/types";
import { useTransferStore } from "../useTransferStore";

function handle<T>(id: string, promise: Promise<T>): TransferHandle<T> {
  return { id, promise, cancel: vi.fn() };
}

beforeEach(() => {
  useTransferStore.setState({ items: [] });
});

describe("useTransferStore", () => {
  it("跟踪进度并在成功后标记完成", async () => {
    let emit: (p: Progress) => void = () => undefined;
    let resolve: (v: string) => void = () => undefined;
    const p = new Promise<string>((r) => {
      resolve = r;
    });
    const run = useTransferStore.getState().run(
      { kind: "upload", deviceId: "d1", label: "a.artrec" },
      (onProgress) => {
        emit = onProgress;
        return handle("t1", p);
      },
    );

    expect(useTransferStore.getState().items[0]).toMatchObject({ id: "t1", state: "running" });
    emit({ done: 50, total: 100, speedBps: 10 });
    expect(useTransferStore.getState().items[0].progress?.done).toBe(50);

    resolve("ok");
    await expect(run).resolves.toBe("ok");
    const item = useTransferStore.getState().items[0];
    expect(item.state).toBe("done");
    expect(item.progress?.done).toBe(100);
  });

  it("失败记录错误，取消单独标记", async () => {
    const run = useTransferStore.getState();
    await expect(
      run.run({ kind: "download", deviceId: "d1", label: "x" }, () =>
        handle("t2", Promise.reject({ code: "no_space", message: "满" })),
      ),
    ).rejects.toBeTruthy();
    await expect(
      run.run({ kind: "ota", deviceId: "d1", label: "fw.bin" }, () =>
        handle("t3", Promise.reject({ code: "cancelled", message: "取消" })),
      ),
    ).rejects.toBeTruthy();

    const items = useTransferStore.getState().items;
    expect(items.find((i) => i.id === "t2")).toMatchObject({ state: "failed", error: { code: "no_space" } });
    expect(items.find((i) => i.id === "t3")?.state).toBe("cancelled");
  });

  it("dismiss 与 clearFinished 不会移除进行中的传输", async () => {
    const never = new Promise<void>(() => undefined);
    void useTransferStore.getState().run({ kind: "upload", deviceId: "d", label: "run" }, () => handle("r", never));
    await useTransferStore
      .getState()
      .run({ kind: "upload", deviceId: "d", label: "done" }, () => handle("f", Promise.resolve()));

    useTransferStore.getState().dismiss("r");
    expect(useTransferStore.getState().items.map((i) => i.id).sort()).toEqual(["f", "r"]);
    useTransferStore.getState().clearFinished();
    expect(useTransferStore.getState().items.map((i) => i.id)).toEqual(["r"]);
  });
});
