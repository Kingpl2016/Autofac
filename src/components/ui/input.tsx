import * as React from "react";

import { cn } from "@/lib/utils";
import { FIELD_BASE } from "./fieldStyles";

/**
 * 基础文本输入框。
 *
 * 样式见 {@link FIELD_BASE}：凹陷底色、悬停 / 聚焦边框、`aria-invalid` 时的危险色。
 * 出错时给输入框设置 `aria-invalid` 并用 `aria-describedby` 指向错误文字。
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        data-slot="input"
        className={cn(
          FIELD_BASE,
          "flex h-11 px-4 py-1",
          "file:mr-3 file:inline-flex file:h-7 file:cursor-pointer file:items-center file:rounded file:border-0 file:bg-secondary file:px-3 file:text-xs file:font-medium file:text-secondary-foreground",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };