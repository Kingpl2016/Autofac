import { useRef } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** 整组的无障碍名称 */
  ariaLabel: string;
  className?: string;
}

/**
 * 分段选择器（单选，`radiogroup` 语义）。
 *
 * 采用漫游 tabindex：Tab 只停在当前项，方向键 / Home / End 在组内移动并立即选中。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, delta: number | "first" | "last") => {
    const n = options.length;
    const to =
      delta === "first" ? 0 : delta === "last" ? n - 1 : (from + delta + n) % n;
    onChange(options[to].value);
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

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
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
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "num min-w-12 rounded-md px-3 py-2 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checked
                ? "bg-surface-3 text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
