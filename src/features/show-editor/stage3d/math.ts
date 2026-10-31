/**
 * 3D 舞台的几何（纯函数，不依赖 three.js，单元测试覆盖）。
 *
 * 舞台坐标：米，原点在舞台前沿中央，x 向右（观众视角）、y 向后、z 向上（从台面算起）。
 * three.js 用 Y 向上：`(x, y, z)舞台 → (x, z, -y)场景`，观众在场景的 +Z 一侧。
 *
 * 灯具的本地坐标系：
 * - `up`：从底座指向灯头（站立为 +z，吊挂为 -z），Pan 绕它转，Tilt 为 0.5 时光束沿它射出；
 * - `front`：水平朝向（`rotation` 为 0 时朝观众，即 -y；正角度转向 +x，与 2D 舞台一致）；
 * - `right = up × front`（`right, up, front` 构成右手系，几何体的本地 X / Y / Z 轴依次对应它们）。
 * 俯仰 `pitch` 把 `up` 朝 `front` 方向倾斜（正值），整个本地坐标系一起转。
 */

/** 三维向量。 */
export type Vec3 = readonly [number, number, number];

/** 灯具的本地坐标系（舞台坐标，单位向量）。 */
export interface FixtureBasis {
  up: Vec3;
  front: Vec3;
  right: Vec3;
}

const DEG = Math.PI / 180;

/** 默认的 Tilt 总行程（度）：模型没有物理参数时。 */
export const DEFAULT_TILT_RANGE = 270;
/** 默认的 Pan 总行程（度）。 */
export const DEFAULT_PAN_RANGE = 540;
/** 光束最远画多长（米）：打不到地面（朝上、朝远处）时。 */
export const MAX_BEAM_M = 25;

/** 向量加法。 */
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** 数乘。 */
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
/** 点积。 */
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** 叉积。 */
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * 归一化。
 *
 * @param a 向量。
 * @returns 单位向量；零向量原样返回。
 */
export function normalize(a: Vec3): Vec3 {
  const n = Math.hypot(a[0], a[1], a[2]);
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : a;
}

/**
 * 舞台坐标 → three.js 场景坐标。
 *
 * @param p 舞台坐标（米）。
 * @returns 场景坐标 `[x, z, -y]`。
 */
export function toScene(p: Vec3): Vec3 {
  return [p[0], p[2], -p[1]];
}

/**
 * 灯具的本地坐标系。
 *
 * @param rotationDeg 水平朝向（度，0 朝观众，正角度转向 +x）。
 * @param pitchDeg 俯仰安装角（度，正值让 `up` 朝 `front` 倾斜）。
 * @param hanging 吊挂（`up` 朝下）。
 * @returns 本地坐标系。
 */
export function fixtureBasis(rotationDeg: number, pitchDeg: number, hanging: boolean): FixtureBasis {
  const a = rotationDeg * DEG;
  // 与 2D 舞台一致：画布上的方向 (sin a, cos a)，画布 y 向下 = 舞台 -y
  const flat: Vec3 = [Math.sin(a), -Math.cos(a), 0];
  const up0: Vec3 = [0, 0, hanging ? -1 : 1];
  const p = pitchDeg * DEG;
  // 绕 right 轴旋转：up 朝 front 倾斜，front 随之转离水平面
  const up = normalize(add(scale(up0, Math.cos(p)), scale(flat, Math.sin(p))));
  const front = normalize(add(scale(flat, Math.cos(p)), scale(up0, -Math.sin(p))));
  return { up, front, right: normalize(cross(up, front)) };
}

/**
 * 绕单位轴旋转向量（罗德里格斯公式）。
 *
 * @param v 向量。
 * @param axis 单位轴。
 * @param angle 角度（弧度，右手定则）。
 * @returns 旋转后的向量。
 */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = dot(axis, v) * (1 - c);
  const x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
}

/** Pan / Tilt 转成的角度（弧度）：Pan 绕 `up`，Tilt 让光束从 `up` 朝摇臂前方倾斜。 */
export interface HeadAngles {
  pan: number;
  tilt: number;
}

