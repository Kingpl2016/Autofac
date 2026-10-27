import { cn } from "@/lib/utils";
import type { ContentWidth, SidebarStyle } from "../lib/appearanceSettings";

/** 内容宽度示意：整体框内的内容块宽度随选项变化。 */
export function ContentWidthGlyph({ width }: { width: ContentWidth }) {
  const inner = width === "narrow" ? "w-1/2" : width === "default" ? "w-3/4" : "w-full";
  return (
    <span className="flex h-12 items-center justify-center rounded-md bg-muted/60 px-1.5">
      <span className={cn("h-8 rounded-sm border border-foreground/40 bg-card", inner)} />
    </span>
  );
}

/** 侧栏样式示意：用色块画出侧栏与内容区的相对位置、间距和圆角。 */
export function SidebarStyleGlyph({ style }: { style: SidebarStyle }) {
  const floating = style === "floating";
  const inset = style === "inset";
  return (
    <span className={cn("flex h-16 gap-1 overflow-hidden rounded-md border border-border p-1", inset ? "bg-sidebar" : "bg-background")}>
      <span
        className={cn(
          "flex w-1/4 shrink-0 flex-col gap-1 p-1",
          floating ? "rounded-md border border-border bg-sidebar shadow-md" : inset ? "bg-transparent" : "-m-1 mr-0 border-r border-border bg-sidebar",
        )}
      >
        <span className="h-1 w-full rounded-full bg-primary" />
        <span className="h-1 w-3/4 rounded-full bg-foreground/30" />
        <span className="h-1 w-2/3 rounded-full bg-foreground/30" />
      </span>
      <span className={cn("flex min-w-0 flex-1 flex-col gap-1 p-1", inset && "rounded-md border border-border bg-background")}>
        <span className="h-1 w-2/5 rounded-full bg-foreground/40" />
        <span className="flex-1 rounded-sm border border-border bg-card" />
      </span>
    </span>
  );
}
