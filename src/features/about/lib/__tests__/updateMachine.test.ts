import { describe, expect, it } from "vitest";

import type { Update } from "@/shared/tauri/updater";
import {
  INITIAL_UPDATE_STATE,
  updateReducer,
  type UpdateAction,
  type UpdateState,
} from "../updateMachine";

const update = { version: "2.0.0", currentVersion: "1.0.0" } as Update;

/** 依次应用动作，返回最终状态。 */
function run(actions: UpdateAction[], from: UpdateState = INITIAL_UPDATE_STATE): UpdateState {
  return actions.reduce(updateReducer, from);
}

describe("updateReducer", () => {
  it("检查 → 已是最新", () => {
    expect(run([{ type: "check" }, { type: "upToDate" }])).toEqual({ kind: "upToDate" });
  });

  it("检查 → 发现新版本", () => {
    expect(run([{ type: "check" }, { type: "found", update }])).toEqual({
      kind: "available",
      update,
    });
  });

  it("下载事件累计进度，Finished 后进入安装，再到已安装", () => {
    const available: UpdateState = { kind: "available", update };
    const downloading = run(
      [
        { type: "install" },
        { type: "download", event: { event: "Started", data: { contentLength: 1000 } } },
        { type: "download", event: { event: "Progress", data: { chunkLength: 300 } } },
        { type: "download", event: { event: "Progress", data: { chunkLength: 200 } } },
      ],
      available,
    );
    expect(downloading).toEqual({ kind: "downloading", update, downloaded: 500, total: 1000 });

    const installing = updateReducer(downloading, {
      type: "download",
      event: { event: "Finished" },
    });
    expect(installing).toEqual({ kind: "installing", update });
    expect(updateReducer(installing, { type: "installed" })).toEqual({ kind: "installed" });
  });

  it("服务器没给体积时 total 为 null", () => {
    const state = run(
      [{ type: "install" }, { type: "download", event: { event: "Started", data: {} } }],
      { kind: "available", update },
    );
    expect(state).toMatchObject({ kind: "downloading", total: null });
  });

  it("检查失败后重试走检查；安装失败后重试走安装（保留已发现的更新）", () => {
    const checkFailed = run([{ type: "check" }, { type: "failed", message: "offline" }]);
    expect(checkFailed).toEqual({ kind: "error", message: "offline", update: null });
    expect(updateReducer(checkFailed, { type: "check" })).toEqual({ kind: "checking" });
    expect(updateReducer(checkFailed, { type: "install" })).toBe(checkFailed);

    const installFailed = run(
      [{ type: "install" }, { type: "failed", message: "disk full" }],
      { kind: "available", update },
    );
    expect(installFailed).toEqual({ kind: "error", message: "disk full", update });
    expect(updateReducer(installFailed, { type: "install" })).toMatchObject({
      kind: "downloading",
      update,
    });
    // 已有更新时不该重新检查
    expect(updateReducer(installFailed, { type: "check" })).toBe(installFailed);
  });

  it("忽略非法转移：下载中不能再检查，空闲时收到下载事件无效", () => {
    const downloading: UpdateState = { kind: "downloading", update, downloaded: 1, total: 2 };
    expect(updateReducer(downloading, { type: "check" })).toBe(downloading);
    expect(
      updateReducer(INITIAL_UPDATE_STATE, {
        type: "download",
        event: { event: "Progress", data: { chunkLength: 5 } },
      }),
    ).toBe(INITIAL_UPDATE_STATE);
    expect(updateReducer(INITIAL_UPDATE_STATE, { type: "install" })).toBe(INITIAL_UPDATE_STATE);
  });
});