/**
 * Pan / Tilt 通道值（0~1，0.5 为中位）换算成角度。
 *
 * 与 2D 舞台一致：Pan 增大时光束从朝向转向 +x（站立时绕 +z 正转）；吊挂时 `up` 朝下，同样的角度在俯视里反向，
 * 等同于 2D 舞台对吊挂灯用 `1 - pan`。
 *
 * @param pan Pan（0~1）；没有 Pan 通道时为 `null`（取中位）。
 * @param tilt Tilt（0~1）；没有时为 `null`。
 * @param panRangeDeg Pan 总行程（度）。
 * @param tiltRangeDeg Tilt 总行程（度）。
 * @returns 角度（弧度）。
 */
export function headAngles(pan: number | null, tilt: number | null, panRangeDeg: number, tiltRangeDeg: number): HeadAngles {
  return {
    pan: ((pan ?? 0.5) - 0.5) * panRangeDeg * DEG,
    tilt: ((tilt ?? 0.5) - 0.5) * tiltRangeDeg * DEG,
  };
}

/**
 * 光束方向（舞台坐标，单位向量）。
 *
 * @param basis 灯具本地坐标系。
 * @param angles Pan / Tilt 角度；不能动的灯传 `{ pan: 0, tilt: 0 }`。
 * @returns 方向。
 */
export function beamDirection(basis: FixtureBasis, angles: HeadAngles): Vec3 {
  // 先在本地坐标系里让 up 朝 front 倾斜 tilt，再整体绕 up 转 pan
  const tilted = add(scale(basis.up, Math.cos(angles.tilt)), scale(basis.front, Math.sin(angles.tilt)));
  return normalize(rotateAbout(tilted, basis.up, angles.pan));
}

/**
 * 光束与台面（或观众区地面）的交点。
 *
 * @param origin 光束起点（舞台坐标）。
 * @param dir 方向（单位向量）。
 * @param floorZ 地面高度（台面为 0；台口外的观众区地面为负的台高）。
 * @param maxLength 最远距离（米）。
 * @returns 距离与交点；朝上或超过最远距离时为 `null`。
 */
export function floorHit(origin: Vec3, dir: Vec3, floorZ = 0, maxLength = MAX_BEAM_M): { distance: number; point: Vec3 } | null {
  if (dir[2] > -1e-4) return null;
  const distance = (floorZ - origin[2]) / dir[2];
  if (distance <= 0 || distance > maxLength) return null;
  return { distance, point: add(origin, scale(dir, distance)) };
}

/**
 * 光束张角（度）：按变焦通道在模型的最小 / 最大光束角之间插值。
 *
 * @param physical 模型的物理参数。
 * @param zoom 变焦（0~1）；没有变焦通道时为 `null`。
 * @param zoomRange 变焦通道能力区间上标注的角度（`[起, 止]`），优先于物理参数。
 * @param fallbackDeg 都没有时的光束角。
 * @returns 光束角（度，夹在 1~120）。
 */
export function beamAngleDeg(
  physical: { beamMinDeg?: number; beamMaxDeg?: number } | undefined,
  zoom: number | null,
  zoomRange: readonly [number, number] | null,
  fallbackDeg: number,
): number {
  const clampDeg = (v: number) => Math.min(120, Math.max(1, v));
  if (zoom !== null && zoomRange) return clampDeg(zoomRange[0] + (zoomRange[1] - zoomRange[0]) * zoom);
  const lo = physical?.beamMinDeg;
  const hi = physical?.beamMaxDeg ?? lo;
  if (lo === undefined || hi === undefined) return clampDeg(fallbackDeg);
  return clampDeg(zoom === null ? (lo + hi) / 2 : lo + (hi - lo) * zoom);
}

/**
 * 光斑在地面上的椭圆：半径按距离与张角，斜射时沿光束的水平方向拉长。
 *
 * @param dir 光束方向（单位向量）。
 * @param distance 到地面的距离（米）。
 * @param angleDeg 光束角（度）。
 * @returns 短半径、长半径（米，长轴最多拉长 4 倍）与长轴的水平方向角（弧度，舞台平面里从 +x 逆时针）。
 */
export function spotEllipse(dir: Vec3, distance: number, angleDeg: number): { minor: number; major: number; heading: number } {
  const minor = distance * Math.tan((angleDeg * DEG) / 2);
  const incidence = Math.max(0.25, Math.abs(dir[2]));
  return { minor, major: minor / incidence, heading: Math.atan2(dir[1], dir[0]) };
}
