import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { temporal } from "zundo";

import { createEmptyProject, type ShowProject } from "../lib/project";
import { useProgrammerStore } from "./useProgrammerStore";

/** 撤销历史的最大步数。 */
export const HISTORY_LIMIT = 200;

interface ProjectState {
  /** 当前正在编辑的工程 */
  project: ShowProject;
  /** 最近一次保存 / 新建 / 打开时的工程快照，用来判断是否有未保存修改 */
  baseline: ShowProject;
  /** 换了一个工程（新建 / 打开 / 从自动存档恢复）就加一：跟随工程的状态（AI 对话记录）据此切换；保存不变 */
  generation: number;
  /**
   * 以 immer 草稿的方式修改工程；每次调用产生一个新的不可变快照，可撤销。
   *
   * @param recipe 直接修改草稿的函数（见 `lib/ops.ts`）。
   */
  update: (recipe: (draft: ShowProject) => void) => void;
  /**
   * 载入另一个工程（新建 / 打开）：清空撤销历史，并把它作为“已保存”的基线。
   *
   * @param project 要载入的工程。
   */
  load: (project: ShowProject) => void;
  /**
   * 载入从自动存档恢复的工程：它相对磁盘上的版本有未保存的修改，所以保持“未保存”状态。
   *
   * @param project 恢复出的工程。
   */
  restore: (project: ShowProject) => void;
  /**
   * 把工程标记为已保存。
   *
   * @param saved 实际写入磁盘的那个快照；省略时取当前工程。保存期间用户又做了编辑时，
   *   传入保存时的快照可以让工程继续保持“未保存”。
   */
  markSaved: (saved?: ShowProject) => void;
}

const initial = createEmptyProject("");

/**
 * 节目工程的唯一数据源。
 *
 * 状态保存在模块级 store 里，切换到别的页面再回来不会丢失正在编辑的内容。
 * 撤销 / 重做由 zundo 提供（只记录 `project`），通过 `useProjectStore.temporal` 访问。
 * 判断是否有未保存修改：`project !== baseline`（撤销回基线时自然恢复为“干净”）。
 */
export const useProjectStore = create<ProjectState>()(
  temporal(
    immer((set) => ({
      project: initial,
      baseline: initial,
      generation: 0,
      update: (recipe) =>
        set((state) => {
          recipe(state.project);
        }),
      load: (project) => {
        set((state) => {
          state.project = project;
          state.baseline = project;
          state.generation += 1;
        });
        useProjectStore.temporal.getState().clear();
        // 编程器里的值属于上一个工程的灯具，换工程时清空
        useProgrammerStore.getState().reset();
      },
      restore: (project) => {
        set((state) => {
          state.project = project;
          // 基线用一个全新的空工程：与恢复出的工程不是同一个对象，因此判定为有未保存修改
          state.baseline = createEmptyProject("");
          state.generation += 1;
        });
        useProjectStore.temporal.getState().clear();
        useProgrammerStore.getState().reset();
      },
      markSaved: (saved) =>
        set((state) => {
          state.baseline = saved ?? state.project;
        }),
    })),
    {
      limit: HISTORY_LIMIT,
      partialize: (state) => ({ project: state.project }),
      equality: (past, current) => past.project === current.project,
    },
  ),
);

/**
 * 是否有未保存的修改。
 *
 * @param state 工程 store 状态。
 */
export const selectDirty = (state: Pick<ProjectState, "project" | "baseline">): boolean =>
  state.project !== state.baseline;
