import { Circle, Pause, Play, Square, TriangleAlert, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type StatusTone = "recording" | "playing" | "paused" | "idle" | "warning";

const TONES: Record<StatusTone, { icon: LucideIcon; className: string }> = {
  recording: {
    icon: Circle,
    className: "bg-recording/15 text-recording glow-recording",
  },
  playing: {
    icon: Play,
    className: "bg-success/15 text-success glow-success",
  },
  paused: { icon: Pause, className: "bg-warning/15 text-warning" },
  idle: { icon: Square, className: "bg-secondary text-muted-foreground" },
  warning: { icon: TriangleAlert, className: "bg-warning/15 text-warning" },
};

interface StatusPillProps {
  tone: StatusTone;
  /** 文字标签（状态不能只靠颜色，必须有文字） */
  children: React.ReactNode;
  className?: string;
}

/**
 * 状态胶囊：图标 + 文字 + 状态色（录制红 / 播放绿 / 暂停黄 / 待机灰）。
 */
export function StatusPill({ tone, children, className }: StatusPillProps) {
  const { icon: Icon, className: toneClass } = TONES[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
        toneClass,
        className,
      )}
    >
      <Icon
        className={cn("size-3", (tone === "recording" || tone === "playing") && "fill-current")}
        aria-hidden
      />
      {children}
    </span>
  );
}
