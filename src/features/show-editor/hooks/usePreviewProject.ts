import { useMemo } from "react";

import type { ShowProject } from "../lib/project";
import { blackoutProject, withHighlight, withProgrammer } from "../lib/programmer";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 没有高亮时的空选择（引用稳定，避免选择变化引起重新编译）。 */
const NONE: readonly string[] = [];

/**
 * 预览用的工程：当前工程叠上编程器（置顶层），再叠上高亮（选中的灯满亮白光）；黑场时全部轨道静音。
 * 编程器为空、没开高亮时就是工程本身。
 *
 * 引用只在工程、编程器内容或（高亮时）选择变化时改变，配合 `compileCached` 拖动播放头不会重新编译。
 *
 * @returns 工程快照。
 */
export function usePreviewProject(): ShowProject {
  const project = useProjectStore((s) => s.project);
  const values = useProgrammerStore((s) => s.values);
  const highlight = useProgrammerStore((s) => s.highlight);
  const highlighted = useEditorUiStore((s) => (highlight ? s.selectedFixtureIds : NONE));
  const blackout = useEditorUiStore((s) => s.blackout);
  return useMemo(
    () => (blackout ? blackoutProject(project) : withHighlight(withProgrammer(project, values), highlighted)),
    [project, values, highlighted, blackout],
  );
}
