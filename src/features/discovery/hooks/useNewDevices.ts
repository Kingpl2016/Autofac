import { useEffect, useRef, useState } from "react";

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { findNewIps } from "../lib/newDevices";

/** 新设备高亮持续时间（毫秒）。 */
export const FRESH_HIGHLIGHT_MS = 1800;

const EMPTY: ReadonlySet<string> = new Set();

/**
 * 跟踪“页面打开后新出现的设备”，用于行的短暂高亮。
 *
 * 以挂载时的设备列表为基线（不会把已有设备都当成新的）。之后每次后端推送出现的新 IP
 * 会在返回的集合里停留约 {@link FRESH_HIGHLIGHT_MS} 毫秒。通过 store 订阅回调更新状态，
 * 避免在 effect 里同步 `setState`。
 *
 * @returns 当前处于高亮期的设备 IP 集合。
 */
export function useNewDevices(): ReadonlySet<string> {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(EMPTY);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const known = new Set(useEngineDataStore.getState().devices.map((d) => d.ip));
    const pending = timers.current;

    const unsubscribe = useEngineDataStore.subscribe((state, prev) => {
      if (state.devices === prev.devices) return;
      const added = findNewIps(known, state.devices);
      if (added.length === 0) return;
      for (const ip of added) known.add(ip);

      setFresh((cur) => new Set([...cur, ...added]));
      const timer = setTimeout(() => {
        pending.delete(timer);
        setFresh((cur) => {
          const next = new Set(cur);
          for (const ip of added) next.delete(ip);
          return next;
        });
      }, FRESH_HIGHLIGHT_MS);
      pending.add(timer);
    });

    return () => {
      unsubscribe();
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return fresh;
}
