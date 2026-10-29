import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createTauriPersistStorage } from "@/shared/tauri/tauriStorage";
import { DEFAULT_RECORD_PREFS, sanitizeRecordPrefs, type RecordPrefs } from "../lib/programmer";
import { SWATCH_LABELS, type SwatchLabel, type SwatchSort } from "../lib/swatchGroups";

/** 中间区域的视图：色块预览、舞台监视器、灯具表（色块为默认）。 */
export const CENTER_VIEWS = ["swatches", "stage", "sheet"] as const;

/** 中间区域的视图。 */
export type CenterView = (typeof CENTER_VIEWS)[number];

/** 色块视图的分区方式：按 Universe、按灯具分组、按型号。 */
export const SWATCH_GROUP_BY = ["universe", "group", "model"] as const;

/** 色块视图的分区方式。 */
export type SwatchGroupBy = (typeof SWATCH_GROUP_BY)[number];

/** 色块大小：大（像素分段看得清）、舒适（显示名称与地址）或紧凑（小块，灯多时一屏看全）。 */
export const SWATCH_DENSITIES = ["large", "comfortable", "compact"] as const;

/** 色块大小。 */
export type SwatchDensity = (typeof SWATCH_DENSITIES)[number];

/** 时间线左侧轨道名称列的宽度范围（像素）。 */
export const TRACK_HEADER_WIDTH = { min: 160, max: 480, default: 208 } as const;

/**
 * 把宽度夹在允许范围内并取整。
 *
 * @param px 宽度（像素）。
 * @returns 合法宽度；非数字时为默认宽度。
 */
export function clampHeaderWidth(px: number): number {
  if (!Number.isFinite(px)) return TRACK_HEADER_WIDTH.default;
  return Math.round(Math.min(TRACK_HEADER_WIDTH.max, Math.max(TRACK_HEADER_WIDTH.min, px)));
}

/** 吸附目标的种类：节拍、标记点、片段边缘（灯光与媒体）、播放头。工程起止始终可吸附。 */
export const SNAP_KINDS = ["beats", "markers", "edges", "playhead"] as const;

/** 吸附目标的种类。 */
export type SnapKind = (typeof SNAP_KINDS)[number];

/** 每种吸附目标是否开启。 */
export type SnapKinds = Record<SnapKind, boolean>;

/** 标尺的刻度：时间码，或小节·拍（需要节拍设置）。 */
export const RULER_FORMATS = ["timecode", "bars"] as const;

/** 标尺的刻度。 */
export type RulerFormat = (typeof RULER_FORMATS)[number];

/** 批量添加灯具面板上次用的设置（模式、名称与具体模型相关，不记）。 */
export interface FixtureAddPrefs {
  /** 数量 */
  count: number;
  /** 相邻灯具之间空出的通道数 */
  gap: number;
  /** 自动找空位；`false` 时从 `universe` / `address` 起 */
  autoStart: boolean;
  universe: number;
  address: number;
  /** 添加后编为一组 */
  group: boolean;
}

/** 批量添加的默认设置。 */
export const DEFAULT_FIXTURE_ADD: FixtureAddPrefs = { count: 4, gap: 0, autoStart: true, universe: 0, address: 1, group: false };

/** 落盘的数据。 */
export interface EditorPrefsData {
  centerView: CenterView;
  swatchGroupBy: SwatchGroupBy;
  swatchDensity: SwatchDensity;
  /** 色块下方的标签内容 */
  swatchLabel: SwatchLabel;
  /** 色块区内排序 */
  swatchSort: SwatchSort;
  /** 折叠的色块分区（分区键，例如 `u:0`） */
  swatchCollapsed: string[];
  /** 时间线左侧轨道名称列的宽度（像素） */
  trackHeaderWidth: number;
  /** 批量添加灯具的上次设置 */
  fixtureAdd: FixtureAddPrefs;
  /** 输出设置的“高级”分区是否展开（默认收起） */
  outputAdvancedOpen: boolean;
  /** 播放时时间线跟随播放头翻页 */
  followPlayhead: boolean;
  /** 吸附到哪些目标 */
  snapKinds: SnapKinds;
  /** 波纹编辑：删除片段时，同轨道后面的片段前移补齐 */
  rippleEdit: boolean;
  /** 标尺刻度 */
  rulerFormat: RulerFormat;
  /** “灯具与 Patch”详情区各分区的展开状态（没记过的分区按各自的默认值） */
  patchSections: SectionStates<"patch">;
  /** 编程器页各分区的展开状态 */
  programSections: SectionStates<"program">;
  /** 编程器的记录设置（长度、单位、淡入） */
  programmerRecord: RecordPrefs;
  /** Cue 属性页各分区的展开状态（同名分区在各片段类型之间共用） */
  cueSections: SectionStates<"cue">;
}

