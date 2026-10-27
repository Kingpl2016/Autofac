import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  applyPattern,
  groupSelection,
  invertSelection,
  modelSelection,
  ordered,
  stepSelection,
  trackSelection,
  type SelectionPattern,
} from "../lib/fixtureSelection";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";

/**
 * 灯具选择工具条：全选 / 清空 / 反选、奇偶、前后半、隔 N 选 1、逐个前进后退，
 * 以及按分组、按模型、按所选轨道选择。结果写入编辑器的“勾选灯具”（与 Patch 面板共用）。
 */
export function SelectionTools() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const selectedRaw = useEditorUiStore((s) => s.selectedFixtureIds);
  const selectedTrackId = useEditorUiStore((s) => s.selectedTrackId);
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const [every, setEvery] = useState({ n: 3, offset: 0 });

  const all = useMemo(() => project.fixtures.map((f) => f.id), [project.fixtures]);
  const selected = useMemo(() => ordered(all, selectedRaw), [all, selectedRaw]);
  const models = useMemo(() => {
    const used = new Set(project.fixtures.map((f) => f.modelId));
    return project.fixtureModels.filter((m) => used.has(m.id));
  }, [project.fixtures, project.fixtureModels]);

  const pattern = (p: SelectionPattern) => setSelected(applyPattern(all, selected, p));
  const button = (label: string, onClick: () => void, disabled = false) => (
    <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={disabled} onClick={onClick}>
      {label}
    </Button>
  );

  return (
    <section aria-label={t("editor.select.title")} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("editor.select.title")}</h3>
        <span role="status" className="num text-xs text-muted-foreground">
          {t("editor.select.count", { count: selected.length, total: all.length })}
        </span>
      </div>
      <div role="toolbar" aria-label={t("editor.select.toolbar")} className="flex flex-wrap gap-1">
        {button(t("editor.select.all"), () => setSelected(all), all.length === 0)}
        {button(t("editor.select.none"), () => setSelected([]), selected.length === 0)}
        {button(t("editor.select.invert"), () => setSelected(invertSelection(all, selected)), all.length === 0)}
        {button(t("editor.select.odd"), () => pattern({ kind: "odd" }), all.length === 0)}
        {button(t("editor.select.even"), () => pattern({ kind: "even" }), all.length < 2)}
        {button(t("editor.select.firstHalf"), () => pattern({ kind: "firstHalf" }), all.length < 2)}
        {button(t("editor.select.secondHalf"), () => pattern({ kind: "secondHalf" }), all.length < 2)}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-7"
          aria-label={t("editor.select.prev")}
          title={t("editor.select.prev")}
          disabled={all.length === 0}
          onClick={() => setSelected(stepSelection(all, selected, -1))}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-7"
          aria-label={t("editor.select.next")}
          title={t("editor.select.next")}
          disabled={all.length === 0}
          onClick={() => setSelected(stepSelection(all, selected, 1))}
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t("editor.select.every")}</span>
        <CommitInput
          className="num h-7 w-12 px-1.5 text-xs"
          inputMode="numeric"
          label={t("editor.select.everyN")}
          value={every.n}
          onCommit={(text) => {
            const n = Math.round(Number(text));
            if (Number.isFinite(n) && n >= 1 && n <= 64) setEvery((e) => ({ ...e, n }));
          }}
        />
        <span>{t("editor.select.everyOffset")}</span>
        <CommitInput
          className="num h-7 w-12 px-1.5 text-xs"
          inputMode="numeric"
          label={t("editor.select.everyOffsetLabel")}
          value={every.offset + 1}
          onCommit={(text) => {
            const n = Math.round(Number(text));
            if (Number.isFinite(n) && n >= 1 && n <= 64) setEvery((e) => ({ ...e, offset: n - 1 }));
          }}
        />
        {button(t("editor.select.apply"), () => pattern({ kind: "every", n: every.n, offset: every.offset }), all.length === 0)}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {project.groups.length > 0 && (
          <Select value="" onValueChange={(id) => setSelected(groupSelection(project, id))}>
            <SelectTrigger className="h-7 w-auto min-w-28 text-xs" aria-label={t("editor.select.byGroup")}>
              <SelectValue placeholder={t("editor.select.byGroup")} />
            </SelectTrigger>
            <SelectContent>
              {project.groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name} · {g.fixtureIds.length}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {models.length > 1 && (
          <Select value="" onValueChange={(id) => setSelected(modelSelection(project, id))}>
            <SelectTrigger className="h-7 w-auto min-w-28 text-xs" aria-label={t("editor.select.byModel")}>
              <SelectValue placeholder={t("editor.select.byModel")} />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {button(
          t("editor.select.fromTrack"),
          () => selectedTrackId && setSelected(trackSelection(project, selectedTrackId)),
          !selectedTrackId,
        )}
      </div>
    </section>
  );
}
