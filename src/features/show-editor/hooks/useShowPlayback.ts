import { useEffect } from "react";

import { showLoad, showSeek, showSetOutputEnabled, showState$, showStop } from "../lib/playbackApi";
import { blackoutProject, withProgrammer } from "../lib/programmer";
import { createSyncer, throttle } from "../lib/syncer";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
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
 * - 挂载时把“输出到网络”重置为开启；
 * - 卸载时停止输出，避免离开页面后灯还亮着。
 */
export function useShowPlayback(): void {
  useEffect(() => {
    let alive = true;
    let fromBackend = -1;

    const syncer = createSyncer(showLoad, reportPlaybackError, SYNC_DELAY_MS);
    setActiveSyncer(syncer);
    // 编程器“实时输出”打开时，推给后端的是叠了编程器的工程（灯立刻按编程器亮）
    const outgoing = () => {
      const project = useProjectStore.getState().project;
      // 黑场：全部轨道静音（Park 仍然生效），编程器也不输出
      if (useEditorUiStore.getState().blackout) return blackoutProject(project);
      const { live, values } = useProgrammerStore.getState();
      return live ? withProgrammer(project, values) : project;
    };
    const unsubscribeProject = useProjectStore.subscribe((s, prev) => {
      if (s.project !== prev.project) syncer.push(outgoing());
    });
    const unsubscribeProgrammer = useProgrammerStore.subscribe((s, prev) => {
      if (s.live !== prev.live || (s.live && s.values !== prev.values)) syncer.push(outgoing());
    });

    const seek = throttle((ms: number) => {
      void showSeek(ms).catch(reportPlaybackError);
    }, SEEK_INTERVAL_MS);
    const unsubscribeBlackout = useEditorUiStore.subscribe((s, prev) => {
      if (s.blackout !== prev.blackout) syncer.push(outgoing());
    });
    const unsubscribePlayhead = useEditorUiStore.subscribe((s, prev) => {
      if (s.playheadMs !== prev.playheadMs && s.playheadMs !== fromBackend) seek(s.playheadMs);
    });

    const stateSubscription = showState$.subscribe({
      next: (state) => {
        usePlaybackStore.getState().setState(state);
        if (useEditorUiStore.getState().playheadMs !== state.positionMs) {
          fromBackend = state.positionMs;
          useEditorUiStore.getState().setPlayhead(state.positionMs);
        }
      },
      // 订阅失败（例如没有 Tauri 运行时）时，播放状态保持为“未知”，编辑功能不受影响
      error: () => undefined,
    });

    // 每次打开编辑器，“输出到网络”都从开启开始（开关不存进工程，避免关着输出却找不到原因）
    void showSetOutputEnabled(true).catch(() => undefined);
    // 首次：先把工程交给后端，再把后端位置对齐到当前播放头
    syncer.push(outgoing());
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
      unsubscribeProgrammer();
      unsubscribeBlackout();
      unsubscribePlayhead();
      stateSubscription.unsubscribe();
      usePlaybackStore.getState().reset();
      void showStop().catch(() => undefined);
    };
  }, []);
}
