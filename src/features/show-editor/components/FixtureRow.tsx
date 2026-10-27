import { useTranslation } from "react-i18next";
import { AlertTriangle, Copy, Crosshair, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toggleLocate } from "../hooks/transportActions";
import type { PatchStatus } from "../lib/patch";
import type { FixtureInstance } from "../lib/project";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { CommitInput } from "./CommitInput";

/** 默认模式在下拉框里的取值（Radix Select 不接受空串）。 */
const DEFAULT_MODE = "__default__";

interface FixtureRowProps {
  fixture: FixtureInstance;
  /** 模型名称（模型缺失时为空串） */
  modelName: string;
  /** 模型的附加模式（没有时不显示模式选择） */
  modes?: readonly { id: string; name: string; channels: number }[];
  /** 默认模式的名称与通道数 */
  defaultMode?: { name: string; channels: number };
  status: PatchStatus | undefined;
  selected: boolean;
  onSelectedChange: (on: boolean) => void;
  onRename: (name: string) => void;
  onAddress: (universe: number, address: number) => void;
  onMode?: (modeId: string | undefined) => void;
  onAddMirror?: () => void;
  onMirror?: (index: number, universe: number, address: number) => void;
  onRemoveMirror?: (index: number) => void;
  onDelete: () => void;
}

/** 一组 “U … @ …” 地址输入。 */
function AddressInputs({
  universe,
  address,
  universeLabel,
  addressLabel,
  onChange,
}: {
  universe: number;
  address: number;
  universeLabel: string;
  addressLabel: string;
  onChange: (universe: number, address: number) => void;
}) {
  return (
    <>
      <label className="flex items-center gap-1">
        U
        <CommitInput
          className="num h-7 w-14 px-1.5 text-xs"
          inputMode="numeric"
          label={universeLabel}
          value={universe}
          onCommit={(text) => onChange(Number(text), address)}
        />
      </label>
      <label className="flex items-center gap-1">
        @
        <CommitInput
          className="num h-7 w-14 px-1.5 text-xs"
          inputMode="numeric"
          label={addressLabel}
          value={address}
          onCommit={(text) => onChange(universe, Number(text))}
        />
      </label>
    </>
  );
}

/**
 * Patch 列表里的一个灯具：勾选框、名称、模型与通道模式、Universe 与地址、多重配接（镜像地址），以及冲突状态。
 */
export function FixtureRow({
  fixture,
  modelName,
  modes = [],
  defaultMode,
  status,
  selected,
  onSelectedChange,
  onRename,
  onAddress,
  onMode,
  onAddMirror,
  onMirror,
  onRemoveMirror,
  onDelete,
}: FixtureRowProps) {
  const { t } = useTranslation();
  const conflicts = status?.conflictsWith.length ?? 0;
  const problem = conflicts > 0 || status?.overflow === true || status?.missingModel === true;
  const range = status?.range;
  const locating = usePlaybackStore((s) => s.state?.locate === fixture.id);

  return (
    <li
      className={cn(
        "rounded-md border bg-card px-2 py-1.5",
        problem ? "border-destructive/60" : "border-border",
        selected && "ring-1 ring-primary",
      )}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-primary"
          checked={selected}
          onChange={(e) => onSelectedChange(e.target.checked)}
          aria-label={t("editor.patch.selectRow", { name: fixture.name })}
        />
        <CommitInput
          className="h-8 px-2 text-sm"
          label={t("editor.patch.nameOf", { name: fixture.name })}
          value={fixture.name}
          onCommit={onRename}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={locating ? "size-8 shrink-0 bg-primary/20 text-primary" : "size-8 shrink-0"}
          aria-label={t("editor.patch.locate", { name: fixture.name })}
          aria-pressed={locating}
          title={t("editor.patch.locate", { name: fixture.name })}
          onClick={() => void toggleLocate(fixture.id)}
        >
          <Crosshair aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t("editor.patch.deleteOne", { name: fixture.name })}
          title={t("editor.patch.deleteOne", { name: fixture.name })}
          onClick={onDelete}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-muted-foreground">
        <span className="max-w-32 truncate" title={modelName}>
          {modelName || fixture.modelId}
        </span>
        {modes.length > 0 && onMode && (
          <Select
            value={fixture.modeId ?? DEFAULT_MODE}
            onValueChange={(v) => onMode(v === DEFAULT_MODE ? undefined : v)}
          >
            <SelectTrigger className="h-7 w-auto min-w-24 gap-1 px-2 text-xs" aria-label={t("editor.patch.modeOf", { name: fixture.name })}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODE}>
                {t("editor.patch.modeOption", {
                  name: defaultMode?.name || t("editor.patch.defaultMode"),
                  count: defaultMode?.channels ?? 0,
                })}
              </SelectItem>
              {modes.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {t("editor.patch.modeOption", { name: m.name, count: m.channels })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <AddressInputs
          universe={fixture.universe}
          address={fixture.address}
          universeLabel={t("editor.patch.universeOf", { name: fixture.name })}
          addressLabel={t("editor.patch.addressOf", { name: fixture.name })}
          onChange={onAddress}
        />
        {range && (
          <span className="num">
            {range.start}–{range.end}
          </span>
        )}
        {onAddMirror && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("editor.patch.addMirror", { name: fixture.name })}
            title={t("editor.patch.addMirror", { name: fixture.name })}
            onClick={onAddMirror}
          >
            <Copy aria-hidden />
          </Button>
        )}
        {conflicts > 0 && (
          <Badge variant="destructive">
            <AlertTriangle className="size-3" aria-hidden />
            {t("editor.patch.conflict", { count: conflicts })}
          </Badge>
        )}
        {status?.overflow && (
          <Badge variant="destructive">
            <AlertTriangle className="size-3" aria-hidden />
            {t("editor.patch.overflow")}
          </Badge>
        )}
        {status?.missingModel && (
          <Badge variant="destructive">
            <AlertTriangle className="size-3" aria-hidden />
            {t("editor.patch.missingModel")}
          </Badge>
        )}
      </div>
      {(fixture.mirrors?.length ?? 0) > 0 && (
        <ol aria-label={t("editor.patch.mirrors", { name: fixture.name })} className="mt-1 flex flex-col gap-1 pl-6">
          {fixture.mirrors?.map((m, i) => {
            const r = status?.mirrors[i];
            return (
              <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="w-12 shrink-0">{t("editor.patch.mirrorN", { n: i + 1 })}</span>
                <AddressInputs
                  universe={m.universe}
                  address={m.address}
                  universeLabel={t("editor.patch.mirrorUniverseOf", { name: fixture.name, n: i + 1 })}
                  addressLabel={t("editor.patch.mirrorAddressOf", { name: fixture.name, n: i + 1 })}
                  onChange={(u, a) => onMirror?.(i, u, a)}
                />
                {r && (
                  <span className="num">
                    {r.start}–{r.end}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("editor.patch.removeMirror", { name: fixture.name, n: i + 1 })}
                  title={t("editor.patch.removeMirror", { name: fixture.name, n: i + 1 })}
                  onClick={() => onRemoveMirror?.(i)}
                >
                  <X aria-hidden />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}
