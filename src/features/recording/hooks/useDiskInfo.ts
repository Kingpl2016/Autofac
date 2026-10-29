import { useEffect, useState } from "react";

import { recordingDiskInfo } from "../lib/api";
import type { DiskInfo } from "@/shared/domain/disk";

/** 空闲时刷新磁盘空间的间隔（毫秒）。 */
const REFRESH_MS = 15_000;

/**
 * 读取当前录制目录所在卷的剩余空间。
 *
 * 挂载时、窗口重新获得焦点时以及每 15 秒各查询一次；`paused` 为 true（例如录制中，
 * 此时由 `recording:stats` 事件提供实时值）时暂停轮询。查询失败（非桌面环境等）时结果为 `null`，
 * 界面据此不显示空间指标，也不会阻止录制。
 *
 * @param paused 为 true 时暂停轮询。
 * @returns 最近一次查询到的 [`DiskInfo`]；尚未查询或查询失败时为 `null`。
 */
export function useDiskInfo(paused: boolean): DiskInfo | null {
  const [info, setInfo] = useState<DiskInfo | null>(null);

  useEffect(() => {
    if (paused) return undefined;
    let cancelled = false;
    const load = () => {
      recordingDiskInfo()
        .then((d) => {
          if (!cancelled) setInfo(d);
        })
        .catch(() => {
          if (!cancelled) setInfo(null);
        });
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [paused]);

  return info;
}
