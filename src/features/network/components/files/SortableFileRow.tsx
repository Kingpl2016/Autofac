import { useSortable } from "@dnd-kit/sortable";
import type { ComponentProps } from "react";

import { FileRow } from "./FileRow";

type SortableFileRowProps = Omit<ComponentProps<typeof FileRow>, "drag"> & {
  /** 手柄不可用（不可写、正在提交） */
  sortDisabled: boolean;
};

/** 用户偏好减少动态效果时，行归位不做滑动动画。 */
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * 可拖动排序的文件行：把 dnd-kit 的排序状态接到 [`FileRow`] 上。
 * 只有手柄响应指针与键盘（空格拿起、方向键移动、空格放下、Esc 取消），行内其它按钮照常点击。
 */
export function SortableFileRow({ sortDisabled, ...rowProps }: SortableFileRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: rowProps.file.name,
    disabled: sortDisabled,
    transition: reducedMotion() ? null : undefined,
  });

  return (
    <FileRow
      {...rowProps}
      bindRow={setNodeRef}
      bindHandle={setActivatorNodeRef}
      drag={{
        // 只用纵向位移：行宽由表格决定，不要被缩放变形
        style: { transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined, transition },
        isDragging,
        disabled: sortDisabled,
        handleProps: { ...attributes, ...listeners },
      }}
    />
  );
}
