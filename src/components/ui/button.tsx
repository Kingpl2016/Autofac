import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 按钮样式。
 *
 * - 反馈分层：悬停变深 / 变亮、按下再深一档并收起阴影，状态切换 150ms，不是瞬间跳变。
 * - 实心变体（default / destructive）顶部有一道 1px 的内高光，底部有淡阴影，让按钮略有体积；
 *   悬停时阴影带上自身颜色的微光。文字与背景保持 4.5:1 以上的对比度。
 * - 焦点环只在键盘导航时出现（focus-visible）；点击不会亮边。
 * - 触控目标：默认 44px 高，icon 44×44；`sm` 也有 40px。
 */
const buttonVariants = cva(
  [
    "relative inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out motion-reduce:transition-none",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default: [
          "bg-primary text-primary-foreground",
          "shadow-[inset_0_1px_0_0_rgb(255_255_255/0.18),0_1px_2px_0_rgb(0_0_0/0.28)]",
          "hover:bg-primary/90 hover:shadow-[inset_0_1px_0_0_rgb(255_255_255/0.18),0_4px_14px_-4px_color-mix(in_oklab,var(--primary)_60%,transparent)]",
          "active:bg-primary/80 active:shadow-[inset_0_1px_2px_0_rgb(0_0_0/0.25)]",
        ].join(" "),
        destructive: [
          "bg-destructive text-destructive-foreground",
          "shadow-[inset_0_1px_0_0_rgb(255_255_255/0.18),0_1px_2px_0_rgb(0_0_0/0.28)]",
          "hover:bg-destructive/90 hover:shadow-[inset_0_1px_0_0_rgb(255_255_255/0.18),0_4px_14px_-4px_color-mix(in_oklab,var(--destructive)_60%,transparent)]",
          "active:bg-destructive/80 active:shadow-[inset_0_1px_2px_0_rgb(0_0_0/0.25)]",
        ].join(" "),
        outline: [
          "border border-input bg-surface-2 text-foreground shadow-sm",
          "hover:border-ring/50 hover:bg-accent hover:text-accent-foreground",
          "active:bg-accent/70 active:shadow-none",
        ].join(" "),
        secondary: [
          "border border-transparent bg-secondary text-secondary-foreground",
          "hover:bg-secondary/75 active:bg-secondary/60",
        ].join(" "),
        soft: [
          "bg-primary/12 text-primary",
          "hover:bg-primary/20 active:bg-primary/28",
        ].join(" "),
        ghost: "text-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent/70",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-6 py-2",
        sm: "h-10 rounded-md px-5 text-xs",
        lg: "h-12 rounded-md px-8",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * 进行中：显示旋转图标、禁用点击并向读屏声明 `aria-busy`。
   * 图标按钮（`size="icon"`）会用旋转图标替换原图标；`asChild` 时忽略。
   */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size, className }));
    if (asChild) {
      return (
        <Slot.Root data-slot="button" className={classes} ref={ref} {...props}>
          {children}
        </Slot.Root>
      );
    }
    return (
      <button
        data-slot="button"
        className={classes}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
        {loading && size === "icon" ? null : children}
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
