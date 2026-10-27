import { cn } from "@/lib/utils";
import { isDrivenFunction } from "../lib/draft";
import type { FixtureModel } from "../lib/types";
import { channelCount, endChannel } from "../lib/validate";

interface ChannelStripProps {
  model: Pick<FixtureModel, "properties">;
}

/** 一个通道格子：该通道属于哪个属性（若有）以及是否为 16 位属性的后续字节。 */
interface Cell {
  channel: number;
  code: string | null;
  driven: boolean;
  /** 16 位属性的第二个通道 */
  continuation: boolean;
}

/**
 * 通道布局条：把灯具占用的通道从 1 开始逐格画出来，一眼看出每个通道是什么属性。
 * 被灯光求值器直接驱动的功能（颜色 / 亮度 / 开关）用强调色，其余用中性色，空洞用虚线。
 * 详细信息在旁边的表格里，这里仅作视觉辅助，对读屏隐藏。
 */
export function ChannelStrip({ model }: ChannelStripProps) {
  const total = channelCount(model);
  const cells: Cell[] = Array.from({ length: total }, (_, i) => ({
    channel: i + 1,
    code: null,
    driven: false,
    continuation: false,
  }));
  for (const p of model.properties) {
    for (let ch = p.channel; ch <= endChannel(p) && ch <= total; ch += 1) {
      cells[ch - 1] = {
        channel: ch,
        code: p.code || p.name,
        driven: isDrivenFunction(p.function),
        continuation: ch > p.channel,
      };
    }
  }
  return (
    <div
      aria-hidden
      className="grid gap-1"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(4.25rem, 1fr))" }}
    >
      {cells.map((c) => (
        <div
          key={c.channel}
          className={cn(
            "flex h-12 flex-col justify-between rounded-md border px-1.5 py-1 text-[0.65rem] leading-tight",
            c.code === null && "border-dashed border-border text-muted-foreground/60",
            c.code !== null && c.driven && "border-primary/50 bg-primary/15 text-foreground",
            c.code !== null && !c.driven && "border-border bg-muted text-foreground",
          )}
        >
          <span className="num text-muted-foreground">{c.channel}</span>
          <span className="truncate font-medium">{c.continuation ? "↳" : (c.code ?? "")}</span>
        </div>
      ))}
    </div>
  );
}
