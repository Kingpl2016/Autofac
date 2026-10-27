import { useEffect } from "react";

import { onShowState, showLoad, showSeek, showStop } from "../lib/playbackApi";
import { createSyncer, throttle } from "../lib/syncer";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";
import { setActiveSyncer } from "./playbackSync";
import { reportPlaybackError } from "./transportActions";

/** 工程变更推给后端前的防抖时长。 */
const SYNC_DELAY_MS = 150;

/** 拖动播放头时跳转命令的最小间隔。 */
const SEEK_INTERVAL_MS = 40;

/**
 * 连接编辑器与后端预览引擎（编辑器页面挂载期间生效）：
 *
 * - 工程每次变化（防抖后）整体推给后端，使 Locate / 播放总是用最新的灯光数据；
 * - 订阅 `show:state`，把后端的位置写入播放头 —— 播放期间播放头完全由后端驱动；
 * - 用户拖动播放头（不是后端驱动的变化）时，把位置发给后端；
 * - 卸载时停止输出，避免离开页面后灯还亮着。
 */
export function useShowPlayback(): void {
  useEffect(() => {
    let alive = true;
    let fromBackend = -1;

    const syncer = createSyncer(showLoad, reportPlaybackError, SYNC_DELAY_MS);
    setActiveSyncer(syncer);
    const unsubscribeProject = useProjectStore.subscribe((s, prev) => {
      if (s.project !== prev.project) syncer.push(s.project);
    });

    const seek = throttle((ms: number) => {
      void showSeek(ms).catch(reportPlaybackError);
    }, SEEK_INTERVAL_MS);
    const unsubscribePlayhead = useEditorUiStore.subscribe((s, prev) => {
      if (s.playheadMs !== prev.playheadMs && s.playheadMs !== fromBackend) seek(s.playheadMs);
    });

    let unlisten: (() => void) | null = null;
    void onShowState((state) => {
      usePlaybackStore.getState().setState(state);
      if (useEditorUiStore.getState().playheadMs !== state.positionMs) {
        fromBackend = state.positionMs;
        useEditorUiStore.getState().setPlayhead(state.positionMs);
      }
    })
      .then((off) => {
        if (alive) unlisten = off;
        else off();
      })
      // 订阅失败（例如没有 Tauri 运行时）时，播放状态保持为“未知”，编辑功能不受影响
      .catch(() => undefined);

    // 首次：先把工程交给后端，再把后端位置对齐到当前播放头
    syncer.push(useProjectStore.getState().project);
    void syncer
      .flush()
      .then(() => {
        if (alive) return showSeek(useEditorUiStore.getState().playheadMs);
      })
      .catch(reportPlaybackError);

    return () => {
      alive = false;
      setActiveSyncer(null);
      syncer.dispose();
      seek.cancel();
      unsubscribeProject();
      unsubscribePlayhead();
      unlisten?.();
      usePlaybackStore.getState().reset();
      void showStop().catch(() => undefined);
    };
  }, []);
}
