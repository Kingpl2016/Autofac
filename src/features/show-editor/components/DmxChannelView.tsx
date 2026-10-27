import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChannelGrid } from "@/features/universes";
import { useEngine } from "../engine/useEngine";
import { usePreviewProject } from "../hooks/usePreviewProject";
import { createDmxEvaluator } from "../lib/dmxPreview";
import { channelOwners, usedUniverses } from "../lib/patch";
import { DMX_CHANNELS } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";

/**
 * DMX 通道视图：播放头时刻某个 Universe 的 512 个输出值（与后端输出同一份 WASM 引擎，含 Gamma、
 * 多重配接与通道锁定），点击通道显示它属于哪台灯具的哪个属性。数值固定按十进制显示（与灯具说明书一致）。
 *
 * @param props.universe 外部指定的 Universe（例如点了容量条）；省略时自己选。
 * @param props.onUniverseChange Universe 切换回调。
 */
export function DmxChannelView({
  universe: controlled,
  onUniverseChange,
}: {
  universe?: number | null;
  onUniverseChange?: (universe: number) => void;
}) {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const engine = useEngine();
  const universes = useMemo(() => usedUniverses(project.fixtures), [project.fixtures]);
  const [own, setOwn] = useState<number | null>(null);
  const [channel, setChannel] = useState<number | undefined>(undefined);
  const preview = usePreviewProject();
  const evaluate = useMemo(() => createDmxEvaluator(preview, engine), [preview, engine]);

  const wanted = controlled ?? own;
  const universe = wanted !== null && universes.includes(wanted) ? wanted : (universes[0] ?? null);
  if (universe === null) return null;
  const data = evaluate(playheadMs, universe);
  const owners = channel ? channelOwners(project, universe, channel) : [];
  const selectId = `dmx-universe-${universe}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={selectId} className="text-xs">
          {t("editor.dmx.universe")}
        </Label>
        <Select
          value={String(universe)}
          onValueChange={(v) => {
            setOwn(Number(v));
            setChannel(undefined);
            onUniverseChange?.(Number(v));
          }}
        >
          <SelectTrigger id={selectId} className="h-7 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {universes.map((u) => (
              <SelectItem key={u} value={String(u)}>
                U{u}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* 色块不进入 Tab 序列，键盘用户用通道号输入框查看 */}
        <CommitInput
          className="num h-7 w-16 px-1.5 text-xs"
          inputMode="numeric"
          label={t("editor.dmx.channel")}
          value={channel ?? ""}
          onCommit={(text) => {
            const n = Number(text);
            setChannel(Number.isInteger(n) && n >= 1 && n <= DMX_CHANNELS ? n : undefined);
          }}
        />
      </div>
      <ChannelGrid
        universe={universe}
        valueFormat="decimal"
        data={data}
        selectedChannel={channel}
        onChannelClick={setChannel}
      />
      <p aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
        {channel === undefined
          ? t("editor.dmx.hint")
          : owners.length === 0
            ? t("editor.dmx.free", { channel, value: data[channel - 1] })
            : owners
                .map((o) =>
                  t("editor.dmx.owner", {
                    channel,
                    value: data[channel - 1],
                    fixture: o.fixtureName,
                    property: o.property || "—",
                    extra: [o.fine ? "Fine" : "", o.mirror ? t("editor.dmx.mirror") : ""].filter(Boolean).join(" · "),
                  }),
                )
                .join("；")}
      </p>
    </div>
  );
}
