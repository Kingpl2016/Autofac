import { create } from "zustand";

import type { ClipCue } from "../lib/cueOps";
import type { CueTag, Look } from "../lib/project";
import { DEFAULT_PX_PER_SEC } from "../lib/zoom";

/** 时间线右键菜单的目标。 */
export type ContextTarget =
  | { kind: "cue"; id: string }
  | { kind: "mediaClip"; id: string }
  | { kind: "track"; id: string }
  | { kind: "mediaTrack"; id: string }
  /** 轨道区空白处：所在轨道（在所有轨道之下时为 `null`）与时刻 */
  | { kind: "empty"; trackId: string | null; timeMs: number }
  | { kind: "ruler"; timeMs: number }
  | { kind: "marker"; id: string }
  | { kind: "section"; id: string }
  /** 标尺上的 A-B 循环区间 */
  | { kind: "loop"; timeMs: number }
  /** 时间范围选择（标尺上 Shift + 拖动选出的一段时间） */
  | { kind: "range"; timeMs: number }
  /** 片段上的关键帧 ◆：所在片段与片段内时刻 */
  | { kind: "keyframe"; cueId: string; uMs: number };

/** 时间线上可以选中的标记类对象（标记点、段落）。 */
export interface TimelineObject {
  kind: "marker" | "section";
  id: string;
}

/** 左侧图标栏的素材分区。 */
export const LIBRARY_TABS = ["fixtures", "cues", "media", "effects", "presets", "groups", "history"] as const;

/** 左侧素材分区。 */
export type LibraryTab = (typeof LIBRARY_TABS)[number];

/** 右侧属性区的标签页：灯具与 Patch、编程器（同一帧给多台灯设值）、Cue 属性。 */
export const INSPECTOR_TABS = ["patch", "program", "cue"] as const;

/** 右侧属性区的标签页。 */
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

/** 请 Patch 列表滚动到这些灯具（`seq` 每次递增，同一选择再请求也会滚动）。 */
export interface FixtureRevealRequest {
  ids: string[];
  seq: number;
}

