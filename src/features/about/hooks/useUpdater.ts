import { useCallback, useReducer } from "react";

import { errorMessage } from "@/shared/lib/errors";
import { checkForUpdate, type Update } from "@/shared/tauri/updater";
import { INITIAL_UPDATE_STATE, updateReducer } from "../lib/updateMachine";


/**
 * 软件更新流程：检查 → 发现 → 下载（带进度）→ 安装。
 *
 * 状态由 {@link updateReducer} 管理；本 hook 只负责把异步调用的结果翻译成动作。
 * Windows 上安装程序会在启动后退出应用，其余平台提示用户手动重启。
 *
 * @returns 当前状态与两个操作：`check` 查询更新，`install` 下载并安装已发现的更新。
 */
export function useUpdater() {
  const [state, dispatch] = useReducer(updateReducer, INITIAL_UPDATE_STATE);

  const check = useCallback(async () => {
    dispatch({ type: "check" });
    try {
      const found = await checkForUpdate();
      dispatch(found ? { type: "found", update: found } : { type: "upToDate" });
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, []);

  const install = useCallback(async (update: Update) => {
    dispatch({ type: "install" });
    try {
      await update.downloadAndInstall((event) => dispatch({ type: "download", event }));
      dispatch({ type: "installed" });
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, []);

  return { state, check, install };
}
