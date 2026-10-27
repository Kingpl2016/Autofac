import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Lock, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import type { Device } from "@/shared/domain/device";
import { cn } from "@/lib/utils";
import { SourcePicker } from "./SourcePicker";
import { UniverseTokenInput } from "./UniverseTokenInput";
import {
  ALL_PROTOCOLS,
  MAX_TEMPLATE_LENGTH,
  hasIndexPlaceholder,
  isPresetFiltered,
  presetToFilter,
  protocolName,
} from "../lib/recordingPreset";
import type { SourceStat } from "../lib/types";
import { useRecordingPreset, useRecordingPresetStore } from "../stores/useRecordingPresetStore";

const FIELD_LABEL = "text-xs font-medium text-muted-foreground";

interface RecordSetupProps {
  /** 当前检测到的来源 */
  sources: SourceStat[];
  /** 设备发现结果，用于显示设备名 */
  devices: Device[];
  /** 是否启用 sACN（关闭时隐藏协议过滤） */
  sacnEnabled: boolean;
  /** 录制中：整块收成只读摘要 */
  recording: boolean;
  /** 仅本次有效的备注（受控） */
  notes: string;
  onNotesChange: (value: string) => void;
  /** 下一次录制的节目名称（已按模板与序号渲染） */
  nextName: string;
}

/**
 * 录制设置：按“来源 → Universe → 协议 → 命名”分段编辑当前录制预设，每段标题旁给出即时摘要。
 * 预设由录制页、顶栏录制按钮与全局快捷键共用，修改即时生效并持久化；备注只对本次录制有效。
 * 录制中不可修改，整块收成一份只读摘要，把空间让给监看区。
 */
