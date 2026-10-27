import { cn } from "@/lib/utils";
import type { Swatch } from "../lib/themeSwatch";

interface MiniWindowProps {
  /** 用到的颜色。 */
  swatch: Swatch;
  /** 额外的 class，通常用来设置高度。 */
  className?: string;
}

/** 迷你界面：用几个色块画出“侧边栏 + 顶栏 + 卡片 + 主色按钮”，在选项卡片里直观展示配色（纯装饰）。 */
export function MiniWindow({ swatch: s, className }: MiniWindowProps) {
  return (
    <span
      className={cn("flex h-[4.5rem] overflow-hidden rounded-lg border", className)}
      style={{ background: s.background, borderColor: s.border }}
    >
      <span
        className="flex w-[26%] shrink-0 flex-col gap-1 border-r p-1.5"
        style={{ background: s.sidebar, borderColor: s.border }}
      >
        <span className="h-1.5 w-full rounded-full" style={{ background: s.primary }} />
        <span className="h-1 w-3/4 rounded-full" style={{ background: s.muted }} />
        <span className="h-1 w-2/3 rounded-full" style={{ background: s.muted }} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5 p-1.5">
        <span className="h-1.5 w-2/5 rounded-full opacity-70" style={{ background: s.foreground }} />
        <span
          className="flex flex-1 flex-col justify-between rounded-md border p-1"
          style={{ background: s.card, borderColor: s.border }}
        >
          <span className="h-1 w-3/5 rounded-full" style={{ background: s.muted }} />
          <span className="h-2 w-1/2 rounded-full" style={{ background: s.primary }} />
        </span>
      </span>
    </span>
  );
}