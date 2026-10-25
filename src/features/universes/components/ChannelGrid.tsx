import { useTranslation } from "react-i18next";

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import type { ValueFormat } from "@/features/settings";
import { formatChannelValue, levelColor } from "../lib/format";

interface ChannelGridProps {
  /** Universe 编号 */
  universe: number;
  /** 通道值显示格式 */
  valueFormat: ValueFormat;
  /**
   * 显式提供通道数据（如回放输出）。省略时读取实时引擎的合并输出。
   */
  data?: number[];
}

const CHANNELS = 512;

/**
 * 单个 Universe 的 512 通道色块栅格（黑→蓝→青→白）。
 *
 * 数据来源默认是实时引擎；传入 `data` 即可复用同一栅格显示回放等其它来源。
 */
export function ChannelGrid({ universe, valueFormat, data: provided }: ChannelGridProps) {
  const { t } = useTranslation();
  const live = useEngineDataStore((s) => s.channels[universe]);
  const data = provided ?? live;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-sm font-medium">
        <span>Universe</span>
        <span className="tabular">{universe}</span>
      </div>
      <div
        className="grid gap-px rounded-md border border-border bg-border p-px"
        style={{ gridTemplateColumns: "repeat(32, minmax(0, 1fr))" }}
        role="grid"
        aria-label={`Universe ${universe} ${t("universes.channel")}`}
      >
        {Array.from({ length: CHANNELS }, (_, i) => {
          const v = data?.[i] ?? 0;
          return (
            <div
              key={i}
              className="flex aspect-square items-center justify-center text-[0.5rem] leading-none"
              style={{
                backgroundColor: v === 0 ? "var(--card)" : levelColor(v),
                color: v > 128 ? "#0a0a0a" : "rgba(200,220,255,0.55)",
              }}
              title={`CH${i + 1}: ${v}`}
            >
              <span className="tabular">
                {v > 0 ? formatChannelValue(v, valueFormat) : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
