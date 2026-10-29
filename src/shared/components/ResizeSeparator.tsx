import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/** 拖动开始时的值与指针位置。 */
export interface DragStart {
  value: number;
  x: number;
  y: number;
}

type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** 每个方向键的反方向。 */
const OPPOSITE: Record<ArrowKey, ArrowKey> = {
  ArrowUp: "ArrowDown",
  ArrowDown: "ArrowUp",
  ArrowLeft: "ArrowRight",
  ArrowRight: "ArrowLeft",
};

interface ResizeSeparatorProps {
  /** 分隔条自身的方向：`vertical` 是竖线（左右拖动改宽度），`horizontal` 是横线（上下拖动改高度）。 */
  orientation: "vertical" | "horizontal";
  /** 当前值。 */
  value: number;
  min: number;
  max: number;
  /** 无障碍名称。 */
  label: string;
  /** 悬停提示。 */
  title?: string;
  /** 方向键一次调整的量。 */
  step: number;
  /** 按住 Shift 时一次调整的量；省略时与 `step` 相同。 */
  bigStep?: number;
  /** 让值变大的方向键（反方向键让值变小）。 */
  increaseKey: ArrowKey;
  /** Home 键到最小还是最大（End 相反）。默认 `min`，与 `aria-valuemin` 对应。 */
  homeTo?: "min" | "max";
  /**
   * 由拖动起点与当前指针算出新值（夹取交给 `normalize`）。
   *
   * @param start 起点。
   * @param pointer 当前指针坐标。
   */
  dragValue: (start: DragStart, pointer: { clientX: number; clientY: number }) => number;
  /** 规整新值（夹取、取整）。 */
  normalize: (value: number) => number;
  /**
   * 拖动中的预览。提供时，拖动期间只调用它，松手后若值有变化再调用一次 `onCommit`；
   * 省略时拖动的每一步都直接 `onCommit`。
   */
  onPreview?: (value: number) => void;
  /** 提交新值（键盘、双击、拖动）。 */
  onCommit: (value: number) => void;
  /** 双击恢复的默认值；省略时双击不做事。 */
  defaultValue?: number;
  /** 用 `requestAnimationFrame` 合并同一帧内的多次移动（写入代价高时用，例如会持久化）。 */
  frameThrottle?: boolean;
  /** 开始 / 结束拖动时调用（例如改变把手样式）。 */
  onDraggingChange?: (dragging: boolean) => void;
  className?: string;
  children?: ReactNode;
}

/**
 * 可拖动、可键盘调整的分隔条（`role="separator"`，带当前值与范围）。
 *
 * - 指针：主键按下后捕获指针，移动时按 `dragValue` 计算新值；松手、取消或失去捕获时结束；
 * - 键盘：方向键按 `step` 调整（Shift 为 `bigStep`），Home / End 到两端；处理过的按键不再冒泡，
 *   不会同时触发页面快捷键；
 * - 双击：恢复 `defaultValue`。
 */
export function ResizeSeparator({
  orientation,
  value,
  min,
  max,
  label,
  title,
  step,
  bigStep = step,
  increaseKey,
  homeTo = "min",
  dragValue,
  normalize,
  onPreview,
  onCommit,
  defaultValue,
  frameThrottle = false,
  onDraggingChange,
  className,
  children,
}: ResizeSeparatorProps) {
  const drag = useRef<{ start: DragStart; last: number } | null>(null);
  const frame = useRef<{ id: number; value: number } | null>(null);

  const apply = (next: number) => {
    if (onPreview) onPreview(next);
    else onCommit(next);
  };
  const flushFrame = () => {
    const f = frame.current;
    if (!f) return;
    cancelAnimationFrame(f.id);
    frame.current = null;
    apply(f.value);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { start: { value, x: e.clientX, y: e.clientY }, last: value };
    onDraggingChange?.(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = normalize(dragValue(d.start, e));
    d.last = next;
    if (!frameThrottle) {
      apply(next);
      return;
    }
    if (frame.current) cancelAnimationFrame(frame.current.id);
    frame.current = { id: requestAnimationFrame(flushFrame), value: next };
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    flushFrame();
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (onPreview && d.last !== d.start.value) onCommit(d.last);
    onDraggingChange?.(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const amount = e.shiftKey ? bigStep : step;
    let next: number;
    if (e.key === increaseKey) next = value + amount;
    else if (e.key === OPPOSITE[increaseKey]) next = value - amount;
    else if (e.key === "Home") next = homeTo === "min" ? min : max;
    else if (e.key === "End") next = homeTo === "min" ? max : min;
    else return;
    e.preventDefault();
    e.stopPropagation();
    onCommit(normalize(next));
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={defaultValue === undefined ? undefined : () => onCommit(defaultValue)}
      className={className}
    >
      {children}
    </div>
  );
}
