import { useMemo } from "react";

import { useFixtureAssetStore } from "@/features/fixtures";
import { useEngine } from "../engine/useEngine";
import { usePreviewProject } from "../hooks/usePreviewProject";
import { createPreviewEvaluator } from "../lib/color";
import { createDmxEvaluator } from "../lib/dmxPreview";
import { baseOf } from "../lib/fixtureRef";
import { buildSheet, type SheetRow } from "../lib/fixtureSheet";
import type { Rgb } from "../lib/project";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { placeFixtures } from "../stage/stageGeometry";
import { fixtureStatics, frameFixtures, type Fixture3D, type FixtureStatic } from "./frame";

/** 3D 舞台这一帧的数据。 */
export interface Stage3DFrameData {
  fixtures: Fixture3D[];
  statics: FixtureStatic[];
  /** 引用了 3D 文件但本机资源库里没有的型号数 */
  missingModels: number;
  /** 这一帧的预览颜色（含像素灯每个像素的 `灯具id#n`，LED 屏显示像素灯时用） */
  colors: ReadonlyMap<string, Rgb>;
}

/**
 * 3D 舞台每一帧的灯具数据：与 2D 舞台同一份预览求值（WASM 引擎、叠加编程器）。
 *
 * 颜色每帧按播放头求一次；只为带 Pan / Tilt / 变焦的灯生成灯具表（其余的灯每帧不做通道换算）。
 * 位置、朝向、尺寸等静态信息按工程缓存。
 *
 * @returns 帧数据。
 */
export function useStage3DFrame(): Stage3DFrameData {
  const project = useProjectStore((s) => s.project);
  const preview = usePreviewProject();
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const selectedIds = useEditorUiStore((s) => s.selectedFixtureIds);
  const values = useProgrammerStore((s) => s.values);
  const byHash = useFixtureAssetStore((s) => s.byHash);
  const engine = useEngine();

  const colorsAt = useMemo(() => createPreviewEvaluator(preview, engine), [preview, engine]);
  const dmxAt = useMemo(() => createDmxEvaluator(preview, engine), [preview, engine]);
  const statics = useMemo(() => {
    const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
    const placements = placeFixtures(project.fixtures, project.stage);
    return fixtureStatics(project.fixtures, models, placements, (h) => byHash.get(h)?.kind === "model");
  }, [project.fixtures, project.fixtureModels, project.stage, byHash]);
  const missingModels = useMemo(() => {
    const ids = new Set<string>();
    for (const m of project.fixtureModels) if (m.appearance?.model3d && !byHash.has(m.appearance.model3d.hash)) ids.add(m.id);
    return ids.size;
  }, [project.fixtureModels, byHash]);
  // 需要读通道值的灯：能动的、有变焦通道的，或有图案 / 棱镜 / 快门等光束通道的
  const dynamicIds = useMemo(
    () => new Set(statics.filter((s) => s.mover || s.zoomRange || s.physical?.beamMaxDeg || s.beam).map((s) => s.id)),
    [statics],
  );

  const colors = colorsAt(playheadMs);
  const frames = new Map<number, Uint8Array>();
  const sheetFixtures = project.fixtures.filter((f) => dynamicIds.has(f.id));
  const sheet = new Map<string, SheetRow>(
    sheetFixtures.length === 0
      ? []
      : buildSheet(
          { fixtures: sheetFixtures, fixtureModels: project.fixtureModels },
          (u) => {
            let f = frames.get(u);
            if (!f) {
              f = dmxAt(playheadMs, u);
              frames.set(u, f);
            }
            return f;
          },
          values,
        ).map((r) => [r.fixtureId, r]),
  );
  const selected = new Set(selectedIds.map(baseOf));
  return { fixtures: frameFixtures(statics, colors, sheet, selected, playheadMs / 1000), statics, missingModels, colors };
}
