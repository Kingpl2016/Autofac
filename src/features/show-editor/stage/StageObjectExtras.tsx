import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Anchor, Waypoints } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { announce } from "@/shared/stores/announcerStore";
import type { ScreenContent, StageObject } from "../lib/project";
import { DEFAULT_STAIR_STEPS, hangOnTruss, updateStageObject } from "../lib/stageOps";
import { useProjectStore } from "../stores/useProjectStore";
import { StageField } from "./StageField";

/** 屏幕内容 ↔ 下拉框取值。 */
const contentKey = (c: ScreenContent | undefined) => (!c ? "none" : c.kind === "media" ? `media:${c.mediaId}` : `fixture:${c.fixtureId}`);
function contentOf(key: string): ScreenContent | null {
  if (key.startsWith("media:")) return { kind: "media", mediaId: key.slice(6) };
  if (key.startsWith("fixture:")) return { kind: "fixture", fixtureId: key.slice(8) };
  return null;
}

/**
 * 布景物件按类型的额外字段：台阶的级数、多边形的边数（重新生成正多边形；顶点可在画布上拖动）、
 * LED 屏的内容（视频素材或像素灯）。其它类型不显示任何内容。
 */
export function StageObjectExtras({ object }: { object: StageObject }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const media = useProjectStore((s) => s.project.media);
  const fixtures = useProjectStore((s) => s.project.fixtures);
  const models = useProjectStore((s) => s.project.fixtureModels);

  if (object.kind === "stairs") {
    return (
      <StageField
        label={t("editor.stage.layout.steps")}
        value={object.steps ?? DEFAULT_STAIR_STEPS}
        unit={t("editor.stage.layout.stepsUnit")}
        onCommit={(v) => update((d) => updateStageObject(d, object.id, { steps: v }))}
      />
    );
  }
  if (object.kind === "polygon") {
    return (
      <>
        <StageField
          label={t("editor.stage.layout.sides")}
          value={object.points?.length ?? 0}
          unit={t("editor.stage.layout.sidesUnit")}
          onCommit={(v) => update((d) => updateStageObject(d, object.id, { sides: v }))}
        />
        <span className="text-[11px] text-muted-foreground">{t("editor.stage.layout.vertexHint")}</span>
      </>
    );
  }
  if (object.kind === "screen") {
    const videos = media.filter((m) => m.kind === "video");
    const pixelModels = new Set(models.filter((m) => m.matrix).map((m) => m.id));
    const pixels = fixtures.filter((f) => pixelModels.has(f.modelId));
    return (
      <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span aria-hidden>{t("editor.stage.layout.screenContent")}</span>
        <Select
          value={contentKey(object.content)}
          onValueChange={(key) => update((d) => updateStageObject(d, object.id, { content: contentOf(key) }))}
        >
          <SelectTrigger className="h-6 w-40 px-1.5 text-[11px]" aria-label={t("editor.stage.layout.screenContent")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("editor.stage.layout.screenNone")}</SelectItem>
            {videos.map((m) => (
              <SelectItem key={m.id} value={`media:${m.id}`}>
                {t("editor.stage.layout.screenMedia", { name: m.name })}
              </SelectItem>
            ))}
            {pixels.map((f) => (
              <SelectItem key={f.id} value={`fixture:${f.id}`}>
                {t("editor.stage.layout.screenFixture", { name: f.name })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    );
  }
  return null;
}

/**
 * 把选中的灯具挂到桁架上（落在桁架中线、高度取桁架底面、设为吊挂），可以沿桁架均分。
 * 舞台上没有桁架时不显示。
 */
export function TrussHangTools({ fixtureIds }: { fixtureIds: readonly string[] }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const objects = useProjectStore((s) => s.project.stage.objects);
  const trusses = objects.filter((o) => o.kind === "truss");
  const [picked, setPicked] = useState<string | null>(null);
  if (trusses.length === 0 || fixtureIds.length === 0) return null;
  const truss = trusses.find((o) => o.id === picked) ?? trusses[0];
  const name = (o: StageObject, i: number) => o.label || t("editor.stage.layout.trussN", { n: i + 1 });

  const hang = (distribute: boolean) => {
    update((d) => {
      hangOnTruss(d, fixtureIds, truss.id, distribute);
    });
    announce(t("editor.stage.layout.hung", { count: fixtureIds.length, truss: name(truss, trusses.indexOf(truss)) }));
  };

  return (
    <span role="group" aria-label={t("editor.stage.layout.hangGroup")} className="flex items-center gap-1">
      {trusses.length > 1 && (
        <Select value={truss.id} onValueChange={setPicked}>
          <SelectTrigger className="h-6 w-24 px-1.5 text-[11px]" aria-label={t("editor.stage.layout.hangTruss")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {trusses.map((o, i) => (
              <SelectItem key={o.id} value={o.id}>
                {name(o, i)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]" onClick={() => hang(false)}>
        <Anchor aria-hidden className="size-3" />
        {t("editor.stage.layout.hang")}
      </Button>
      {fixtureIds.length >= 2 && (
        <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]" onClick={() => hang(true)}>
          <Waypoints aria-hidden className="size-3" />
          {t("editor.stage.layout.hangDistribute")}
        </Button>
      )}
    </span>
  );
}
