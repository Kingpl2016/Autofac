import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * 开关（基于 Radix Switch）。
 *
 * 轨道 44×24、滑块 20px：比常见的 36×20 更容易点中；未选中的轨道用弱化前景色，
 * 在浅色 / 深色卡片上都能达到 3:1 的非文字对比度，选中态用主色。
 */
const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    data-slot="switch"
    className={cn(
      "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
      "shadow-[inset_0_1px_2px_0_rgb(0_0_0/0.18)]",
      "transition-colors duration-150 ease-out motion-reduce:transition-none",
      "hover:data-[state=unchecked]:bg-muted-foreground/50 hover:data-[state=checked]:bg-primary/90",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted-foreground/40",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block size-5 rounded-full bg-white shadow-[0_1px_3px_0_rgb(0_0_0/0.35)] ring-0",
        "transition-transform duration-150 ease-out motion-reduce:transition-none",
        "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export { Switch };