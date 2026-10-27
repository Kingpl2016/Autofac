import { Group, Panel, Separator } from "react-resizable-panels";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** 可拖拽调整大小的面板组（react-resizable-panels v4 的主题封装）。 */
function ResizablePanelGroup({ className, ...props }: ComponentProps<typeof Group>) {
  return (
    <Group
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full", className)}
      {...props}
    />
  );
}

/** 单个面板；数字尺寸表示像素，不带单位的字符串表示百分比。 */
function ResizablePanel({ ...props }: ComponentProps<typeof Panel>) {
  return <Panel data-slot="resizable-panel" {...props} />;
}

interface ResizableHandleProps extends ComponentProps<typeof Separator> {
  /**
   * 分隔条所在的轴：`x` 分隔左右并排的面板（竖线），`y` 分隔上下叠放的面板（横线）。
   * 与所在 `ResizablePanelGroup` 的 `orientation` 对应（horizontal → x，vertical → y）。
   */
  axis: "x" | "y";
}

/** 面板之间的拖拽分隔条；可聚焦，方向键可调整；命中区比视觉线条更宽。 */
function ResizableHandle({ className, axis, ...props }: ResizableHandleProps) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "relative shrink-0 bg-border transition-colors",
        "hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none",
        "after:absolute after:content-['']",
        axis === "x"
          ? "h-full w-px after:inset-y-0 after:-left-1 after:-right-1"
          : "h-px w-full after:inset-x-0 after:-top-1 after:-bottom-1",
        className,
      )}
      {...props}
    />
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
