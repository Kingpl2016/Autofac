import { forwardRef, type ComponentPropsWithRef } from "react";
import { Slot } from "radix-ui";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** 带悬停提示的小图标按钮（assistant-ui 的 `TooltipIconButton`，适配项目的按钮与提示组件）。 */
export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  /** 提示文字（也是读屏的名称） */
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
};

/** 带悬停提示的小图标按钮：可作为 assistant-ui 原语的 `asChild` 子元素。 */
export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side = "bottom", className, ...rest }, ref) => (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" {...rest} className={cn("size-7 p-1 [&_svg]:size-3.5", className)} ref={ref}>
            <Slot.Slottable>{children}</Slot.Slottable>
            <span className="sr-only">{tooltip}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side={side}>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
);
TooltipIconButton.displayName = "TooltipIconButton";
