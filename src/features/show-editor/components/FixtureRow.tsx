import { useTranslation } from "react-i18next";
import { AlertTriangle, Crosshair, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toggleLocate } from "../hooks/transportActions";
import type { PatchStatus } from "../lib/patch";
import type { FixtureInstance } from "../lib/project";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { CommitInput } from "./CommitInput";

interface FixtureRowProps {
  fixture: FixtureInstance;
  /** 模型名称（模型缺失时为空串） */
  modelName: string;
  status: PatchStatus | undefined;
  selected: boolean;
  onSelectedChange: (on: boolean) => void;
  onRename: (name: string) => void;
  onAddress: (universe: number, address: number) => void;
  onDelete: () => void;
}

/** Patch 列表里的一个灯具：勾选框、名称、模型、Universe 与地址，以及冲突状态。 */
export function FixtureRow({
  fixture,
  modelName,
  status,
  selected,
  onSelectedChange,
  onRename,
  onAddress,
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
        <label className="flex items-center gap-1">
          U
          <CommitInput
            className="num h-7 w-14 px-1.5 text-xs"
            inputMode="numeric"
            label={t("editor.patch.universeOf", { name: fixture.name })}
            value={fixture.universe}
            onCommit={(text) => onAddress(Number(text), fixture.address)}
          />
        </label>
        <label className="flex items-center gap-1">
          @
          <CommitInput
            className="num h-7 w-14 px-1.5 text-xs"
            inputMode="numeric"
            label={t("editor.patch.addressOf", { name: fixture.name })}
            value={fixture.address}
            onCommit={(text) => onAddress(fixture.universe, Number(text))}
          />
        </label>
        {range && (
          <span className="num">
            {range.start}–{range.end}
          </span>
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
    </li>
  );
}