/** 右侧属性面板三页的可折叠分区（白名单：读回时只保留这些）。 */
export const INSPECTOR_SECTIONS = {
  patch: ["basic", "dmx", "placement", "sync", "groupsOf", "universes", "channels", "groups"],
  program: ["select", "intensity", "color", "attrs", "fan", "record"],
  cue: ["color", "effect", "effectColors", "intensity", "layers", "spread", "clipboard", "scene", "fades", "time"],
} as const;

/** 分区所在的页。 */
export type SectionScope = keyof typeof INSPECTOR_SECTIONS;

/** 某一页的分区。 */
export type SectionId<S extends SectionScope> = (typeof INSPECTOR_SECTIONS)[S][number];

/** 某一页各分区是否展开。 */
export type SectionStates<S extends SectionScope> = Partial<Record<SectionId<S>, boolean>>;

/** 每页分区状态在偏好里的字段。 */
const SECTION_FIELDS = { patch: "patchSections", program: "programSections", cue: "cueSections" } as const;

interface EditorPrefsState extends EditorPrefsData {
  /**
   * 展开 / 收起属性面板某一页的一个分区。
   *
   * @param scope 页。
   * @param section 分区。
   * @param open 是否展开。
   */
  setSection: <S extends SectionScope>(scope: S, section: SectionId<S>, open: boolean) => void;
  /**
   * 切换中间区域的视图（记住选择）。
   *
   * @param view 视图。
   */
  setCenterView: (view: CenterView) => void;
  /**
   * 切换色块的分区方式。
   *
   * @param by 分区方式。
   */
  setSwatchGroupBy: (by: SwatchGroupBy) => void;
  /**
   * 切换色块大小。
   *
   * @param density 大小。
   */
  setSwatchDensity: (density: SwatchDensity) => void;
  /**
   * 色块标签内容。
   *
   * @param label 标签方式。
   */
  setSwatchLabel: (label: SwatchLabel) => void;
  /**
   * 色块区内排序。
   *
   * @param sort 排序方式。
   */
  setSwatchSort: (sort: SwatchSort) => void;
  /**
   * 设置折叠的色块分区。
   *
   * @param keys 分区键。
   */
  setSwatchCollapsed: (keys: readonly string[]) => void;
  /**
   * 设置轨道名称列的宽度（会夹在允许范围内）。
   *
   * @param px 宽度（像素）。
   */
  setTrackHeaderWidth: (px: number) => void;
  /**
   * 记住批量添加的设置（会逐字段规整）。
   *
   * @param patch 要改的字段。
   */
  setFixtureAdd: (patch: Partial<FixtureAddPrefs>) => void;
  /**
   * 展开 / 收起输出设置的“高级”分区。
   *
   * @param open 是否展开。
   */
  setOutputAdvancedOpen: (open: boolean) => void;
  /**
   * 开关跟随播放头。
   *
   * @param on 是否跟随。
   */
  setFollowPlayhead: (on: boolean) => void;
  /**
   * 开关某种吸附目标。
   *
   * @param kind 种类。
   * @param on 是否吸附。
   */
  setSnapKind: (kind: SnapKind, on: boolean) => void;
  /**
   * 开关波纹编辑。
   *
   * @param on 是否开启。
   */
  setRippleEdit: (on: boolean) => void;
  /**
   * 切换标尺刻度。
   *
   * @param format 刻度。
   */
  setRulerFormat: (format: RulerFormat) => void;
  /**
   * 修改编程器的记录设置（与当前值合并后规整）。
   *
   * @param patch 要改的字段。
   */
  setProgrammerRecord: (patch: Partial<RecordPrefs>) => void;
}

