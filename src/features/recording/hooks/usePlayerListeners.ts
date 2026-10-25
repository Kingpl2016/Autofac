import { useEffect } from "react";

import { isTauri } from "@/shared/tauri/invoke";
import { onEvent } from "@/shared/tauri/events";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { playerStatus } from "../lib/api";
import type { PlaybackStatus, PlayerChannelsPayload } from "../lib/types";
import { usePlayerStore } from "./usePlayerStore";

/**
 * 订阅回放事件（`player:state` / `player:channels`），同步到回放 store 与顶部状态条。
 * 在应用根挂载一次。
 */
export function usePlayerListeners() {
  const setStatus = usePlayerStore((s) => s.setStatus);
  const setChannels = usePlayerStore((s) => s.setChannels);
  const clearChannels = usePlayerStore((s) => s.clearChannels);
  const patchStatus = useEngineStatusStore((s) => s.patch);

  useEffect(() => {
    const apply = (p: PlaybackStatus) => {
      setStatus(p);
      patchStatus({ playback: p.loaded });
      // 节目被关闭 / 切换后，旧的通道缓存不再有意义
      if (!p.loaded) clearChannels();
    };
    const unlisteners: Array<Promise<() => void>> = [
      onEvent<PlaybackStatus>("player:state", apply),
      onEvent<PlayerChannelsPayload>("player:channels", (p) =>
        setChannels(p.universe, p.data),
      ),
    ];

    if (isTauri()) {
      void playerStatus()
        .then(apply)
        .catch(() => {});
    }

    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [setStatus, setChannels, clearChannels, patchStatus]);
}