interface EditorUiState {
  /** 在 Patch 面板里勾选的灯具 */
  selectedFixtureIds: string[];
  /** 最近一次“在 Patch 中定位”的请求 */
  revealRequest: FixtureRevealRequest | null;
  /**
   * 请 Patch 列表滚动到这些灯具（第一台）。
   *
   * @param ids 灯具 id。
   */
  revealFixtures: (ids: string[]) => void;
  /** 左侧素材库是否已收起（由面板尺寸回写） */
  libraryCollapsed: boolean;
  /** 右侧属性面板是否已收起（由面板尺寸回写） */
  inspectorCollapsed: boolean;
  /**
   * 回写面板的收起状态。
   *
   * @param panel 面板。
   * @param collapsed 是否收起。
   */
  setPanelCollapsed: (panel: "library" | "inspector" | "ai", collapsed: boolean) => void;
  /** 右侧 AI 对话栏是否已收起（默认收起；由面板尺寸回写） */
  aiCollapsed: boolean;
  /** 在 Patch 面板里选中的分组 */
  selectedGroupId: string | null;
  /** 在时间线上选中的 Cue */
  selectedCueIds: string[];
  /** 选中的轨道（点轨道头选中；模板“点击添加”会加到这条轨道）；多选时为最后点选的那条 */
  selectedTrackId: string | null;
  /** 选中的全部轨道（Ctrl / Shift 点击轨道头多选）；单选时只含 `selectedTrackId` */
  selectedTrackIds: string[];
  /**
   * 设置选中的多条轨道（第一条之外的顺序保持；`primary` 省略时取最后一条）。
   *
   * @param ids 轨道 id。
   * @param primary 主轨道。
   */
  selectTracks: (ids: string[], primary?: string | null) => void;
  /** 选中的标记点 / 段落（与片段、媒体片段的选择互斥：按 Delete 删的就是最后点选的那类） */
  selectedTimelineObject: TimelineObject | null;
  /**
   * 选中一个标记点 / 段落（同时清空片段与媒体片段的选择）；`null` 取消。
   *
   * @param obj 对象。
   */
  selectTimelineObject: (obj: TimelineObject | null) => void;
  /** 左侧“灯具”页里展开了批量添加面板的模型（同一时间只展开一个） */
  fixtureAddModelId: string | null;
  /**
   * 展开某个模型的批量添加面板；`null` 收起。
   *
   * @param id 模型编号。
   */
  setFixtureAddModel: (id: string | null) => void;
  /** 顶栏的帮助菜单是否打开（F1） */
  helpOpen: boolean;
  /**
   * 打开 / 关闭帮助菜单。
   *
   * @param open 是否打开。
   */
  setHelpOpen: (open: boolean) => void;
  /** “显示本页提示”：本次会话内把当前页面上的全部局部提示一起显示（包括已关掉的） */
  hintsShowAll: boolean;
  /**
   * 开 / 关“显示本页提示”。
   *
   * @param on 是否显示。
   */
  setHintsShowAll: (on: boolean) => void;
  /** 正在改名的标记点 / 段落（双击、F2 或右键菜单的“重命名”） */
  renamingObjectId: string | null;
  /**
   * 进入 / 退出改名。
   *
   * @param id 标记点或段落 id；`null` 退出。
   */
  setRenamingObject: (id: string | null) => void;
  /** 右键菜单的目标（打开菜单时由事件位置决定） */
  contextTarget: ContextTarget | null;
  /**
   * 设置右键菜单的目标。
   *
   * @param target 目标；`null` 清除。
   */
  setContextTarget: (target: ContextTarget | null) => void;
  /** 播放头位置（毫秒）；播放引擎接入后由后端状态驱动 */
  playheadMs: number;
  /** 时间范围选择（在标尺上 Shift + 拖动）：跨轨道剪切 / 复制 / 删除 / 插入空白用；与 A-B 循环区无关 */
  timeRange: { startMs: number; endMs: number } | null;
  /**
   * 设置时间范围选择。
   *
   * @param range 范围（起止自动排序，长度为 0 时清除）；`null` 清除。
   */
  setTimeRange: (range: { startMs: number; endMs: number } | null) => void;
  /** “复制 N 份”对话框是否打开 */
  repeatOpen: boolean;
  /**
   * 打开 / 关闭“复制 N 份”对话框。
   *
   * @param open 是否打开。
   */
  setRepeatOpen: (open: boolean) => void;
  /** 时间线按颜色标签筛选：其它片段变暗；`null` 为不筛选 */
  tagFilter: CueTag | null;
  /**
   * 设置颜色标签筛选。
   *
   * @param tag 标签；`null` 不筛选。
   */
  setTagFilter: (tag: CueTag | null) => void;
  /** 指针最后停在时间线上的时刻（“粘贴到鼠标位置”用）；不在时间线上时为 `null` */
  pointerTimeMs: number | null;
  /**
   * 记录指针所在的时刻。
   *
   * @param ms 时刻；离开时间线时为 `null`。
   */
  setPointerTime: (ms: number | null) => void;
  /** 剪贴板里复制的 Cue */
  clipboard: ClipCue[];
  /** 右侧属性区当前的标签页 */
  inspectorTab: InspectorTab;
  /** 时间线缩放：每秒像素数 */
  pxPerSec: number;
  /** 是否吸附（网格 / 其他 Cue 边缘 / 标记点 / 播放头 / 节拍） */
  snapEnabled: boolean;
  /** 绘制模式：在轨道空白处拖动直接画出片段（关闭时空白处拖动为框选） */
  drawMode: boolean;
  /** 音视频素材是否静音（只影响本机监听，不进工程） */
  mediaMuted: boolean;
  /** 命令面板（Ctrl+K）是否打开 */
  paletteOpen: boolean;
  /** 左侧图标栏选中的素材分区 */
  libraryTab: LibraryTab;
  /** 输出黑场：推给后端的工程全部轨道静音（编程器也不输出），预览同样全黑 */
  blackout: boolean;
  /**
   * 开关输出黑场。
   *
   * @param on 是否黑场。
   */
  setBlackout: (on: boolean) => void;
  /** 径向轮盘打开的位置（屏幕坐标）；`null` 为关闭 */
  radial: { x: number; y: number } | null;
  /**
   * 打开 / 关闭径向轮盘。
   *
   * @param at 屏幕坐标；`null` 关闭。
   */
  setRadial: (at: { x: number; y: number } | null) => void;
  /** 复制的外观层（选择性粘贴到别的外观片段） */
  lookClipboard: Look | null;
  /**
   * 设置外观层剪贴板。
   *
   * @param look 外观；`null` 清空。
   */
  setLookClipboard: (look: Look | null) => void;
  /**
   * 打开 / 关闭命令面板。
   *
   * @param open 是否打开。
   */
  setPaletteOpen: (open: boolean) => void;
  /**
   * 切换左侧素材分区。
   *
   * @param tab 分区。
   */
  setLibraryTab: (tab: LibraryTab) => void;
  /**
   * 勾选 / 取消勾选一个灯具。
   *
   * @param id 灯具 id。
   * @param on `true` 勾选，`false` 取消。
   */
  setFixtureSelected: (id: string, on: boolean) => void;
  /** 指针悬停的灯具（Universe 视图、通道条与舞台监视器互相高亮） */
  hoverFixtureId: string | null;
  /**
   * 设置悬停的灯具。
   *
   * @param id 灯具；`null` 清除。
   */
  setHoverFixture: (id: string | null) => void;
  /** Universe 视图：按灯具色块的卡片，或 512 格通道条 */
  universeView: "cards" | "strip";
  /**
   * 切换 Universe 视图。
   *
   * @param view 视图。
   */
  setUniverseView: (view: "cards" | "strip") => void;
  /**
   * 整体替换勾选的灯具。
   *
   * @param ids 灯具 id 列表。
   */
  setSelectedFixtures: (ids: string[]) => void;
  /**
   * 选中一个分组（`null` 取消）。
   *
   * @param id 分组 id。
   */
  selectGroup: (id: string | null) => void;
  /**
   * 整体替换选中的 Cue。
   *
   * @param ids Cue id 列表。
   */
  selectCues: (ids: string[]) => void;
  /**
   * 切换一个 Cue 的选中状态（Ctrl / Shift 点击用）。
   *
   * @param id Cue id。
   */
  toggleCue: (id: string) => void;
  /**
   * 选中一条轨道（`null` 取消）。
   *
   * @param id 轨道 id。
   */
  selectTrack: (id: string | null) => void;
  /**
   * 设置播放头位置。
   *
   * @param ms 毫秒，负数按 0 处理。
   */
  setPlayhead: (ms: number) => void;
  /**
   * 设置剪贴板内容。
   *
   * @param clip 复制得到的 Cue 列表。
   */
  setClipboard: (clip: ClipCue[]) => void;
  /**
   * 切换右侧属性区的标签页。
   *
   * @param tab 标签页。
   */
  setInspectorTab: (tab: InspectorTab) => void;
  /**
   * 设置时间线缩放。
   *
   * @param px 每秒像素数。
   */
  setPxPerSec: (px: number) => void;
  /** 切换吸附开关。 */
  toggleSnap: () => void;
  /** 切换绘制模式。 */
  toggleDrawMode: () => void;
  /** 切换素材静音。 */
  toggleMuted: () => void;
  /** 清空全部选择（不影响播放头和剪贴板）。 */
  clearSelection: () => void;
  /** 快捷键设置对话框是否打开 */
  keymapOpen: boolean;
  /**
   * 打开 / 关闭快捷键设置。
   *
   * @param open 是否打开。
   */
  setKeymapOpen: (open: boolean) => void;
  /** 快捷键速查表是否打开（帮助菜单） */
  shortcutSheetOpen: boolean;
  /**
   * 打开 / 关闭快捷键速查表。
   *
   * @param open 是否打开。
   */
  setShortcutSheetOpen: (open: boolean) => void;
  /** 等待确认的节目时长（缩短会裁掉内容时）；`null` 为没有 */
  durationRequest: number | null;
  /**
   * 设置 / 清除等待确认的节目时长。
   *
   * @param ms 新时长；`null` 清除。
   */
  setDurationRequest: (ms: number | null) => void;
  /** 一键草稿对话框是否打开 */
  draftOpen: boolean;
  /**
   * 打开 / 关闭一键草稿对话框。
   *
   * @param open 是否打开。
   */
  setDraftOpen: (open: boolean) => void;
  /** 在媒体轨道上选中的片段（与 Cue 选择互斥：选中一方会清空另一方） */
  selectedMediaClipIds: string[];
  /**
   * 选中一组媒体片段（同时清空 Cue 选择）。
   *
   * @param ids 片段 id。
   */
  selectMediaClips: (ids: string[]) => void;
}

