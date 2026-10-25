import { cn } from "@/lib/utils";

interface PulseRingProps {
  /** 是否处于录制中（脉冲 + 发光） */
  active: boolean;
  className?: string;
}

/**
 * 录制指示灯：录制中为实心红点加向外扩散的脉冲环，待机为空心灰环。
 * 纯装饰，状态文字由相邻的 `StatusPill` 提供。
 */
export function PulseRing({ active, className }: PulseRingProps) {
  return (
    <span className={cn("relative inline-flex size-5 items-center justify-center", className)} aria-hidden>
      {active && (
        <span className="animate-pulse-ring absolute inset-0 rounded-full bg-recording" />
      )}
      <span
        className={cn(
          "relative size-3 rounded-full",
          active ? "bg-recording glow-recording" : "border-2 border-muted-foreground/50",
        )}
      />
    </span>
  );
}
