import { useEffect } from "react";

import { setMode, setPattern, setSpeed } from "../lib/api";
import { useCheckerFormStore } from "../stores/useCheckerFormStore";

/**
 * 窗口打开时，把上次保存的模式 / 图案 / 倍速推给后端。
 *
 * 后端的发送器常驻在应用里，但这三项只在界面里保存；应用刚启动时后端是出厂默认值，
 * 需要等偏好从磁盘读回之后再同步一次，之后的改动由各控件直接下发。连接配置不在此列：
 * 它是草稿，要用户点“应用”或“开始发送”才生效。
 */
export function useBackendSync(): void {
  useEffect(() => {
    const push = () => {
      const { mode, pattern, speed } = useCheckerFormStore.getState();
      void Promise.all([setMode(mode), setPattern(pattern), setSpeed(speed)]).catch(() => undefined);
    };
    if (useCheckerFormStore.persist.hasHydrated()) {
      push();
      return;
    }
    return useCheckerFormStore.persist.onFinishHydration(push);
  }, []);
}
