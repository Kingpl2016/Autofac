import { create } from "zustand";
import { temporal } from "zundo";

import {
  fullSegments,
  removeSegment,
  setInPoint,
  setOutPoint,
  splitAt,
  trimSegment,
  type Segment,
} from "../lib/segments";

/** 撤销历史的最大步数。 */
const HISTORY_LIMIT = 100;

interface EditDraftState {
  /** 正在编辑的节目路径 */
  path: string;
  /** 源节目总时长（微秒） */
  durationUs: number;
  /** 源节目的全部 Universe（源文件顺序） */
  allUniverses: readonly number[];
  /** 保留的片段（按时间排序、互不重叠） */
  segments: readonly Segment[];
  /** 保留的 Universe */
  universes: readonly number[];
  /** 选中的片段 */
  selectedId: string | null;
  /** 播放头（源时间，微秒；不进撤销历史） */
  playheadUs: number;
  /** 草稿相对初始状态是否有改动 */
  dirty: boolean;

  /** 开始编辑另一个节目：整段保留、全部 Universe，清空撤销历史。 */
  reset: (path: string, durationUs: number, universes: readonly number[]) => void;
  /** 在播放头处切割（切开后选中右半段）。 */
  splitAtPlayhead: () => void;
  /** 删除选中的片段。 */
  removeSelected: () => void;
  /** 修剪片段的一端。 */
  trim: (id: string, edge: "start" | "end", tUs: number) => void;
  /** 设入点 / 出点为播放头。 */
  setIn: () => void;
  setOut: () => void;
  /** 恢复为整段。 */
  restoreAll: () => void;
  /** 导出成功后：当前草稿已保存过，离开页面不再提示（之后再修改会重新标记）。 */
  markExported: () => void;
  select: (id: string | null) => void;
  setPlayhead: (us: number) => void;
  toggleUniverse: (universe: number) => void;
  setUniverses: (universes: readonly number[]) => void;
}

/** 拖动手势开始时的片段快照（整个手势只记一步撤销）。 */
let gestureStart: readonly Segment[] | null = null;

/** 开始一次拖动修剪：暂停撤销记录，记下起点。 */
export function beginTrimGesture(): void {
  gestureStart = useEditDraftStore.getState().segments;
  useEditDraftStore.temporal.getState().pause();
}

/** 结束拖动修剪：把整个手势折算成一步撤销（有变化时）。 */
export function endTrimGesture(): void {
  const start = gestureStart;
  gestureStart = null;
  const temporal = useEditDraftStore.temporal.getState();
  const final = useEditDraftStore.getState().segments;
  if (!start || start === final) {
    temporal.resume();
    return;
  }
  // 暂停期间先退回起点，恢复记录后再写入终点：历史里只多出“起点”这一步
  useEditDraftStore.setState({ segments: start });
  temporal.resume();
  useEditDraftStore.setState({ segments: final });
}

const sameList = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 编辑导出页的草稿：保留片段、保留的 Universe、选中片段与播放头。
 *
 * 片段与 Universe 的修改可撤销 / 重做（zundo，经 `useEditDraftStore.temporal` 访问）；
 * 选中与播放头不进历史。模块级 store：同一时间只编辑一个节目，切换页面再回来草稿还在。
 */
export const useEditDraftStore = create<EditDraftState>()(
  temporal(
    (set, get) => {
      /** 修改片段并更新改动标记。 */
      const setSegments = (segments: readonly Segment[], selectedId = get().selectedId) => {
        const s = get();
        if (segments === s.segments) return;
        const pristine =
          segments.length === 1 && segments[0].startUs === 0 && segments[0].endUs === s.durationUs;
        set({
          segments,
          selectedId,
          dirty: !pristine || !sameList(s.universes, s.allUniverses),
        });
      };
      return {
        path: "",
        durationUs: 0,
        allUniverses: [],
        segments: [],
        universes: [],
        selectedId: null,
        playheadUs: 0,
        dirty: false,

        reset: (path, durationUs, universes) => {
          const segments = fullSegments(durationUs);
          set({
            path,
            durationUs,
            allUniverses: universes,
            universes,
            segments,
            selectedId: segments[0]?.id ?? null,
            playheadUs: 0,
            dirty: false,
          });
          useEditDraftStore.temporal.getState().clear();
        },
        splitAtPlayhead: () => {
          const { segments, rightId } = splitAt(get().segments, get().playheadUs);
          if (rightId) setSegments(segments, rightId);
        },
        removeSelected: () => {
          const { selectedId, segments } = get();
          if (!selectedId || segments.length <= 1) return;
          const i = segments.findIndex((s) => s.id === selectedId);
          const next = removeSegment(segments, selectedId);
          setSegments(next, next[Math.min(i, next.length - 1)]?.id ?? null);
        },
        trim: (id, edge, tUs) => setSegments(trimSegment(get().segments, id, edge, tUs, get().durationUs)),
        setIn: () => setSegments(setInPoint(get().segments, get().playheadUs)),
        setOut: () => setSegments(setOutPoint(get().segments, get().playheadUs)),
        restoreAll: () => {
          const segments = fullSegments(get().durationUs);
          setSegments(segments, segments[0]?.id ?? null);
        },
        markExported: () => set({ dirty: false }),
        select: (id) => set({ selectedId: id }),
        setPlayhead: (us) => set({ playheadUs: Math.min(Math.max(0, Math.round(us)), get().durationUs) }),
        toggleUniverse: (universe) => {
          const { universes, allUniverses } = get();
          const next = universes.includes(universe)
            ? universes.filter((u) => u !== universe)
            : allUniverses.filter((u) => u === universe || universes.includes(u));
          get().setUniverses(next);
        },
        setUniverses: (next) => {
          const s = get();
          const ordered = s.allUniverses.filter((u) => next.includes(u));
          if (sameList(ordered, s.universes)) return;
          const pristineSegs =
            s.segments.length === 1 && s.segments[0].startUs === 0 && s.segments[0].endUs === s.durationUs;
          set({ universes: ordered, dirty: !pristineSegs || !sameList(ordered, s.allUniverses) });
        },
      };
    },
    {
      limit: HISTORY_LIMIT,
      partialize: (state) => ({ segments: state.segments, universes: state.universes, dirty: state.dirty }),
      equality: (past, current) => past.segments === current.segments && past.universes === current.universes,
    },
  ),
);
