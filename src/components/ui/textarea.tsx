import * as React from "react";

import { cn } from "@/lib/utils";
import { FIELD_BASE } from "./fieldStyles";

/**
 * 多行文本输入。样式与 {@link Input} 一致（见 `fieldStyles`）。
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(FIELD_BASE, "flex min-h-20 px-4 py-3 leading-relaxed", className)}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export { Textarea };