import { layoutOf, modelShape, type FixtureModel, type FixtureShape } from "@/features/fixtures";
import type { SheetRow } from "../lib/fixtureSheet";
import type { FixtureInstance, Rgb, StagePlacement } from "../lib/project";
import {
  beamAngleDeg,
  DEFAULT_PAN_RANGE,
  DEFAULT_TILT_RANGE,
  fixtureBasis,
  headAngles,
  type FixtureBasis,
  type HeadAngles,
  type Vec3,
} from "./math";
import { DEFAULT_BEAM_DEG, localDims } from "./shapes";
import { beamLookOf, beamStaticOf, type BeamLook, type BeamStatic } from "./beamLook";

/** 一台灯在 3D 舞台这一帧的样子。 */
export interface Fixture3D {
  id: string;
  name: string;
  /** 几何体组的键：`shape:<外形>` 或 `glb:<散列>` */
  template: string;
  shape: FixtureShape;
  /** 安装点（舞台坐标，米；z 从台面算起） */
  position: Vec3;
  basis: FixtureBasis;
  /** 本地尺寸（米，right / up / front） */
  dims: Vec3;
  /** 实际发出的颜色（sRGB，已含亮度） */
  rgb: Rgb;
  /** 摇头灯的灯头角度；不能动的灯为 `null` */
  head: HeadAngles | null;
  /** 光束角（度，已含光圈 / 雾化） */
  beamDeg: number;
  /** 图案、棱镜与柔化（颜色已乘上频闪 / 快门） */
  look: BeamLook;
  selected: boolean;
}

/** 一台灯的静态信息（不随播放头变化，按工程缓存）。 */
export interface FixtureStatic {
  id: string;
  name: string;
  shape: FixtureShape;
  /** 有 3D 文件且文件在资源库里时为它的散列 */
  model3d: string | null;
  /** 模型引用了 3D 文件但本机没有 */
  missing3d: boolean;
  placement: StagePlacement;
  basis: FixtureBasis;
  dims: Vec3;
  panRange: number;
  tiltRange: number;
  /** 有 Pan / Tilt 通道 */
  mover: boolean;
  /** 变焦通道标注的角度（`[起, 止]`） */
  zoomRange: readonly [number, number] | null;
  physical: FixtureModel["physical"];
  /** 图案 / 棱镜 / 快门等光束通道；没有时为 `null` */
  beam: BeamStatic | null;
}

/**
 * 每台灯的静态信息。
 *
 * @param fixtures 灯具实例。
 * @param models 模型（工程快照）。
 * @param placements 舞台位置（手动的或自动排布的）。
 * @param hasAsset 资源库里有没有某个 3D 文件。
 * @returns 与 `fixtures` 同序。
 */
export function fixtureStatics(
  fixtures: readonly FixtureInstance[],
  models: ReadonlyMap<string, FixtureModel>,
  placements: ReadonlyMap<string, StagePlacement>,
  hasAsset: (hash: string) => boolean,
): FixtureStatic[] {
  return fixtures.map((f) => {
    const model = models.get(f.modelId);
    const shape: FixtureShape = model ? modelShape(model) : "generic";
    const layout = model ? (layoutOf(model, f.modeId) ?? []) : [];
    const ref = model?.appearance?.model3d;
    const available = ref ? hasAsset(ref.hash) : false;
    const placement = f.stage ?? placements.get(f.id) ?? { x: 0, y: 0 };
    const zoom = layout.find((p) => p.function === "zoom");
    const zoomCap = zoom?.capabilities?.find((c) => c.unit === "deg" && c.physical !== undefined);
    return {
      id: f.id,
      name: f.name,
      shape,
      model3d: available && ref ? ref.hash : null,
      missing3d: ref !== undefined && !available,
      placement,
      basis: fixtureBasis(placement.rotation ?? 0, placement.pitch ?? 0, placement.hanging === true),
      dims: localDims(shape, model?.physical?.dimensionsMm),
      panRange: model?.physical?.panRangeDeg ?? DEFAULT_PAN_RANGE,
      tiltRange: model?.physical?.tiltRangeDeg ?? DEFAULT_TILT_RANGE,
      mover: layout.some((p) => p.function === "pan" || p.function === "tilt"),
      zoomRange: zoomCap?.physical ? [zoomCap.physical[0], zoomCap.physical[1]] : null,
      physical: model?.physical,
      beam: beamStaticOf(layout),
    };
  });
}

/**
 * 这一帧每台灯的样子。
 *
 * @param statics 静态信息。
 * @param colors 每台灯的颜色（灯具 id → sRGB）。
 * @param sheet 带 Pan / Tilt / 变焦的灯的通道值（灯具 id → 灯具表行）。
 * @param selected 选中的灯具 id。
 * @param tSec 播放头时间（秒）：频闪与图案旋转按它算，暂停时画面不变。
 * @returns 与 `statics` 同序。
 */
export function frameFixtures(
  statics: readonly FixtureStatic[],
  colors: ReadonlyMap<string, Rgb>,
  sheet: ReadonlyMap<string, SheetRow>,
  selected: ReadonlySet<string>,
  tSec = 0,
): Fixture3D[] {
  return statics.map((s) => {
    const cells = sheet.get(s.id)?.cells;
    const frac = (fn: "pan" | "tilt" | "zoom") => cells?.get(fn)?.fraction ?? null;
    const zoom = frac("zoom");
    const look = beamLookOf(s.beam, (fn) => cells?.get(fn), tSec);
    const rgb = colors.get(s.id) ?? [0, 0, 0];
    return {
      id: s.id,
      name: s.name,
      template: s.model3d ? `glb:${s.model3d}` : `shape:${s.shape}`,
      shape: s.shape,
      position: [s.placement.x, s.placement.y, s.placement.z ?? 0],
      basis: s.basis,
      dims: s.dims,
      rgb: look.gate === 1 ? rgb : [0, 0, 0],
      head: s.mover || s.shape === "movingHead" ? headAngles(frac("pan"), frac("tilt"), s.panRange, s.tiltRange) : null,
      beamDeg: Math.min(170, beamAngleDeg(s.physical, zoom, s.zoomRange, DEFAULT_BEAM_DEG[s.shape]) * look.angleScale),
      look,
      selected: selected.has(s.id),
    };
  });
}
