/**
 * 输入类控件（输入框、文本域、下拉触发器）共用的外观，保证它们长得一样。
 *
 * - 底色用 `surface-1`：比所在的卡片 / 弹层更“凹”，一眼能看出这里可以输入；浅色下是淡灰，深色下是更深的井。
 * - 悬停时边框变成强调色的淡色，获得焦点时边框变成强调色并带一圈柔和的外环（不用实心的粗焰圈）。
 * - 校验失败用 `aria-invalid` 驱动：边框和外环变成危险色，不依赖颜色以外的东西时由调用方补充文字。
 * - 禁用：降低不透明度、换成弱化底色并显示 not-allowed 光标。
 */
export const FIELD_BASE = [
  "w-full rounded-md border border-input bg-surface-1 text-sm text-foreground",
  "shadow-[inset_0_1px_2px_0_rgb(0_0_0/0.10)]",
  "transition-[border-color,box-shadow,background-color] duration-150 ease-out motion-reduce:transition-none",
  "placeholder:text-muted-foreground/80 selection:bg-primary/30",
  "hover:border-ring/50",
  "focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25",
  "aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-[3px] aria-[invalid=true]:ring-destructive/20",
  "aria-[invalid=true]:focus-visible:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/30",
  "disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 disabled:shadow-none disabled:hover:border-input",
].join(" ");