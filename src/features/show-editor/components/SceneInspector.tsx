import { type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Download, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { announce } from "@/shared/stores/announcerStore";
import { cssColor } from "../lib/cueTemplates";
import { setSceneEntries } from "../lib/cueOps";
import { layerGroupsOf } from "../lib/layers";
import { colorValueRgb, paramHead, resolveLook } from "../lib/looks";
import { hasProgrammerValues } from "../lib/programmer";
import type { SceneClip } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 场景片段的属性面板：列出片段里每台灯的外观（强度、颜色、用到的层组），可以移除某台灯；
 * “载入编程器”把整个场景放进编程器（同时选中这些灯）微调，“用编程器更新”再写回片段——
 * 这就是“同一帧给多台灯设不同值”的编辑闭环。
 *
 * @param props.cue 场景片段。
 */
export function SceneInspector({ cue }: { cue: SceneClip }) {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const values = useProgrammerStore((s) => s.values);
  const setValues = useProgrammerStore((s) => s.setValues);
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const setInspectorTab = useEditorUiStore((s) => s.setInspectorTab);
  const names = new Map(project.fixtures.map((f) => [f.id, f.name]));
  const locked = project.tracks.find((tr) => tr.id === cue.trackId)?.lock ?? false;

  const loadIntoProgrammer = () => {
    setValues(Object.fromEntries(cue.entries.map((e) => [e.fixtureId, structuredClone(e.look)])));
    setSelected(cue.entries.map((e) => e.fixtureId));
    setInspectorTab("program");
    announce(t("editor.scene.loaded", { count: cue.entries.length }));
  };

  const updateFromProgrammer = () => {
    const order = project.fixtures.map((f) => f.id);
    const entries = order.filter((id) => values[id] && hasProgrammerValues({ [id]: values[id] })).map((id) => ({ fixtureId: id, look: values[id] }));
    update((d) => void setSceneEntries(d, cue.id, entries));
    announce(t("editor.scene.updated", { count: entries.length }));
  };

  // 外层的分区（“场景条目”）提供标题与条目数
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={loadIntoProgrammer}>
          <Download aria-hidden />
          {t("editor.scene.load")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          disabled={locked || !hasProgrammerValues(values)}
          onClick={updateFromProgrammer}
        >
          <RefreshCw aria-hidden />
          {t("editor.scene.update")}
        </Button>
      </div>
      {cue.entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("editor.scene.empty")}</p>
      ) : (
        <ul className="grid gap-1">
          {cue.entries.map((e) => {
            const look = resolveLook(e.look, project.presets);
            const intensity = paramHead(look.intensity);
            const color = paramHead(look.color);
            const name = names.get(e.fixtureId) ?? t("editor.timeline.missingTarget");
            return (
              <li key={e.fixtureId} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
                <span
                  aria-hidden
                  className="size-4 shrink-0 rounded-sm border border-border bg-(--entry)"
                  style={{ "--entry": color ? cssColor(colorValueRgb(color)) : "transparent" } as CSSProperties}
                />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="num text-muted-foreground">{intensity !== undefined ? `${Math.round(intensity)}%` : "—"}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {layerGroupsOf(e.look).map((g) => t(`fixtures.groups.${g}`)).join(" · ")}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  disabled={locked}
                  aria-label={t("editor.scene.remove", { name })}
                  title={t("editor.scene.remove", { name })}
                  onClick={() =>
                    update((d) => void setSceneEntries(d, cue.id, cue.entries.filter((x) => x.fixtureId !== e.fixtureId)))
                  }
                >
                  <X aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
