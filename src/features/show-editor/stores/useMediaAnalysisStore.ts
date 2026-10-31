import { useMemo } from "react";
import { create } from "zustand";

import { errorMessage } from "@/shared/lib/errors";
import { primaryMedia } from "../lib/media";
import { ANALYSIS_VERSION, mediaAnalyze, mediaCancel, SENSITIVITY, type AudioAnalysis } from "../lib/mediaApi";
import { firstClipOf, mapAnalysis, type TimelineAnalysis, type VideoAnalysisResult } from "../lib/mediaAnalysis";
import type { MediaRef, ShowProject } from "../lib/project";
import { useAiChatStore } from "./useAiChatStore";
import { useProjectStore } from "./useProjectStore";

/**
 * 素材的音乐结构分析与视频画面分析（运行时状态，不进工程、不进撤销历史；后端与缓存命令负责落盘缓存）。
 *
 * 重新分析时旧结果照常可用（`refreshing`），新结果出来才替换；失败时保留旧结果并记下错误。
 */

/** 一个素材的分析状态。 */
export interface AnalysisEntry {
  /** 分析的文件（路径变了要重新分析） */
  path: string;
  /** 音频分析的状态（`none`：还没分析过、也没有缓存；不会自动分析，等用户或 AI 生成时再分析） */
  status: "none" | "loading" | "ready" | "error";
  audio: AudioAnalysis | null;
  /** 错误码（失败时；有旧结果时旧结果仍可用） */
  error: string | null;
  /** 正在重新分析（旧结果仍在用） */
  refreshing: boolean;
  /** 分析用的灵敏度 */
  sensitivity: number;
  /** 进行中的请求 id（取消用） */
  requestId: string | null;
}

/** 一个视频素材的画面分析状态（`unsupported`：webview 读不出画面）。 */
export interface VideoEntry {
  path: string;
  status: "none" | "loading" | "ready" | "error" | "unsupported";
  video: VideoAnalysisResult | null;
}

interface MediaAnalysisState {
  entries: Record<string, AnalysisEntry>;
  /** 视频画面分析（按素材） */
  videos: Record<string, VideoEntry>;
  /**
   * 确保素材已分析（同一文件、同一灵敏度只分析一次）。
   *
   * @param media 素材。
   * @returns 分析结果；失败时为 `null`（错误记在状态里）。
   */
  ensure: (media: Pick<MediaRef, "id" | "path">) => Promise<AudioAnalysis | null>;
  /**
   * 只读缓存：之前分析过（后端有缓存）时直接得到结果，否则记成 `none`，不做分析（打开工程、显示参考线时用）。
   *
   * @param media 素材。
   * @returns 分析结果；没有缓存时为 `null`。
   */
  peek: (media: Pick<MediaRef, "id" | "path">) => Promise<AudioAnalysis | null>;
  /**
   * 重新分析（可换灵敏度）：旧结果在新结果出来前照常可用，失败时保留。
   *
   * @param media 素材。
   * @param sensitivity 灵敏度。
   * @returns 是否成功。
   */
  reanalyze: (media: Pick<MediaRef, "id" | "path">, sensitivity: number) => Promise<boolean>;
  /**
   * 取消进行中的分析。
   *
   * @param mediaId 素材 id。
   */
  cancel: (mediaId: string) => void;
  /**
   * 写入视频画面分析的状态 / 结果（结果省略时沿用同一文件的旧结果）。
   *
   * @param mediaId 素材 id。
   * @param patch 文件、状态与结果。
   */
  setVideo: (mediaId: string, patch: Pick<VideoEntry, "path" | "status"> & { video?: VideoAnalysisResult | null }) => void;
}

