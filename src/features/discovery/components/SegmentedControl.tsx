import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** 可选的数量角标 */
  count?: number;
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 整组控件的无障碍名称 */
  label: string;
}

/**
 * 分段筛选控件。每段是一个带 `aria-pressed` 的按钮（不是 tab：它不切换面板，只改筛选），
 * 选中态用底色 + 文字色双重区分。
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {o.label}
            {o.count != null && <span className="tabular opacity-70">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