/**
 * 编辑器界面状态（选择、播放头、剪贴板等）。不进入撤销历史，也不随工程保存。
 *
 * 选中的 id 可能指向已被删除的对象，使用方需要对照工程过滤。
 */
export const useEditorUiStore = create<EditorUiState>((set) => ({
  selectedFixtureIds: [],
  selectedGroupId: null,
  selectedCueIds: [],
  selectedTrackId: null,
  playheadMs: 0,
  clipboard: [],
  inspectorTab: "patch",
  pxPerSec: DEFAULT_PX_PER_SEC,
  snapEnabled: true,
  drawMode: false,
  mediaMuted: false,
  paletteOpen: false,
  // 默认打开图标栏最上面的分区
  libraryTab: LIBRARY_TABS[0],
  lookClipboard: null,
  setLookClipboard: (look) => set({ lookClipboard: look }),
  radial: null,
  setRadial: (at) => set({ radial: at }),
  blackout: false,
  setBlackout: (on) => set({ blackout: on }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setLibraryTab: (tab) => set({ libraryTab: tab }),
  hoverFixtureId: null,
  setHoverFixture: (id) => set((s) => (s.hoverFixtureId === id ? s : { hoverFixtureId: id })),
  universeView: "cards",
  setUniverseView: (universeView) => set({ universeView }),
  setFixtureSelected: (id, on) =>
    set((s) => ({
      selectedFixtureIds: on
        ? s.selectedFixtureIds.includes(id)
          ? s.selectedFixtureIds
          : [...s.selectedFixtureIds, id]
        : s.selectedFixtureIds.filter((x) => x !== id),
    })),
  setSelectedFixtures: (ids) => set({ selectedFixtureIds: ids }),
  revealRequest: null,
  revealFixtures: (ids) => set((s) => ({ revealRequest: { ids: [...ids], seq: (s.revealRequest?.seq ?? 0) + 1 } })),
  libraryCollapsed: false,
  inspectorCollapsed: false,
  aiCollapsed: true,
  setPanelCollapsed: (panel, collapsed) =>
    set((s) => {
      const key = panel === "library" ? "libraryCollapsed" : panel === "inspector" ? "inspectorCollapsed" : "aiCollapsed";
      return s[key] === collapsed ? s : { [key]: collapsed };
    }),
  selectGroup: (id) => set({ selectedGroupId: id }),
  selectCues: (ids) =>
    set(ids.length > 0 ? { selectedCueIds: ids, selectedMediaClipIds: [], selectedTimelineObject: null } : { selectedCueIds: ids }),
  renamingObjectId: null,
  setRenamingObject: (renamingObjectId) => set({ renamingObjectId }),
  fixtureAddModelId: null,
  setFixtureAddModel: (fixtureAddModelId) => set({ fixtureAddModelId }),
  helpOpen: false,
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  hintsShowAll: false,
  setHintsShowAll: (hintsShowAll) => set({ hintsShowAll }),
  selectedTimelineObject: null,
  selectTimelineObject: (obj) =>
    set(obj ? { selectedTimelineObject: obj, selectedCueIds: [], selectedMediaClipIds: [] } : { selectedTimelineObject: null }),
  keymapOpen: false,
  setKeymapOpen: (keymapOpen) => set({ keymapOpen }),
  shortcutSheetOpen: false,
  setShortcutSheetOpen: (shortcutSheetOpen) => set({ shortcutSheetOpen }),
  durationRequest: null,
  setDurationRequest: (durationRequest) => set({ durationRequest }),
  draftOpen: false,
  setDraftOpen: (draftOpen) => set({ draftOpen }),
  selectedMediaClipIds: [],
  selectMediaClips: (ids) =>
    set(ids.length > 0 ? { selectedMediaClipIds: ids, selectedCueIds: [], selectedTimelineObject: null } : { selectedMediaClipIds: ids }),
  toggleCue: (id) =>
    set((s) => ({
      selectedCueIds: s.selectedCueIds.includes(id)
        ? s.selectedCueIds.filter((x) => x !== id)
        : [...s.selectedCueIds, id],
      selectedTimelineObject: null,
    })),
  selectTrack: (id) => set({ selectedTrackId: id, selectedTrackIds: id ? [id] : [] }),
  selectedTrackIds: [],
  selectTracks: (ids, primary) => {
    const unique = [...new Set(ids)];
    set({ selectedTrackIds: unique, selectedTrackId: primary !== undefined ? primary : (unique.at(-1) ?? null) });
  },
  contextTarget: null,
  setContextTarget: (contextTarget) => set({ contextTarget }),
  setPlayhead: (ms) => set({ playheadMs: Math.max(0, Math.round(ms)) }),
  timeRange: null,
  setTimeRange: (range) => {
    if (!range) return set({ timeRange: null });
    const startMs = Math.max(0, Math.round(Math.min(range.startMs, range.endMs)));
    const endMs = Math.max(0, Math.round(Math.max(range.startMs, range.endMs)));
    set({ timeRange: endMs > startMs ? { startMs, endMs } : null });
  },
  repeatOpen: false,
  setRepeatOpen: (repeatOpen) => set({ repeatOpen }),
  tagFilter: null,
  setTagFilter: (tagFilter) => set({ tagFilter }),
  pointerTimeMs: null,
  setPointerTime: (ms) => set({ pointerTimeMs: ms === null ? null : Math.max(0, Math.round(ms)) }),
  setClipboard: (clip) => set({ clipboard: clip }),
  setInspectorTab: (tab) => set({ inspectorTab: tab }),
  setPxPerSec: (px) => set({ pxPerSec: px }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  toggleDrawMode: () => set((s) => ({ drawMode: !s.drawMode })),
  toggleMuted: () => set((s) => ({ mediaMuted: !s.mediaMuted })),
  clearSelection: () =>
    set({
      selectedFixtureIds: [],
      selectedGroupId: null,
      selectedCueIds: [],
      selectedTrackId: null,
      selectedTrackIds: [],
      selectedMediaClipIds: [],
      selectedTimelineObject: null,
      timeRange: null,
    }),
}));