/** 新的请求 id。 */
const newRequestId = () => `ma-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 素材当前的灵敏度（用户设置，跟着工程保存）。 */
export function sensitivityOf(mediaId: string): number {
  return useAiChatStore.getState().media[mediaId]?.prefs?.sensitivity ?? SENSITIVITY.default;
}

/** 素材的分析状态。 */
export const useMediaAnalysisStore = create<MediaAnalysisState>((set, get) => {
  /** 请求分析；`keepOld` 为重新分析（保留旧结果）。 */
  const run = async (media: Pick<MediaRef, "id" | "path">, sensitivity: number, keepOld: boolean): Promise<AudioAnalysis | null> => {
    const old = get().entries[media.id];
    if (old?.requestId) void mediaCancel(old.requestId).catch(() => undefined);
    const requestId = newRequestId();
    const keep = keepOld && old?.path === media.path ? old : null;
    set((s) => ({
      entries: {
        ...s.entries,
        [media.id]: {
          path: media.path,
          status: keep?.audio ? "ready" : "loading",
          audio: keep?.audio ?? null,
          error: null,
          refreshing: !!keep?.audio,
          sensitivity,
          requestId,
        },
      },
    }));
    const settle = (patch: Partial<AnalysisEntry>) =>
      set((s) => {
        const cur = s.entries[media.id];
        // 期间又发起了新的请求：丢弃这次的结果
        if (!cur || cur.requestId !== requestId) return s;
        return { entries: { ...s.entries, [media.id]: { ...cur, ...patch, refreshing: false, requestId: null } } };
      });
    try {
      const audio = await mediaAnalyze(media.path, sensitivity, requestId);
      if (audio.version !== ANALYSIS_VERSION) throw new Error("version");
      settle({ status: "ready", audio, error: null });
      return get().entries[media.id]?.audio ?? null;
    } catch (e) {
      const code = errorMessage(e);
      const prev = get().entries[media.id]?.audio ?? null;
      settle({ status: prev ? "ready" : "error", error: code, ...(prev ? {} : { audio: null }) });
      return null;
    }
  };
  return {
    entries: {},
    videos: {},
    ensure: async (media) => {
      const sensitivity = sensitivityOf(media.id);
      const cur = get().entries[media.id];
      if (cur && cur.path === media.path && cur.sensitivity === sensitivity) {
        if (cur.status === "ready") return cur.audio;
        if (cur.status === "error") return null;
        if (cur.status === "none") return run(media, sensitivity, false);
        // 进行中：等它结束
        return new Promise((resolve) => {
          const off = useMediaAnalysisStore.subscribe((s) => {
            const e = s.entries[media.id];
            if (!e || e.requestId === null || e.requestId !== cur.requestId) {
              off();
              resolve(e?.audio ?? null);
            }
          });
        });
      }
      return run(media, sensitivity, cur?.path === media.path);
    },
    peek: async (media) => {
      const sensitivity = sensitivityOf(media.id);
      const cur = get().entries[media.id];
      if (cur && cur.path === media.path && cur.sensitivity === sensitivity) return cur.audio;
      try {
        const audio = await mediaAnalyze(media.path, sensitivity, undefined, true);
        if (audio.version !== ANALYSIS_VERSION) throw new Error("version");
        // 期间开始了真正的分析：以它为准
        if (get().entries[media.id]?.requestId) return null;
        set((s) => ({ entries: { ...s.entries, [media.id]: { path: media.path, status: "ready", audio, error: null, refreshing: false, sensitivity, requestId: null } } }));
        return audio;
      } catch {
        if (get().entries[media.id]?.requestId) return null;
        set((s) => ({ entries: { ...s.entries, [media.id]: { path: media.path, status: "none", audio: null, error: null, refreshing: false, sensitivity, requestId: null } } }));
        return null;
      }
    },
    reanalyze: async (media, sensitivity) => {
      const value = Math.min(SENSITIVITY.max, Math.max(SENSITIVITY.min, sensitivity));
      const chat = useAiChatStore.getState();
      chat.setMediaDoc(media.id, { prefs: { labels: chat.media[media.id]?.prefs?.labels ?? {}, sensitivity: value } });
      const before = get().entries[media.id]?.audio ?? null;
      const result = await run(media, value, true);
      return result !== null && result !== before;
    },
    cancel: (mediaId) => {
      const cur = get().entries[mediaId];
      if (!cur?.requestId) return;
      void mediaCancel(cur.requestId).catch(() => undefined);
      set((s) => ({
        entries: { ...s.entries, [mediaId]: { ...cur, requestId: null, refreshing: false, status: cur.audio ? "ready" : "error", error: "cancelled" } },
      }));
    },
    setVideo: (mediaId, patch) =>
      set((s) => {
        const cur = s.videos[mediaId];
        const video = patch.video !== undefined ? patch.video : cur?.path === patch.path ? cur.video : null;
        return { videos: { ...s.videos, [mediaId]: { path: patch.path, status: patch.status, video } } };
      }),
  };
});

/**
 * 当前工程的分析（主素材，换算到时间线）。
 *
 * @param project 工程。
 * @returns 分析；没有主素材或还没有结果时为 `null`。
 */
export function currentAnalysis(project: Pick<ShowProject, "media" | "mediaClips">): TimelineAnalysis | null {
  const media = primaryMedia(project);
  if (!media) return null;
  const { entries, videos } = useMediaAnalysisStore.getState();
  const entry = entries[media.id];
  const audio = entry && entry.path === media.path ? entry.audio : null;
  const vMedia = videoMedia(project);
  const vEntry = vMedia ? videos[vMedia.id] : undefined;
  const video = vMedia && vEntry?.path === vMedia.path ? vEntry.video : null;
  const doc = useAiChatStore.getState().media[media.id];
  const base = { tags: doc?.tags ?? null, prefs: doc?.prefs ?? null };
  // 视频就是主素材：一起换算
  if (vMedia?.id === media.id) return mapAnalysis({ media, clip: firstClipOf(project, media.id), audio, video, ...base });
  const main = mapAnalysis({ media, clip: firstClipOf(project, media.id), audio, ...base });
  if (!video || !vMedia) return main;
  // 音乐与画面来自不同素材：画面按视频自己的片段换算，再并进来
  const shots = mapAnalysis({ media: vMedia, clip: firstClipOf(project, vMedia.id), audio: null, video });
  if (!shots) return main;
  if (!main) return shots;
  return {
    ...main,
    events: [...main.events, ...shots.events].sort((a, b) => a.atMs - b.atMs || a.kind.localeCompare(b.kind)),
    shots: shots.shots,
  };
}

/**
 * 做画面分析的视频素材：主素材是视频时就是它，否则是时间线上最早的视频片段的素材。
 *
 * @param project 工程。
 * @returns 素材；没有视频时为 `undefined`。
 */
export function videoMedia(project: Pick<ShowProject, "media" | "mediaClips">): MediaRef | undefined {
  const primary = primaryMedia(project);
  if (primary?.kind === "video") return primary;
  const byId = new Map(project.media.map((m) => [m.id, m]));
  return [...project.mediaClips].sort((a, b) => a.startMs - b.startMs).map((c) => byId.get(c.mediaId)).find((m) => m?.kind === "video");
}

/**
 * 吸附用的音乐事件时刻（重拍、爆点、断层、切镜，加上渐强的起止）；只在显示参考线时参与。
 *
 * @param project 工程。
 * @returns 时刻（时间线毫秒）；没有分析时为空。
 */
export function analysisSnapTimes(project: Pick<ShowProject, "media" | "mediaClips">): number[] {
  const analysis = currentAnalysis(project);
  if (!analysis) return [];
  return analysis.events.flatMap((e) => (e.endMs === undefined ? [e.atMs] : [e.atMs, e.endMs]));
}

/**
 * 当前工程分析结果的 hook（工程、分析或设置变化时更新）。
 *
 * @returns 分析；没有时为 `null`。
 */
export function useTimelineAnalysis(): TimelineAnalysis | null {
  const media = useProjectStore((s) => s.project.media);
  const clips = useProjectStore((s) => s.project.mediaClips);
  const entries = useMediaAnalysisStore((s) => s.entries);
  const videos = useMediaAnalysisStore((s) => s.videos);
  const docs = useAiChatStore((s) => s.media);
  // 依赖只用来触发重算：真正的读取走 store 的当前状态
  return useMemo(() => {
    void entries;
    void videos;
    void docs;
    return currentAnalysis({ media, mediaClips: clips });
  }, [media, clips, entries, videos, docs]);
}

/**
 * 主素材已有的分析（只读缓存，不做分析；AI 对话前调用）。
 *
 * @returns 分析；没有主素材或还没分析过时为 `null`。
 */
export async function peekPrimaryAnalysis(): Promise<TimelineAnalysis | null> {
  const media = primaryMedia(useProjectStore.getState().project);
  if (!media) return null;
  await useMediaAnalysisStore.getState().peek(media);
  return currentAnalysis(useProjectStore.getState().project);
}

/**
 * 分析主素材（用户点“分析”、生成草稿或模型要用分析时调用；没有主素材时什么也不做）。
 *
 * @returns 分析结果；没有或失败时为 `null`。
 */
export async function ensurePrimaryAnalysis(): Promise<TimelineAnalysis | null> {
  const project = useProjectStore.getState().project;
  const media = primaryMedia(project);
  if (!media) return null;
  await useMediaAnalysisStore.getState().ensure(media);
  return currentAnalysis(useProjectStore.getState().project);
}