/**
 * 规整批量添加的设置：数量 1~128、间隔 0~64、Universe 0~2047、地址 1~512，非法值取 `fallback`。
 *
 * @param raw 未知数据。
 * @param fallback 兜底值。
 * @returns 合法设置。
 */
export function sanitizeFixtureAdd(raw: unknown, fallback: FixtureAddPrefs): FixtureAddPrefs {
  const r = (raw ?? {}) as Partial<Record<keyof FixtureAddPrefs, unknown>>;
  const int = (v: unknown, min: number, max: number, fb: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fb;
  return {
    count: int(r.count, 1, 128, fallback.count),
    gap: int(r.gap, 0, 64, fallback.gap),
    autoStart: typeof r.autoStart === "boolean" ? r.autoStart : fallback.autoStart,
    universe: int(r.universe, 0, 2047, fallback.universe),
    address: int(r.address, 1, 512, fallback.address),
    group: typeof r.group === "boolean" ? r.group : fallback.group,
  };
}

/** 默认值：预览先显示色块，按 Universe 分区。 */
export const DEFAULT_EDITOR_PREFS: EditorPrefsData = {
  centerView: "swatches",
  swatchGroupBy: "universe",
  swatchDensity: "comfortable",
  swatchLabel: "name",
  swatchSort: "address",
  swatchCollapsed: [],
  trackHeaderWidth: TRACK_HEADER_WIDTH.default,
  fixtureAdd: DEFAULT_FIXTURE_ADD,
  outputAdvancedOpen: false,
  followPlayhead: true,
  snapKinds: { beats: true, markers: true, edges: true, playhead: true },
  rippleEdit: false,
  rulerFormat: "timecode",
  patchSections: {},
  programSections: {},
  cueSections: {},
  programmerRecord: DEFAULT_RECORD_PREFS,
};

/**
 * 规整某一页的分区展开状态：只保留认识的分区、布尔值。
 *
 * @param scope 页。
 * @param raw 未知数据。
 * @param fallback 兜底值（不是对象时用）。
 * @returns 合法的展开状态。
 */
export function sanitizeSections<S extends SectionScope>(scope: S, raw: unknown, fallback: SectionStates<S>): SectionStates<S> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const r = raw as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const k of INSPECTOR_SECTIONS[scope] as readonly string[]) {
    const v = r[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out as SectionStates<S>;
}

/**
 * 校验从磁盘读回的偏好：每个字段单独兜底，非法值保持当前值。
 *
 * @param raw 磁盘上读到的未知数据。
 * @param current 当前值。
 * @returns 一定合法的偏好。
 */
export function sanitizeEditorPrefs(raw: unknown, current: EditorPrefsData): EditorPrefsData {
  const r = (raw ?? {}) as Partial<Record<keyof EditorPrefsData, unknown>>;
  const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
    list.includes(v as T) ? (v as T) : fallback;
  return {
    centerView: pick(CENTER_VIEWS, r.centerView, current.centerView),
    swatchGroupBy: pick(SWATCH_GROUP_BY, r.swatchGroupBy, current.swatchGroupBy),
    swatchDensity: pick(SWATCH_DENSITIES, r.swatchDensity, current.swatchDensity),
    swatchLabel: pick(SWATCH_LABELS, r.swatchLabel, current.swatchLabel),
    swatchSort: pick(["address", "stage"] as const, r.swatchSort, current.swatchSort),
    swatchCollapsed: Array.isArray(r.swatchCollapsed)
      ? [...new Set(r.swatchCollapsed.filter((k): k is string => typeof k === "string" && k.length <= 128))].slice(0, 512)
      : current.swatchCollapsed,
    trackHeaderWidth: typeof r.trackHeaderWidth === "number" ? clampHeaderWidth(r.trackHeaderWidth) : current.trackHeaderWidth,
    fixtureAdd: sanitizeFixtureAdd(r.fixtureAdd, current.fixtureAdd),
    outputAdvancedOpen: typeof r.outputAdvancedOpen === "boolean" ? r.outputAdvancedOpen : current.outputAdvancedOpen,
    followPlayhead: typeof r.followPlayhead === "boolean" ? r.followPlayhead : current.followPlayhead,
    snapKinds: Object.fromEntries(
      SNAP_KINDS.map((k) => {
        const v = (r.snapKinds as Partial<SnapKinds> | undefined)?.[k];
        return [k, typeof v === "boolean" ? v : current.snapKinds[k]];
      }),
    ) as SnapKinds,
    rippleEdit: typeof r.rippleEdit === "boolean" ? r.rippleEdit : current.rippleEdit,
    rulerFormat: pick(RULER_FORMATS, r.rulerFormat, current.rulerFormat),
    patchSections: sanitizeSections("patch", r.patchSections, current.patchSections),
    programSections: sanitizeSections("program", r.programSections, current.programSections),
    cueSections: sanitizeSections("cue", r.cueSections, current.cueSections),
    programmerRecord: sanitizeRecordPrefs(r.programmerRecord, current.programmerRecord),
  };
}

/**
 * 编辑器的视图偏好（中间视图、色块分区与大小、轨道名称列宽度），落盘到界面偏好文件（键 `editor-prefs`）。
 */
export const useEditorPrefsStore = create<EditorPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_EDITOR_PREFS,
      setCenterView: (centerView) => set({ centerView }),
      setSwatchGroupBy: (swatchGroupBy) => set({ swatchGroupBy }),
      setSwatchDensity: (swatchDensity) => set({ swatchDensity }),
      setSwatchLabel: (swatchLabel) => set({ swatchLabel }),
      setSwatchSort: (swatchSort) => set({ swatchSort }),
      setSwatchCollapsed: (keys) => set({ swatchCollapsed: [...new Set(keys)] }),
      setTrackHeaderWidth: (px) => set({ trackHeaderWidth: clampHeaderWidth(px) }),
      setFixtureAdd: (patch) => set((s) => ({ fixtureAdd: sanitizeFixtureAdd({ ...s.fixtureAdd, ...patch }, s.fixtureAdd) })),
      setOutputAdvancedOpen: (outputAdvancedOpen) => set({ outputAdvancedOpen }),
      setFollowPlayhead: (followPlayhead) => set({ followPlayhead }),
      setSnapKind: (kind, on) => set((st) => ({ snapKinds: { ...st.snapKinds, [kind]: on } })),
      setRippleEdit: (rippleEdit) => set({ rippleEdit }),
      setRulerFormat: (rulerFormat) => set({ rulerFormat }),
      setProgrammerRecord: (patch) =>
        set((s) => ({ programmerRecord: sanitizeRecordPrefs({ ...s.programmerRecord, ...patch }, s.programmerRecord) })),
      setSection: (scope, section, open) =>
        set((st) => {
          const field = SECTION_FIELDS[scope];
          return { [field]: { ...st[field], [section]: open } } as Partial<EditorPrefsData>;
        }),
    }),
    {
      name: "editor-prefs",
      version: 1,
      storage: createTauriPersistStorage<EditorPrefsData>(),
      partialize: ({
        centerView,
        swatchGroupBy,
        swatchDensity,
        swatchLabel,
        swatchSort,
        swatchCollapsed,
        trackHeaderWidth,
        fixtureAdd,
        outputAdvancedOpen,
        followPlayhead,
        snapKinds,
        rippleEdit,
        rulerFormat,
        patchSections,
        programSections,
        cueSections,
        programmerRecord,
      }) => ({
        centerView,
        swatchGroupBy,
        swatchDensity,
        swatchLabel,
        swatchSort,
        swatchCollapsed,
        trackHeaderWidth,
        fixtureAdd,
        outputAdvancedOpen,
        followPlayhead,
        snapKinds,
        rippleEdit,
        rulerFormat,
        patchSections,
        programSections,
        cueSections,
        programmerRecord,
      }),
      merge: (persisted, current) => (persisted == null ? current : { ...current, ...sanitizeEditorPrefs(persisted, current) }),
    },
  ),
);
