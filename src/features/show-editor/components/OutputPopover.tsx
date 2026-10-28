import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Cable, ChevronRight, Lock, Network, Plus, TriangleAlert, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { PlayerTargetPicker } from "@/features/recording";
import { MAX_GAMMA, MAX_LATENCY_COMP_MS, MIN_GAMMA, setOutput } from "../lib/ops";
import { DEFAULT_GAMMA } from "../lib/project";
import { MAX_PARK, removePark, setPark, setSync } from "../lib/universeOps";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { SliderField } from "./SliderField";
import { UniverseDialog } from "./UniverseDialog";

/**
 * 工具条上的输出设置。
 *
 * - 基本：输出目标（Art-Net / sACN 转发表或指定 IP）与 Universe 路由表入口；
 * - 高级（默认收起，展开状态会记住）：Gamma、灯光延迟补偿、同步（ArtSync / sACN 同步 Universe）、通道锁定（Park）。
 *   收起时标题旁列出改过默认值的项，避免“看不见的设置”。
 *
 * 改动立即写入工程（可撤销），并随工程同步给后端；输出会话运行中也会实时生效。
 */
export function OutputPopover() {
  const { t } = useTranslation();
  const output = useProjectStore((s) => s.project.output);
  const update = useProjectStore((s) => s.update);
  const warnings = usePlaybackStore((s) => s.state?.warnings.length ?? 0);
  const destinations = usePlaybackStore((s) => s.state?.destinations ?? 0);
  const outputting = usePlaybackStore((s) => s.state?.outputting ?? false);
  const advancedOpen = useEditorPrefsStore((s) => s.outputAdvancedOpen);
  const setAdvancedOpen = useEditorPrefsStore((s) => s.setOutputAdvancedOpen);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);

  // 收起时提示哪些高级设置不是默认值
  const changed = [
    output.gamma !== DEFAULT_GAMMA && t("editor.output.gammaShort", { value: output.gamma.toFixed(1) }),
    output.latencyCompMs !== 0 && t("editor.output.latencyShort", { value: output.latencyCompMs }),
    (output.sync.artSync || output.sync.sacnSyncUniverse !== null) && t("editor.output.syncShort"),
    output.park.length > 0 && t("editor.output.parkShort", { count: output.park.length }),
  ].filter((x): x is string => typeof x === "string");

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2" aria-label={t("editor.output.title")}>
            <Cable aria-hidden />
            <span className="text-xs">{t("editor.output.button")}</span>
            {outputting && <span className="size-1.5 rounded-full bg-primary" role="img" aria-label={t("editor.playback.outputting")} />}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="grid max-h-[80vh] w-96 gap-4 overflow-y-auto" aria-label={t("editor.output.title")}>
          <h3 className="text-sm font-medium">{t("editor.output.title")}</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 justify-start"
            onClick={() => {
              setPopoverOpen(false);
              setRoutingOpen(true);
            }}
          >
            <Network aria-hidden />
            {t("editor.output.openRouting")}
            {output.target.kind === "routed" && (
              <Badge variant="default" className="ml-auto">
                {t("editor.output.routedBadge", { count: output.universes.length })}
              </Badge>
            )}
          </Button>
          {output.target.kind === "routed" ? (
            <p className="text-xs text-muted-foreground">{t("editor.output.routedHint")}</p>
          ) : (
            <PlayerTargetPicker
              key={JSON.stringify(output.target)}
              target={output.target}
              destinations={destinations}
              onApply={(target) => update((d) => setOutput(d, { target }))}
            />
          )}
          {warnings > 0 && (
            <p className="flex items-start gap-2 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t("editor.output.skipped", { count: warnings })}
            </p>
          )}

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="grid gap-3 border-t border-border pt-3">
            <CollapsibleTrigger className="flex items-center gap-1.5 rounded-sm text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", advancedOpen && "rotate-90")} />
              {t("editor.output.advanced")}
              {!advancedOpen && changed.length > 0 && (
                <span className="min-w-0 truncate font-normal text-muted-foreground">· {changed.join(t("editor.output.listSep"))}</span>
              )}
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-4">
              <div className="grid gap-1">
                <SliderField
                  label={t("editor.output.gamma")}
                  numberLabel={t("editor.output.gammaValue")}
                  value={output.gamma}
                  min={MIN_GAMMA}
                  max={MAX_GAMMA}
                  step={0.1}
                  decimals={1}
                  onCommit={(gamma) => update((d) => setOutput(d, { gamma }))}
                />
                <p className="text-xs text-muted-foreground">{t("editor.output.gammaHint")}</p>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">{t("editor.output.latency")}</Label>
                <div className="flex items-center gap-2">
                  <CommitInput
                    className="num h-8 w-24 px-2 text-sm"
                    inputMode="numeric"
                    label={t("editor.output.latency")}
                    value={output.latencyCompMs}
                    onCommit={(text) => {
                      const n = Number(text);
                      if (Number.isFinite(n)) update((d) => setOutput(d, { latencyCompMs: n }));
                    }}
                  />
                  <span className="text-xs text-muted-foreground">ms（±{MAX_LATENCY_COMP_MS}）</span>
                </div>
                <p className="text-xs text-muted-foreground">{t("editor.output.latencyHint")}</p>
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-xs font-medium">{t("editor.routing.syncTitle")}</legend>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={output.sync.artSync} onCheckedChange={(artSync) => update((d) => setSync(d, { artSync }))} />
                  ArtSync
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-sm">{t("editor.routing.sacnSync")}</span>
                  <CommitInput
                    className="num h-7 w-20 px-2 text-xs"
                    inputMode="numeric"
                    label={t("editor.routing.sacnSync")}
                    value={output.sync.sacnSyncUniverse ?? ""}
                    onCommit={(text) => {
                      const n = Math.floor(Number(text));
                      update((d) => setSync(d, { sacnSyncUniverse: text.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n }));
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t("editor.routing.sacnSyncHint")}</p>
              </fieldset>
              <ParkEditor />
            </CollapsibleContent>
          </Collapsible>
        </PopoverContent>
      </Popover>
      <UniverseDialog open={routingOpen} onOpenChange={setRoutingOpen} />
    </>
  );
}

