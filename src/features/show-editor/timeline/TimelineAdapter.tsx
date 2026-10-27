import { forwardRef } from "react";
import {
  Timeline,
  type TimelineEditor,
  type TimelineState,
} from "@xzdarcy/react-timeline-editor";

import "./timelineTheme.css";

/** 时间线的一行（一条轨道）及其中的块；库没有直接导出，这里由参数类型推出。 */
export type TimelineRow = TimelineEditor["editorData"][number];

/** 时间线的命令式句柄（设置 / 读取播放头、滚动等），直接透传库的 `TimelineState`。 */
export type TimelineHandle = TimelineState;

/** 适配层只暴露编辑器需要的那部分库参数，库升级或换成自研实现时上层代码不用改。 */
export type TimelineAdapterProps = Pick<
  TimelineEditor,
  | "editorData"
  | "scale"
  | "scaleSplitCount"
  | "scaleWidth"
  | "minScaleCount"
  | "maxScaleCount"
  | "startLeft"
  | "rowHeight"
  | "gridSnap"
  | "dragLine"
  | "hideCursor"
  | "getActionRender"
  | "getScaleRender"
  | "onChange"
  | "onClickRow"
  | "onClickAction"
  | "onClickActionOnly"
  | "onDoubleClickAction"
  | "onDoubleClickRow"
  | "onActionMoving"
  | "onActionResizing"
  | "onActionMoveEnd"
  | "onActionResizeEnd"
  | "onScroll"
> & {
  /** 播放头被拖动或点击标尺时的回调（单位：秒）。 */
  onSeek?: (timeSec: number) => void;
};

/** 库要求提供“效果表”；编辑器自己绘制 Cue，所以只需要一个占位效果。 */
const EFFECTS = { cue: { id: "cue" } };

/**
 * 时间线适配层：包装 `@xzdarcy/react-timeline-editor`。
 *
 * 约定：
 * - 时间单位是秒（库的约定）；工程数据用整数毫秒，换算在适配层之上完成。
 * - 播放头的“真实时间”来自后端播放引擎，这里不使用库自带的播放引擎，只用 `setTime` 同步光标。
 * - 颜色与尺寸来自 `timelineTheme.css`，不引入库自带的样式表。
 */
export const TimelineAdapter = forwardRef<TimelineHandle, TimelineAdapterProps>(
  function TimelineAdapter({ onSeek, ...props }, ref) {
    return (
      <Timeline
        ref={ref}
        effects={EFFECTS}
        autoScroll
        style={{ width: "100%", height: "100%" }}
        onCursorDrag={onSeek}
        onClickTimeArea={(time) => {
          onSeek?.(time);
          return undefined;
        }}
        {...props}
      />
    );
  },
);
