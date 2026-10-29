import { useCallback, useEffect } from "react";
import { toast } from "sonner";

import { useTauriEvent } from "@/shared/events/useObservable";
import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { playerStatus } from "../lib/api";
import type { PlaybackStatus, PlaylistEvent } from "../lib/types";
import { usePlayerStore } from "../stores/usePlayerStore";

/**
 * 订阅回放事件（`player:state` / `player:playlist`），
 * 同步到回放 store 与顶部状态条，并把连播结果告知用户。
 * 在应用根挂载一次。
 *
 * 被查看 Universe 的通道数据走二进制通道流（kind = 2），由应用根把 `applyChannelFrame`
 * 注入 `useDmxStream`，不经这里。
 */
export function usePlayerListeners() {
  const setStatus = usePlayerStore((s) => s.setStatus);
  const clearChannels = usePlayerStore((s) => s.clearChannels);
  const patchStatus = useEngineStatusStore((s) => s.patch);

  const apply = useCallback(
    (p: PlaybackStatus) => {
      setStatus(p);
      patchStatus({ playback: p.loaded, playing: p.loaded && p.state === "playing" });
      // 节目被关闭后，旧的通道缓存不再有意义（后端也会推一帧空的全量帧）
      if (!p.loaded) clearChannels();
    },
    [setStatus, patchStatus, clearChannels],
  );

  useTauriEvent<PlaybackStatus>("player:state", apply);
  useTauriEvent<PlaylistEvent>("player:playlist", (e) => {
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
  });

  useEffect(() => {
    void playerStatus()
      .then(apply)
      .catch(() => {});
  }, [apply]);
}
