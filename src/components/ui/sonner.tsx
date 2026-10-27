import type { CSSProperties } from "react";
import { CircleAlert, CircleCheck, Info, Loader2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/** 图标统一尺寸；颜色由外层的 `--toast-accent` 决定。 */
const ICON = "size-[18px]";

/** 各类型的强调色与淡淡的底色倾向（类名必须是完整字面量，Tailwind 才能扫描到）。 */
const TYPE = {
  success:
    "[--toast-accent:var(--success)] border-success/30 bg-[color-mix(in_oklab,var(--success)_7%,var(--popover))]",
  error:
    "[--toast-accent:var(--destructive)] border-destructive/40 bg-[color-mix(in_oklab,var(--destructive)_8%,var(--popover))]",
  warning:
    "[--toast-accent:var(--warning)] border-warning/40 bg-[color-mix(in_oklab,var(--warning)_8%,var(--popover))]",
  info: "[--toast-accent:var(--primary)] border-primary/30 bg-[color-mix(in_oklab,var(--primary)_7%,var(--popover))]",
  loading: "[--toast-accent:var(--primary)]",
} as const;

/** 宽度：窄屏占满，宽屏最宽 26rem（sonner 用 `--width` 控制）。 */
const TOASTER_STYLE = { "--width": "min(92vw, 26rem)" } as CSSProperties;

/**
 * 全局提示（toast）容器，屏幕上方居中弹出。
 *
 * 设计取向（参考当下主流的 Sonner / Linear / Vercel 一类做法）：
 * - 中性的浮层卡片 + 一枚带淡色圆底的语义图标，状态靠「图标 + 文字」表达，底色与描边只做轻微倾向，不用整块饱和色；
 * - 圆角大、阴影柔和、字号小而克制，标题一行，说明（可选）在下一行；
 * - 悬停时暂停计时并显示关闭按钮（键盘聚焦同样可见）；多条提示自动叠放，鼠标移上去展开；
 * - 动效由 Sonner 提供，系统开启“减少动态效果”时它会自动关闭过渡。
 *
 * 样式用 Sonner 的 `unstyled` + Tailwind 类名覆盖，主题色全部走 CSS 变量，随深浅主题与强调色变化。
 */
export function Toaster({ ...props }: ToasterProps) {
  const { t } = useTranslation();

  return (
    <Sonner
      position="top-center"
      offset={12}
      gap={10}
      closeButton
      containerAriaLabel={t("toast.region")}
      style={TOASTER_STYLE}
      icons={{
        success: <CircleCheck className={ICON} aria-hidden />,
        error: <CircleAlert className={ICON} aria-hidden />,
        warning: <TriangleAlert className={ICON} aria-hidden />,
        info: <Info className={ICON} aria-hidden />,
        loading: <Loader2 className={`${ICON} animate-spin motion-reduce:animate-none`} aria-hidden />,
      }}
      toastOptions={{
        unstyled: true,
        duration: 5000,
        closeButtonAriaLabel: t("common.close"),
        classNames: {
          toast: [
            "group/toast relative flex w-full items-center gap-3 rounded-2xl border border-border bg-popover px-4 py-3",
            "text-popover-foreground shadow-[0_10px_32px_-8px_rgb(0_0_0/0.35),0_2px_6px_rgb(0_0_0/0.12)]",
            "[--toast-accent:var(--muted-foreground)]",
          ].join(" "),
          ...TYPE,
          icon: "flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--toast-accent)_16%,transparent)] text-[var(--toast-accent)]",
          content: "flex min-w-0 flex-1 flex-col gap-0.5",
          title: "text-sm font-medium leading-snug",
          description: "text-xs leading-snug text-muted-foreground",
          actionButton:
            "ml-1 shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          cancelButton:
            "shrink-0 rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          closeButton: [
            "absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full border border-border bg-popover",
            "text-muted-foreground shadow-sm opacity-0 transition-opacity motion-reduce:transition-none",
            "hover:text-foreground focus-visible:opacity-100 group-hover/toast:opacity-100",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ].join(" "),
        },
      }}
      {...props}
    />
  );
}
