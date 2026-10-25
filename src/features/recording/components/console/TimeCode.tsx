import { cn } from "@/lib/utils";
import { formatDurationUs } from "../../lib/filter";

type TimeCodeSize = "md" | "lg" | "xl";

const SIZE_CLASS: Record<TimeCodeSize, string> = {
  md: "text-lg",
  lg: "text-3xl",
  xl: "text-6xl",
};

interface TimeCodeProps {
  /** 当前时间（微秒） */
  valueUs: number;
  /** 总时长（微秒）；提供时在右侧以弱化样式显示 */
  totalUs?: number;
  size?: TimeCodeSize;
  /** 着色：录制红 / 待机（弱化）/ 默认前景 */
  tone?: "default" | "recording" | "idle";
  className?: string;
}

/**
 * 大号时间码（`m:ss.t` / `h:mm:ss.t`）。
 *
 * 用无衬线字体 + 等宽数字（`num`），不依赖系统是否安装了等宽字体——
 * Windows 上缺少等宽字体时会回退到 Courier 衬线体，大号时间码会很难看。
 * 纯展示；播放进度的读屏语义由进度滑杆的 `aria-valuetext` 负责。
 */
export function TimeCode({
  valueUs,
  totalUs,
  size = "lg",
  tone = "default",
  className,
}: TimeCodeProps) {
  return (
    <div
      className={cn(
        "num flex items-baseline gap-3 leading-none font-semibold tracking-tight",
        SIZE_CLASS[size],
        tone === "recording" && "text-recording",
        tone === "idle" && "text-muted-foreground/60",
        className,
      )}
    >
      <span>{formatDurationUs(valueUs)}</span>
      {totalUs !== undefined && (
        <span className="text-[0.4em] font-normal text-muted-foreground">
          / {formatDurationUs(totalUs)}
        </span>
      )}
    </div>
  );
}
