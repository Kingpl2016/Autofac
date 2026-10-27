import { cn } from "@/lib/utils";

/** 指示点的色调（只用语义色）。 */
export type StatusDotTone = "success" | "warning" | "destructive" | "muted" | "primary";

/**
 * 指示点的形状。不同严重度用不同形状区分，色盲用户或灰度打印也能分辨：
 *
 * - `circle`：实心圆，正常 / 就绪；
 * - `triangle`：三角，需要处理；
 * - `square`：空心方块，不可用 / 离线；
 * - `spinner`：旋转的圆环，进行中（减少动态效果时静止）。
 */
export type StatusDotShape = "circle" | "triangle" | "square" | "spinner";

const TONE_TEXT: Record<StatusDotTone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
  primary: "text-primary",
};

interface StatusDotProps {
  tone: StatusDotTone;
  shape: StatusDotShape;
  /** 文字标签；省略时只画指示点（此时必须由外层提供文字，指示点本身对读屏隐藏）。 */
  label?: string;
  /** 标签是否用状态色（默认是）；放在已有强调的位置时可改为前景色。 */
  colorLabel?: boolean;
  className?: string;
}

/**
 * 状态指示：形状 + 颜色 + 文字三重表达，不只靠颜色。
 */
export function StatusDot({ tone, shape, label, colorLabel = true, className }: StatusDotProps) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs font-medium", colorLabel && TONE_TEXT[tone], className)}>
      <Glyph tone={tone} shape={shape} />
      {label && <span className="truncate">{label}</span>}
    </span>
  );
}

function Glyph({ tone, shape }: { tone: StatusDotTone; shape: StatusDotShape }) {
  const color = TONE_TEXT[tone];
  if (shape === "triangle") {
    return (
      <svg viewBox="0 0 10 10" className={cn("size-2.5 shrink-0", color)} aria-hidden>
        <path d="M5 0.8 9.6 9.2H0.4Z" fill="currentColor" />
      </svg>
    );
  }
  if (shape === "square") {
    return <span className={cn("size-2 shrink-0 rounded-[1px] border-[1.5px] border-current", color)} aria-hidden />;
  }
  if (shape === "spinner") {
    return (
      <span
        className={cn(
          "size-2.5 shrink-0 rounded-full border-[1.5px] border-current border-t-transparent animate-spin motion-reduce:animate-none",
          color,
        )}
        aria-hidden
      />
    );
  }
  return <span className={cn("size-2 shrink-0 rounded-full bg-current", color)} aria-hidden />;
}