/** 通道锁定（Park）：列出已锁定的通道，可解除；按 Universe / 通道 / 值添加。 */
function ParkEditor() {
  const { t } = useTranslation();
  const park = useProjectStore((s) => s.project.output.park);
  const update = useProjectStore((s) => s.update);
  const [universe, setUniverse] = useState("0");
  const [channel, setChannel] = useState("1");
  const [value, setValue] = useState("255");

  const add = () => {
    const [u, c, v] = [Number(universe), Number(channel), Number(value)];
    if (![u, c, v].every(Number.isFinite)) return;
    update((d) => void setPark(d, { universe: u, channel: c, value: v }));
  };

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 flex items-center gap-1.5 text-xs font-medium">
        <Lock aria-hidden className="size-3.5" />
        {t("editor.output.park")}
      </legend>
      <p className="text-xs text-muted-foreground">{t("editor.output.parkHint")}</p>
      {park.length > 0 && (
        <ul aria-label={t("editor.output.parkList")} className="flex flex-wrap gap-1">
          {park.map((p) => (
            <li key={`${p.universe}.${p.channel}`} className="num flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pr-0.5 pl-2 text-xs">
              U{p.universe}.{p.channel} = {p.value}
              <button
                type="button"
                aria-label={t("editor.output.unpark", { universe: p.universe, channel: p.channel })}
                title={t("editor.output.unpark", { universe: p.universe, channel: p.channel })}
                onClick={() => update((d) => removePark(d, p.universe, p.channel))}
                className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <Input aria-label={t("editor.output.parkUniverse")} className="num h-7 w-14 px-2 text-xs" inputMode="numeric" value={universe} onChange={(e) => setUniverse(e.target.value)} />
        <span className="text-xs text-muted-foreground">.</span>
        <Input aria-label={t("editor.output.parkChannel")} className="num h-7 w-16 px-2 text-xs" inputMode="numeric" value={channel} onChange={(e) => setChannel(e.target.value)} />
        <span className="text-xs text-muted-foreground">=</span>
        <Input aria-label={t("editor.output.parkValue")} className="num h-7 w-16 px-2 text-xs" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={park.length >= MAX_PARK} onClick={add}>
          <Plus aria-hidden />
          {t("editor.output.parkAdd")}
        </Button>
      </div>
    </fieldset>
  );
}
