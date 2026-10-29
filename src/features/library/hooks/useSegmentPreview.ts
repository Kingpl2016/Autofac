import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/shared/lib/errors";
import { enterPlayerModeNow } from "@/features/app-mode";
import {
  playerClose,
  playerOpen,
  playerPause,
  playerPlay,
  playerSeek,
  usePlayerStore,
  type EditSegment,
} from "@/features/recording";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { previewJumpTarget, segmentIndexAt } from "../lib/segments";

/** 本地估算播放位置、检查是否需要跳段的间隔（毫秒）。 */
const TICK_MS = 40;
/** 距片段末尾不足该时长（微秒）就提前跳到下一段，避免播出删除段开头的几帧。 */
const LOOKAHEAD_US = 50_000;

/**
 * 预览编辑结果：在播放器里打开源节目，只播放保留的片段——播到片段末尾跳到下一个片段，
 * 最后一个片段播完回到第一个（循环）。
 *
 * 播放位置以后端推送的状态为锚点、按倍速在本地推算，比等待状态推送更及时地跳过间隙。
 * 编辑页本身处于播放器模式（进入页面即自动进入，不确认），预览直接在本页播放，不跳转到播放器页。
 * 离开页面时卸载预览打开的节目，不留下“已打开节目”的状态。
 *
 * @param path 源节目路径。
 * @param segments 保留的片段（已排序、互不重叠）。
 * @param onPosition 预览期间的播放位置（源时间，微秒），用于移动时间轴上的播放头。
 */
export function useSegmentPreview(
  path: string,
  segments: readonly EditSegment[],
  onPosition: (us: number) => void,
) {
  const status = usePlayerStore((s) => s.status);
  const [active, setActive] = useState(false);
  const ownLoaded = status.loaded && status.path === path;
  const playing = ownLoaded && status.state === "playing";

  // 最近一次状态推送作为位置锚点
  const anchor = useRef({ posUs: status.posUs, at: 0 });
  useEffect(() => {
    anchor.current = { posUs: status.posUs, at: performance.now() };
  }, [status.posUs, status.state]);

  const seeking = useRef(false);
  const lastEstimate = useRef(0);
  const segsRef = useRef(segments);
  const onPositionRef = useRef(onPosition);
  useEffect(() => {
    segsRef.current = segments;
    onPositionRef.current = onPosition;
  });

  const jump = useCallback((to: number) => {
    if (seeking.current) return;
    seeking.current = true;
    anchor.current = { posUs: to, at: performance.now() };
    void playerSeek(to).finally(() => {
      seeking.current = false;
    });
  }, []);

  // 播放中：推算位置，落进间隙或接近片段末尾时跳转
  useEffect(() => {
    if (!active || !playing) return;
    const id = window.setInterval(() => {
      const segs = segsRef.current;
      if (segs.length === 0) return;
      const est = anchor.current.posUs + (performance.now() - anchor.current.at) * status.speedMilli;
      lastEstimate.current = est;
      onPositionRef.current(est);
      const i = segmentIndexAt(segs, est);
      if (i >= 0) {
        if (segs[i].endUs - est > LOOKAHEAD_US) return;
        jump(segs[(i + 1) % segs.length].startUs);
        return;
      }
      const target = previewJumpTarget(segs, est);
      if (target !== null) jump(target);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [active, playing, status.speedMilli, jump]);

  // 预览开始后是否已经真的播起来（状态推送晚于命令返回，开始前的“已停止”不能当成播完）
  const sawPlaying = useRef(false);
  useEffect(() => {
    if (active && playing) sawPlaying.current = true;
  }, [active, playing]);

  // 播放停止：最后一个片段延伸到节目末尾时，播放器会先停在结尾——从第一个片段重新开始；
  // 其余情况（用户在别处按了停止）结束预览
  useEffect(() => {
    if (!active || !ownLoaded || status.state !== "stopped" || !sawPlaying.current) return;
    const segs = segsRef.current;
    const last = segs[segs.length - 1];
    if (!last || lastEstimate.current < last.endUs - 4 * LOOKAHEAD_US) {
      setActive(false);
      return;
    }
    sawPlaying.current = false;
    void playerSeek(segs[0].startUs)
      .then(() => playerPlay())
      .catch(() => setActive(false));
  }, [active, ownLoaded, status.state]);

  const start = useCallback(
    (fromUs: number) => {
      const segs = segsRef.current;
      if (segs.length === 0) return;
      const from = segmentIndexAt(segs, fromUs) >= 0 ? fromUs : (previewJumpTarget(segs, fromUs) ?? segs[0].startUs);
      const begin = async () => {
        if (!ownLoaded) await playerOpen(path);
        await playerSeek(from);
        await playerPlay();
        anchor.current = { posUs: from, at: performance.now() };
        sawPlaying.current = false;
        setActive(true);
      };
      // 播放器模式由页面负责进入；万一还在实时模式（例如自动进入失败后重试），先不确认地进入
      void enterPlayerModeNow()
        .then((ok) => (ok ? begin() : undefined))
        .catch((e: unknown) => toast.error(errorMessage(e)));
    },
    [ownLoaded, path],
  );

  /**
   * 进入编辑页时调用：确保处于播放器模式（不确认），并在播放器里打开源节目，之后的预览可以立刻开始。
   * 播放器正在播放别的节目时不打断它，等开始预览时再换成源节目。
   */
  const enter = useCallback(() => {
    void enterPlayerModeNow().then((ok) => {
      if (!ok || useEngineStatusStore.getState().appMode !== "player") return;
      const s = usePlayerStore.getState().status;
      if ((s.loaded && s.path === path) || (s.loaded && s.state === "playing")) return;
      return playerOpen(path).catch((e: unknown) => toast.error(errorMessage(e)));
    });
  }, [path]);

  const stop = useCallback(() => {
    setActive(false);
    if (playing) void playerPause().catch(() => undefined);
  }, [playing]);

  // 离开页面时卸载预览打开的节目（不退出播放器模式；离开到普通页面时由页面规则退回实时模式）
  useEffect(
    () => () => {
      const s = usePlayerStore.getState().status;
      if (s.loaded && s.path === path) void playerClose().catch(() => undefined);
    },
    [path],
  );

  return { active: active && ownLoaded, ownLoaded, start, stop, enter };
}
