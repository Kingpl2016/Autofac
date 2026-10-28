import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { groupOf } from "../lib/functions";
import { ATTRIBUTE_GROUPS, type AttributeGroup, type FixtureModel } from "../lib/types";
import { channelCount, endChannel } from "../lib/validate";

interface ChannelStripProps {
  model: Pick<FixtureModel, "properties">;
}

/** 属性组的数据色类名（静态字符串，Tailwind 才能扫描到；颜色来自 `--attr-*` 变量）。 */
const GROUP_CLASS: Record<AttributeGroup, { bar: string; cell: string }> = {
  intensity: { bar: "bg-attr-intensity", cell: "border-attr-intensity/50 bg-attr-intensity/12" },
  color: { bar: "bg-attr-color", cell: "border-attr-color/50 bg-attr-color/12" },
  position: { bar: "bg-attr-position", cell: "border-attr-position/50 bg-attr-position/12" },
  beam: { bar: "bg-attr-beam", cell: "border-attr-beam/50 bg-attr-beam/12" },
  focus: { bar: "bg-attr-focus", cell: "border-attr-focus/50 bg-attr-focus/12" },
  control: { bar: "bg-attr-control", cell: "border-attr-control/50 bg-attr-control/12" },
};

/** 一个通道格子：该通道属于哪个属性（若有）以及是否为 16 位属性的后续字节。 */
interface Cell {
  channel: number;
  code: string | null;
  group: AttributeGroup | null;
  /** 16 位属性的第二个通道 */
  continuation: boolean;
}

/**
 * 通道布局条：把灯具占用的通道从 1 开始逐格画出来，按属性功能组着色（顶部色条 + 浅底），
 * 格子里写属性代码，空洞用虚线；下方图例给出出现过的功能组。
 * 详细信息在旁边的表格里，格子仅作视觉辅助，对读屏隐藏；图例是文字，读屏可读。
 */
export function ChannelStrip({ model }: ChannelStripProps) {
  const { t } = useTranslation();
  const total = channelCount(model);
  const cells: Cell[] = Array.from({ length: total }, (_, i) => ({ channel: i + 1, code: null, group: null, continuation: false }));
  for (const p of model.properties) {
    for (let ch = p.channel; ch <= endChannel(p) && ch <= total; ch += 1) {
      cells[ch - 1] = { channel: ch, code: p.code || p.name, group: groupOf(p.function), continuation: ch > p.channel };
    }
  }
  const present = ATTRIBUTE_GROUPS.filter((g) => cells.some((c) => c.group === g));

  return (
    <div className="grid gap-2">
      <div aria-hidden className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(3.5rem, 1fr))" }}>
        {cells.map((c) => (
          <div
            key={c.channel}
            className={cn(
              "relative flex h-10 flex-col justify-between overflow-hidden rounded-md border px-1.5 pt-1.5 pb-1 text-[0.65rem] leading-tight",
              c.group === null ? "border-dashed border-border text-muted-foreground/60" : cn(GROUP_CLASS[c.group].cell, "text-foreground"),
            )}
          >
            {c.group && <span className={cn("absolute inset-x-0 top-0 h-1", GROUP_CLASS[c.group].bar, c.continuation && "opacity-50")} />}
            <span className="num text-muted-foreground">{c.channel}</span>
            <span className="truncate font-medium">{c.continuation ? "↳" : (c.code ?? "")}</span>
          </div>
        ))}
      </div>
      {present.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label={t("fixtures.detail.legend")}>
          {present.map((g) => (
            <li key={g} className="flex items-center gap-1.5">
              <span aria-hidden className={cn("size-2.5 rounded-sm", GROUP_CLASS[g].bar)} />
              {t(`fixtures.groups.${g}`)}
              <span className="num">{cells.filter((c) => c.group === g).length}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
