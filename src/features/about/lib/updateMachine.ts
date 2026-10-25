import type { DownloadEvent, Update } from "@/shared/tauri/updater";

/**
 * 更新流程的状态。每个状态只携带自己需要的数据（如下载进度只存在于 `downloading`），
 * 让界面无法渲染出「已下载 50% 却在检查更新」这类自相矛盾的组合。
 */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; update: Update }
  /** `total` 为 `null` 表示服务器没有给出体积，进度条退化为不确定态 */
  | { kind: "downloading"; update: Update; downloaded: number; total: number | null }
  | { kind: "installing"; update: Update }
  | { kind: "installed" }
  /** 失败时若已有 `update`，重试应直接重新安装，而不是再检查一次 */
  | { kind: "error"; message: string; update: Update | null };

/** 驱动 {@link UpdateState} 变化的动作。 */
export type UpdateAction =
  | { type: "check" }
  | { type: "upToDate" }
  | { type: "found"; update: Update }
  | { type: "install" }
  | { type: "download"; event: DownloadEvent }
  | { type: "installed" }
  | { type: "failed"; message: string };

/** 初始状态。 */
export const INITIAL_UPDATE_STATE: UpdateState = { kind: "idle" };

/** 取出状态中携带的 `Update`（没有则 `null`）。 */
function carriedUpdate(state: UpdateState): Update | null {
  switch (state.kind) {
    case "available":
    case "downloading":
    case "installing":
      return state.update;
    case "error":
      return state.update;
    default:
      return null;
  }
}

/**
 * 更新流程 reducer。
 *
 * 非法转移（例如下载中又点了「检查更新」）一律忽略并保持原状态，
 * 这样界面按钮即使被连点也不会重复发起请求。
 *
 * @param state 当前状态。
 * @param action 动作。
 * @returns 下一个状态。
 */
export function updateReducer(state: UpdateState, action: UpdateAction): UpdateState {
  switch (action.type) {
    case "check":
      return state.kind === "idle" ||
        state.kind === "upToDate" ||
        (state.kind === "error" && state.update === null)
        ? { kind: "checking" }
        : state;

    case "upToDate":
      return state.kind === "checking" ? { kind: "upToDate" } : state;

    case "found":
      return state.kind === "checking" ? { kind: "available", update: action.update } : state;

    case "install": {
      const update = state.kind === "available" || state.kind === "error" ? carriedUpdate(state) : null;
      return update ? { kind: "downloading", update, downloaded: 0, total: null } : state;
    }

    case "download": {
      if (state.kind !== "downloading") return state;
      const { event } = action;
      if (event.event === "Started") {
        return { ...state, downloaded: 0, total: event.data.contentLength ?? null };
      }
      if (event.event === "Progress") {
        return { ...state, downloaded: state.downloaded + event.data.chunkLength };
      }
      // Finished：下载完毕，随后进入安装
      return { kind: "installing", update: state.update };
    }

    case "installed":
      return state.kind === "downloading" || state.kind === "installing"
        ? { kind: "installed" }
        : state;

    case "failed":
      return { kind: "error", message: action.message, update: carriedUpdate(state) };
  }
}
