import { CircleGeometry, type BufferGeometry } from "three";

import type { Vec3 } from "./math";

/**
 * 规整后的灯具 GLB 的格式（导入时写出，3D 舞台读取）。
 *
 * ```text
 * fixture            根节点，extras.artnetStudio = StudioExtras
 * ├─ base            底座 / 整个灯体（网格，米制，原点在安装点，Y 为光轴）
 * └─ pan             Pan 关节（原点，绕 Y 转）
 *    ├─ yoke         摇臂（网格）
 *    └─ tilt         Tilt 关节（位于灯头支点，绕 X 转）
 *       └─ head      灯头（网格，坐标相对支点）
 * ```
 *
 * 没有关节的模型只有 `base`。所有网格都带顶点色（材质颜色烘焙进顶点），不带纹理与 UV，
 * 这样同一型号的灯能共用一组实例网格，显存只占几何体。
 */

/** extras 里的键。 */
export const STUDIO_EXTRAS_KEY = "artnetStudio";

/** 规整格式的版本。 */
export const STUDIO_FORMAT_VERSION = 1;

/** 写在根节点 extras 里的信息。 */
export interface StudioExtras {
  version: number;
  /** 灯头支点（本地坐标，米） */
  headPivot?: Vec3;
  /** 光束起点：有关节时在灯头坐标里，否则在本地坐标里 */
  beamOrigin: Vec3;
  /** 发光面半径（米）；0 为不画 */
  lensRadius: number;
  /** 是否画光束 */
  emitsBeam: boolean;
}

/**
 * 朝 +Y 的圆形发光面，圆心在 `origin`。
 *
 * @param radius 半径（米）。
 * @param origin 圆心。
 * @returns 几何体。
 */
export function lensDiscAt(radius: number, origin: Vec3): BufferGeometry {
  const g = new CircleGeometry(radius, 16);
  g.rotateX(-Math.PI / 2);
  g.translate(origin[0], origin[1] + 0.001, origin[2]);
  g.deleteAttribute("uv");
  return g;
}
