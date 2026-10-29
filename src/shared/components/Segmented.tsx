import { useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 分段按钮共用的基础样式（`Segmented` 与 `SegmentedControl` 共用）。 */
export const SEGMENT_ITEM_BASE =
  "inline-flex items-center whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** 文字前的装饰图标（须自带 `aria-hidden`；状态不能只靠图标表达） */
  icon?: ReactNode;
  /** 悬停提示，用于补充说明该选项的后果 */
  title?: string;
  /** 文字标签的额外样式，例如窄屏下用 `max-lg:sr-only` 只保留图标、文字留给读屏 */
  labelClassName?: string;
  disabled?: boolean;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** 整组的无障碍名称 */
  ariaLabel: string;
  /**
   * 方向键的行为：
   * - `auto`（默认）：方向键移动焦点并立即选中，适合无副作用的显示切换（如倍速）；
   * - `manual`：方向键只移动焦点，`Enter` / `Space` 才激活，适合有副作用的切换（如应用模式）。
   */
  activation?: "auto" | "manual";
  /** 尺寸：`xs` 24px 高（面板里的紧凑工具条），`sm` 约 32px 高，`md` 约 36px 高。图标随尺寸统一缩放，与文字等高。 */
  size?: "xs" | "sm" | "md";
  /** 忙碌时整组不可操作，并向读屏声明 `aria-busy`。 */
  busy?: boolean;
  className?: string;
}

/**
 * 分段选择器（单选，`radiogroup` 语义）。
 *
 * 采用漫游 tabindex：Tab 只停在当前项，方向键 / Home / End 在组内移动；
 * `activation="auto"` 时同时选中，`"manual"` 时需 `Enter` / `Space` 激活。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  activation = "auto",
  size = "sm",
  busy = false,
  className,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // manual 模式下，焦点所在项（可能不是已选项）
  const [focusIndex, setFocusIndex] = useFocusIndex(options, value);

  const enabled = (i: number) => !options[i].disabled;

  const move = (from: number, delta: number | "first" | "last") => {
    const n = options.length;
    let to = delta === "first" ? 0 : delta === "last" ? n - 1 : (from + delta + n) % n;
    // 跳过禁用项（最多绕一圈）
    for (let k = 0; k < n && !enabled(to); k += 1) {
      to = typeof delta === "number" && delta < 0 ? (to - 1 + n) % n : (to + 1) % n;
    }
    if (!enabled(to)) return;
    if (activation === "auto") onChange(options[to].value);
    else setFocusIndex(to);
    refs.current[to]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") move(index, 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(index, -1);
    else if (e.key === "Home") move(index, "first");
    else if (e.key === "End") move(index, "last");
    else return;
    e.preventDefault();
  };

  const tabStop = activation === "auto" ? options.findIndex((o) => o.value === value) : focusIndex;

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      className={cn("inline-flex rounded-lg bg-surface-1 p-0.5", className)}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={o.disabled || busy}
            title={o.title}
            onClick={() => {
              setFocusIndex(i);
              onChange(o.value);
            }}
            onFocus={() => activation === "manual" && setFocusIndex(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              SEGMENT_ITEM_BASE,
              "num justify-center gap-1.5",
              size === "xs" ? "h-6 min-w-8 px-2 text-[11px] [&_svg]:size-3.5" : "min-w-12 px-3 text-xs [&_svg]:size-3.5",
              size === "md" ? "h-9 [&_svg]:size-4" : size === "sm" && "py-2",
              "[&_svg]:shrink-0",
              "disabled:cursor-not-allowed disabled:opacity-60",
              checked
                ? "bg-surface-3 text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.icon}
            <span className={o.labelClassName}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 漫游 tabindex 的焦点下标：默认等于已选项，已选项变化时同步回来。
 *
 * @param options 选项列表。
 * @param value 当前已选值。
 * @returns `[焦点下标, 设置焦点下标]`。
 */
function useFocusIndex<T extends string>(
  options: readonly SegmentedOption<T>[],
  value: T,
): [number, (i: number) => void] {
  const selected = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  // 已选项变化时让焦点下标回到已选项：在渲染期派生，避免在 effect 里同步 setState
  const [state, setState] = useState({ selected, index: selected });
  let index = state.index;
  if (state.selected !== selected) {
    index = selected;
    setState({ selected, index: selected });
  }
  const setIndex = (i: number) => setState({ selected, index: i });
  return [index, setIndex];
}
