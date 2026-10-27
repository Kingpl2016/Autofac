import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 选项卡片共用的焦点样式：只在键盘导航时出现。 */
export const focusRingClass = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 选中项共用的高亮：用前景色而不是主色，这样无论主题与主色怎么变都清晰可见。 */
export const selectedClass = "border-foreground/70 ring-2 ring-foreground/15";

interface OptionTileProps {
  /** 是否选中。 */
  selected: boolean;
  /** 点击回调。 */
  onSelect: () => void;
  /** 选项名称，同时是按钮的无障碍名称。 */
  label: string;
  /** 预览图（会对读屏器隐藏，所以不要把关键信息只放在这里）。 */
  preview?: ReactNode;
  /** 是否禁用。 */
  disabled?: boolean;
  /** 额外的 class。 */
  className?: string;
}

/**
 * 选项卡片：带预览图的单选按钮，用于模式、主题等“看一眼就能选”的设置。
 * 语义是带 `aria-pressed` 的按钮；选中态靠对勾与高亮边框同时表达，不只靠颜色。
 */
export function OptionTile({ selected, onSelect, label, preview, disabled, className }: OptionTileProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        focusRingClass,
        "group relative flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-2 text-left text-xs transition-colors hover:bg-accent",
        selected && selectedClass,
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      {preview ? <span aria-hidden>{preview}</span> : null}
      <span className="flex items-center justify-between gap-1.5 px-0.5">
        <span className="truncate font-medium">{label}</span>
        {selected ? <Check aria-hidden className="size-3.5 shrink-0" /> : null}
      </span>
    </button>
  );
}