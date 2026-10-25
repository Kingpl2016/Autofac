import {
  CircleCheck,
  Circle,
  Film,
  OctagonAlert,
  Pause,
  Play,
  Square,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 状态色调。红 = 录制、绿 = 播放 / 就绪、黄 = 暂停 / 告警、强调色 = 播放器模式（“模式”而非“状态”，
 * 不占用红绿黄）、红 + 警示图标 = 错误。
 */
export type StatusTone =
  | "recording"
  | "playing"
  | "paused"
  | "idle"
  | "warning"
  | "player"
  | "ready"
  | "error";

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
  player: { icon: Film, className: "bg-primary/15 text-primary glow-primary" },
  ready: { icon: CircleCheck, className: "bg-success/15 text-success" },
  error: { icon: OctagonAlert, className: "bg-destructive/15 text-destructive" },
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