export function RecordSetup({
  sources,
  devices,
  sacnEnabled,
  recording,
  notes,
  onNotesChange,
  nextName,
}: RecordSetupProps) {
  const { t } = useTranslation();
  const preset = useRecordingPreset();
  const store = useRecordingPresetStore.getState;
  const filtered = isPresetFiltered(preset, sacnEnabled);
  const filter = presetToFilter(preset, sacnEnabled);

  const n = preset.sources.length;
  const sourcesSummary =
    n === 0
      ? t("recording.sourcesAll")
      : preset.excludeSources
        ? t("recording.sourcesExcluding", { n })
        : t("recording.sourcesOnly", { n });
  const universesSummary =
    preset.universeTokens.length === 0
      ? t("recording.presetUniversesAll")
      : t("recording.presetUniverses", { list: preset.universeTokens.join(", ") });
  const protocolSummary =
    filter.protocols.length === 0
      ? t("recording.protocolAll")
      : t("recording.presetProtocolOnly", { name: filter.protocols.map(protocolName).join(" + ") });
  const nameSummary = nextName || t("recording.nameTimestampOnly");

  if (recording) {
    return (
      <SurfacePanel
        title={t("recording.settingsCard")}
        actions={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" aria-hidden />
            {t("recording.setupLocked")}
          </span>
        }
      >
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
          <SummaryRow label={t("recording.sourcesTitle")} value={sourcesSummary} />
          <SummaryRow label={t("recording.universeTitle")} value={universesSummary} />
          {preset.extraTokens.length > 0 && (
            <SummaryRow label={t("recording.extraUniverses")} value={preset.extraTokens.join(", ")} />
          )}
          {sacnEnabled && <SummaryRow label={t("recording.protocolFilter")} value={protocolSummary} />}
          {notes.trim() && <SummaryRow label={t("recording.notesOnce")} value={notes.trim()} />}
        </dl>
      </SurfacePanel>
    );
  }

  return (
    <SurfacePanel
      title={t("recording.settingsCard")}
      actions={
        <Button
          variant="ghost"
          size="sm"
          disabled={!filtered && preset.extraTokens.length === 0}
          onClick={() => store().resetFilters()}
        >
          <RotateCcw aria-hidden />
          {t("recording.resetFilters")}
        </Button>
      }
    >
      <div className="grid gap-6">
        <SetupSection
          step={1}
          id="rec-step-sources"
          title={t("recording.sourcesTitle")}
          summary={sourcesSummary}
          actions={
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={preset.excludeSources}
                onCheckedChange={(on) => store().setExcludeSources(on)}
              />
              {t("recording.excludeMode")}
            </label>
          }
        >
          <SourcePicker
            sources={sources}
            devices={devices}
            selected={preset.sources}
            onToggle={(ip) => store().toggleSource(ip)}
          />
        </SetupSection>

        <SetupSection
          step={2}
          id="rec-step-universes"
          title={t("recording.universeTitle")}
          summary={universesSummary}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <Label htmlFor="rec-range" className={FIELD_LABEL}>
                {t("recording.universeFilter")}
              </Label>
              <UniverseTokenInput
                id="rec-range"
                label={t("recording.universeFilter")}
                tokens={preset.universeTokens}
                onChange={(tokens) => store().setUniverseTokens(tokens)}
                placeholder="0-3, 10"
                hintId="rec-range-hint"
              />
              <p id="rec-range-hint" className="text-xs text-muted-foreground">
                {t("recording.universeFilterHint")}
              </p>
            </div>
            <div className="grid content-start gap-1.5">
              <Label htmlFor="rec-extra" className={FIELD_LABEL}>
                {t("recording.extraUniverses")}
              </Label>
              <UniverseTokenInput
                id="rec-extra"
                label={t("recording.extraUniverses")}
                tokens={preset.extraTokens}
                onChange={(tokens) => store().setExtraTokens(tokens)}
                placeholder="5, 8-9"
                hintId="rec-extra-hint"
              />
              <p id="rec-extra-hint" className="text-xs text-muted-foreground">
                {t("recording.extraUniversesHint")}
              </p>
            </div>
          </div>
        </SetupSection>

        {sacnEnabled && (
          <SetupSection
            step={3}
            id="rec-step-protocols"
            title={t("recording.protocolFilter")}
            summary={protocolSummary}
          >
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby="rec-step-protocols">
              {ALL_PROTOCOLS.map((p) => {
                const checked = preset.protocols.includes(p);
                // 至少保留一个协议：唯一选中的那个不能取消
                const locked = checked && preset.protocols.length === 1;
                return (
                  <label
                    key={p}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border px-4 text-sm transition-colors duration-150 motion-reduce:transition-none",
                      "hover:bg-surface-3",
                      "has-data-[state=checked]:border-primary/60 has-data-[state=checked]:bg-primary/10",
                      locked && "cursor-not-allowed",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={locked}
                      onCheckedChange={() => store().toggleProtocol(p)}
                    />
                    {protocolName(p)}
                  </label>
                );
              })}
            </div>
          </SetupSection>
        )}

        <SetupSection
          step={sacnEnabled ? 4 : 3}
          id="rec-step-naming"
          title={t("recording.namingTitle")}
          summary={t("recording.nextNameSummary", { name: nameSummary })}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid content-start gap-1.5">
              <Label htmlFor="rec-name" className={FIELD_LABEL}>
                {t("recording.name")}
              </Label>
              <Input
                id="rec-name"
                value={preset.nameTemplate}
                maxLength={MAX_TEMPLATE_LENGTH}
                placeholder={t("recording.namePlaceholder")}
                aria-describedby="rec-name-hint"
                onChange={(e) => store().setNameTemplate(e.target.value)}
              />
              <div id="rec-name-hint" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{t("recording.nameTemplateHint")}</span>
                {hasIndexPlaceholder(preset.nameTemplate) && (
                  <span className="flex items-center gap-1">
                    <span className="num">{t("recording.nextIndex", { n: preset.nextIndex })}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={preset.nextIndex === 1}
                      onClick={() => store().resetIndex()}
                    >
                      {t("recording.resetIndex")}
                    </Button>
                  </span>
                )}
              </div>
            </div>
            <div className="grid content-start gap-1.5">
              <Label htmlFor="rec-notes" className={FIELD_LABEL}>
                {t("recording.notesOnce")}
              </Label>
              <Input
                id="rec-notes"
                value={notes}
                onChange={(e) => onNotesChange(e.target.value)}
              />
            </div>
          </div>
        </SetupSection>
      </div>
    </SurfacePanel>
  );
}

interface SetupSectionProps {
  step: number;
  id: string;
  title: string;
  /** 标题旁的即时摘要 */
  summary: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** 设置分段：编号 + 标题 + 即时摘要 + 可选操作。 */
function SetupSection({ step, id, title, summary, actions, children }: SetupSectionProps) {
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="num flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-muted-foreground"
            aria-hidden
          >
            {step}
          </span>
          <h3 id={id} className="text-sm font-medium">
            {title}
          </h3>
          <span className="truncate text-xs text-muted-foreground">{summary}</span>
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** 只读摘要的一行。 */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate" title={value}>
        {value}
      </dd>
    </div>
  );
}
