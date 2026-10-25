import { useEffect } from "react";
import { toast } from "sonner";

import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { onEvent } from "@/shared/tauri/events";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { playerStatus } from "../lib/api";
import type { PlaybackStatus, PlayerChannelsPayload, PlaylistEvent } from "../lib/types";
import { usePlayerStore } from "../stores/usePlayerStore";

/**
 * 订阅回放事件（`player:state` / `player:channels` / `player:playlist`），
 * 同步到回放 store 与顶部状态条，并把连播结果告知用户。
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
      patchStatus({ playback: p.loaded, playing: p.loaded && p.state === "playing" });
      // 节目被关闭 / 切换后，旧的通道缓存不再有意义
      if (!p.loaded) clearChannels();
    };
    const unlisteners: Array<Promise<() => void>> = [
      onEvent<PlaybackStatus>("player:state", apply),
      onEvent<PlayerChannelsPayload>("player:channels", (p) =>
        setChannels(p.universe, p.data),
      ),
      onEvent<PlaylistEvent>("player:playlist", (e) => {
        if (e.kind === "advanced") {
          // 自动切换节目时焦点没有移动，只做读屏播报，不弹 toast 打扰现场操作
          announce(i18n.t("player.nowPlaying", { name: e.name }));
        } else if (e.kind === "listFinished") {
          const msg = i18n.t("player.listFinished");
          toast.info(msg);
          announce(msg);
        } else {
          toast.error(i18n.t("player.advanceFailed", { name: e.name, reason: e.reason }));
        }
      }),
    ];

    void playerStatus()
      .then(apply)
      .catch(() => {});

    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [setStatus, setChannels, clearChannels, patchStatus]);
}
