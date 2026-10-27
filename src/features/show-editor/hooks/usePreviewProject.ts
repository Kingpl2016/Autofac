import { useMemo } from "react";

import type { ShowProject } from "../lib/project";
import { blackoutProject, withProgrammer } from "../lib/programmer";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 预览用的工程：当前工程叠上编程器（置顶层）；黑场时全部轨道静音。编程器为空时就是工程本身。
 *
 * 引用只在工程或编程器内容变化时改变，配合 `compileCached` 拖动播放头不会重新编译。
 *
 * @returns 工程快照。
 */
export function usePreviewProject(): ShowProject {
  const project = useProjectStore((s) => s.project);
  const values = useProgrammerStore((s) => s.values);
  const blackout = useEditorUiStore((s) => s.blackout);
  return useMemo(
    () => (blackout ? blackoutProject(project) : withProgrammer(project, values)),
    [project, values, blackout],
  );
}
