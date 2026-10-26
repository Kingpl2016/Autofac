import { describe, expect, it, vi } from "vitest";

import {
  BOOT_WAIT_MS,
  MIN_BOOT_WAIT_MS,
  compareVersion,
  runUpgrade,
  type UpgradeDeps,
  type UpgradeTarget,
} from "../upgrade";
import type { DeviceStatus } from "../types";

describe("compareVersion", () => {
  it("比较点分数字版本", () => {
    expect(compareVersion("1.4.3", "1.4.2")).toBe("newer");
    expect(compareVersion("1.4.2", "1.4.2")).toBe("same");
    expect(compareVersion("1.3.9", "1.4.0")).toBe("older");
    expect(compareVersion("2.0", "1.9.9")).toBe("newer");
    expect(compareVersion("1.4", "1.4.0")).toBe("same");
    expect(compareVersion("v1.10.0", "1.9.0")).toBe("newer");
  });

  it("带后缀只比较数字部分，无法解析为 unknown", () => {
    expect(compareVersion("1.4.2-rc1", "1.4.2")).toBe("same");
    expect(compareVersion("abc", "1.0.0")).toBe("unknown");
    expect(compareVersion("1.0.0", "")).toBe("unknown");
  });
});

/** 构造可控时间的依赖：sleep 推进虚拟时钟。 */
function makeDeps(opts: {
  /** 每次 status 调用的结果：版本字符串 = 在线，Error = 离线 */
  statuses: Array<string | Error>;
  uploadError?: unknown;
}) {
  let clock = 0;
  const calls: string[] = [];
  const statuses = [...opts.statuses];
  const deps: UpgradeDeps = {
    upload: vi.fn(async (id, onPercent) => {
      calls.push(`upload:${id}`);
      if (opts.uploadError) throw opts.uploadError;
      onPercent(40);
      onPercent(100);
      return { newVersion: "2.0.0", rebooting: true };
    }),
    status: vi.fn(async () => {
      const next = statuses.shift() ?? new Error("offline");
      if (next instanceof Error) throw next;
      return { version: next } as DeviceStatus;
    }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    markRebooting: (id) => calls.push(`reboot:${id}`),
  };
  return { deps, calls };
}

function harness() {
  const state = new Map<string, Partial<UpgradeTarget>>();
  const history: string[] = [];
  return {
    state,
    history,
    update: (id: string, patch: Partial<UpgradeTarget>) => {
      state.set(id, { ...state.get(id), ...patch });
      if (patch.phase) history.push(`${id}:${patch.phase}`);
    },
  };
}

describe("runUpgrade", () => {
  it("掉线后再上线且版本一致：走完全部阶段", async () => {
    const { deps } = makeDeps({ statuses: [new Error("offline"), new Error("offline"), "2.0.0"] });
    const h = harness();
    await runUpgrade({ targets: [{ id: "a", name: "A" }], expectedVersion: "2.0.0", deps, update: h.update, shouldStop: () => false });
    expect(h.history).toEqual(["a:uploading", "a:writing", "a:rebooting", "a:verifying", "a:done"]);
    expect(h.state.get("a")?.percent).toBe(100);
  });

  it("版本不符判为失败（可能已回滚）", async () => {
    const { deps } = makeDeps({ statuses: [new Error("offline"), "1.9.0"] });
    const h = harness();
    await runUpgrade({ targets: [{ id: "a", name: "A" }], expectedVersion: "2.0.0", deps, update: h.update, shouldStop: () => false });
    expect(h.state.get("a")?.phase).toBe("failed");
    expect(h.state.get("a")?.error?.code).toBe("version_mismatch");
  });

  it("一直在线（探测错过掉线）时等满最短时间后才接受", async () => {
    const online = Array.from({ length: 40 }, () => "2.0.0");
    const { deps } = makeDeps({ statuses: online });
    const h = harness();
    let slept = 0;
    const base = deps.sleep;
    deps.sleep = async (ms) => {
      slept += ms;
      await base(ms);
    };
    await runUpgrade({ targets: [{ id: "a", name: "A" }], expectedVersion: "2.0.0", deps, update: h.update, shouldStop: () => false });
    expect(h.state.get("a")?.phase).toBe("done");
    expect(slept).toBeGreaterThanOrEqual(MIN_BOOT_WAIT_MS);
  });

  it("设备始终不回来：超时失败", async () => {
    const { deps } = makeDeps({ statuses: [] });
    const h = harness();
    await runUpgrade({ targets: [{ id: "a", name: "A" }], expectedVersion: "2.0.0", deps, update: h.update, shouldStop: () => false });
    expect(h.state.get("a")?.error?.code).toBe("boot_timeout");
    expect(deps.now()).toBeGreaterThanOrEqual(BOOT_WAIT_MS);
  });

  it("上传失败后继续下一台，且不会触发重启跟踪", async () => {
    const { deps, calls } = makeDeps({ statuses: [new Error("offline"), "2.0.0"] });
    const upload = deps.upload;
    let n = 0;
    deps.upload = vi.fn(async (id, cb) => {
      n += 1;
      if (n === 1) throw { code: "no_space", message: "满" };
      return upload(id, cb);
    });
    const h = harness();
    await runUpgrade({
      targets: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      expectedVersion: "2.0.0",
      deps,
      update: h.update,
      shouldStop: () => false,
    });
    expect(h.state.get("a")?.error?.code).toBe("no_space");
    expect(h.state.get("b")?.phase).toBe("done");
    expect(calls).not.toContain("reboot:a");
    expect(calls).toContain("reboot:b");
  });

  it("请求取消后，当前台之后的设备标为 skipped", async () => {
    const { deps } = makeDeps({ statuses: [new Error("offline"), "2.0.0"] });
    const h = harness();
    let stop = false;
    const update = (id: string, patch: Partial<UpgradeTarget>) => {
      h.update(id, patch);
      if (id === "a" && patch.phase === "uploading") stop = true; // 在第一台执行期间点了"取消后续"
    };
    await runUpgrade({
      targets: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
      expectedVersion: "2.0.0",
      deps,
      update,
      shouldStop: () => stop,
    });
    expect(h.state.get("a")?.phase).toBe("done");
    expect(h.state.get("b")?.phase).toBe("skipped");
    expect(h.state.get("c")?.phase).toBe("skipped");
  });
});
