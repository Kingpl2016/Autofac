import { BoxGeometry, BufferAttribute, CircleGeometry, CylinderGeometry, PlaneGeometry, type BufferGeometry } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { FixtureShape } from "@/features/fixtures";
import type { Vec3 } from "./math";

/**
 * 灯具的几何体组：底座（不动）、摇臂（随 Pan 绕光轴转）、灯头（随 Pan + Tilt 转，绕灯头支点）。
 *
 * 本地坐标：X = right、Y = up（光轴）、Z = front，原点在安装点（站立时是底座底面中心）。
 * 程序生成的外形是单位尺寸（宽高深各为 1），按模型尺寸逐实例缩放；导入的 GLB 已规整为米，不再缩放。
 * 几何体都带顶点色（程序外形为统一的灯体灰），所有灯共用一个灯体材质。
 */
export interface FixtureMeshSet {
  /** 底座（摇头灯）或整个灯体（其它外形） */
  base: BufferGeometry;
  /** 摇臂（只有摇头灯） */
  yoke?: BufferGeometry;
  /** 灯头（只有摇头灯；坐标相对灯头支点） */
  head?: BufferGeometry;
  /** 发光面（透镜 / LED 面）：在 `head` 里（摇头灯）或 `base` 里（其它） */
  lens?: BufferGeometry;
  /** 灯头支点（本地坐标） */
  headPivot: Vec3;
  /** 光束起点：摇头灯在灯头坐标里，其它在本地坐标里 */
  beamOrigin: Vec3;
  /** 是否发出光束（烟机、激光不画光锥） */
  emitsBeam: boolean;
  /** 是否按模型尺寸缩放（程序外形为 `true`） */
  unit: boolean;
  /** 三角面数（统计用） */
  tris: number;
}

/** 灯体灰（顶点色，线性前的 sRGB 0~1）。 */
const BODY: Vec3 = [0.16, 0.17, 0.19];
/** 圆柱的分段数（低面数，内存与绘制都省）。 */
const SEGMENTS = 16;

/** 给几何体加统一的顶点色，并去掉不需要的 uv（合并时各部分的属性要一致）。 */
function painted(g: BufferGeometry, rgb: Vec3 = BODY): BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo !== g) g.dispose();
  geo.deleteAttribute("uv");
  const n = geo.getAttribute("position").count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) colors.set(rgb, i * 3);
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  return geo;
}

/** 合并若干部分（合并后释放原几何体）。 */
function merged(parts: BufferGeometry[]): BufferGeometry {
  const ps = parts.map((p) => painted(p));
  const out = mergeGeometries(ps);
  for (const p of ps) p.dispose();
  if (!out) throw new Error("mergeGeometries failed");
  return out;
}

/** 朝 +Y 的圆形发光面。 */
function lensDisc(radius: number, y: number): BufferGeometry {
  const g = new CircleGeometry(radius, SEGMENTS);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return painted(g, [1, 1, 1]);
}

/** 朝 +Y 的矩形发光面。 */
function lensRect(w: number, d: number, y: number): BufferGeometry {
  const g = new PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return painted(g, [1, 1, 1]);
}

/** 盒子（中心在 `(x, y, z)`）。 */
function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** 沿 Y 的圆柱（中心在 `y`）。 */
function cylinder(rTop: number, rBottom: number, h: number, y: number): BufferGeometry {
  const g = new CylinderGeometry(rTop, rBottom, h, SEGMENTS);
  g.translate(0, y, 0);
  return g;
}

const trisOf = (...gs: (BufferGeometry | undefined)[]) =>
  gs.reduce((n, g) => n + (g ? (g.index ? g.index.count : g.getAttribute("position").count) / 3 : 0), 0);

/** 灯头支点的高度（单位尺寸）。 */
const HEAD_PIVOT = 0.62;

function movingHead(): FixtureMeshSet {
  const base = merged([box(1, 0.22, 0.8, 0, 0.11, 0)]);
  const yoke = merged([box(0.96, 0.06, 0.32, 0, 0.25, 0), box(0.1, 0.5, 0.3, -0.43, 0.5, 0), box(0.1, 0.5, 0.3, 0.43, 0.5, 0)]);
  // 灯头：沿光轴的圆筒，坐标相对支点
  const head = merged([cylinder(0.32, 0.3, 0.62, 0), box(0.76, 0.12, 0.12, 0, 0, 0)]);
  const lens = lensDisc(0.28, 0.312);
  return { base, yoke, head, lens, headPivot: [0, HEAD_PIVOT, 0], beamOrigin: [0, 0.32, 0], emitsBeam: true, unit: true, tris: trisOf(base, yoke, head, lens) };
}

/** 只有灯体的外形：灯体 + 顶部发光面，光束从顶部射出。 */
function fixed(body: BufferGeometry[], lens: BufferGeometry | undefined, emitsBeam = true): FixtureMeshSet {
  const base = merged(body);
  return { base, lens, headPivot: [0, 0, 0], beamOrigin: [0, 1, 0], emitsBeam, unit: true, tris: trisOf(base, lens) };
}

/** 各外形的程序几何体（单位尺寸）。 */
const BUILDERS: Record<FixtureShape, () => FixtureMeshSet> = {
  movingHead,
  scanner: () => fixed([box(1, 0.8, 1, 0, 0.4, 0), box(0.5, 0.2, 0.5, 0, 0.9, 0)], lensDisc(0.2, 1.001)),
  par: () => fixed([cylinder(0.5, 0.42, 1, 0.5), box(1.05, 0.06, 0.12, 0, 0.35, 0)], lensDisc(0.44, 1.001)),
  wash: () => fixed([box(1, 1, 1, 0, 0.5, 0)], lensRect(0.88, 0.88, 1.001)),
  profile: () => fixed([cylinder(0.32, 0.5, 0.75, 0.375), cylinder(0.36, 0.36, 0.25, 0.875)], lensDisc(0.3, 1.001)),
  bar: () => fixed([box(1, 1, 1, 0, 0.5, 0)], lensRect(0.96, 0.7, 1.001)),
  pixelPanel: () => fixed([box(1, 1, 1, 0, 0.5, 0)], lensRect(0.94, 0.94, 1.001)),
  strobe: () => fixed([box(1, 1, 1, 0, 0.5, 0)], lensRect(0.9, 0.7, 1.001)),
  blinder: () => fixed([box(1, 1, 1, 0, 0.5, 0)], lensRect(0.9, 0.9, 1.001)),
  fogger: () => fixed([box(1, 1, 1, 0, 0.5, 0), cylinder(0.08, 0.08, 0.2, 1.05)], undefined, false),
  laser: () => fixed([box(1, 1, 1, 0, 0.5, 0)], lensDisc(0.12, 1.001), false),
  generic: () => fixed([box(1, 1, 1, 0, 0.5, 0)], lensDisc(0.3, 1.001)),
};

/**
 * 生成一种外形的几何体组（调用方负责缓存与释放）。
 *
 * @param shape 外形模板。
 * @returns 几何体组（单位尺寸）。
 */
export function buildShape(shape: FixtureShape): FixtureMeshSet {
  return BUILDERS[shape]();
}

/** 外形的默认尺寸（毫米，`[宽, 高, 深]` 按 OFL 的含义：灯具正常摆放时的宽、高、深）。 */
const DEFAULT_DIMS_MM: Record<FixtureShape, Vec3> = {
  movingHead: [350, 550, 300],
  scanner: [300, 250, 700],
  par: [250, 250, 300],
  wash: [400, 400, 150],
  profile: [250, 300, 700],
  bar: [1000, 100, 100],
  pixelPanel: [500, 500, 100],
  strobe: [500, 150, 150],
  blinder: [400, 400, 150],
  fogger: [300, 250, 500],
  laser: [200, 150, 300],
  generic: [300, 300, 300],
};

/** 光轴沿灯具“深”方向的外形（OFL 尺寸的深度是镜头朝向）：本地 Y（光轴）取深度。 */
const BEAM_ALONG_DEPTH: ReadonlySet<FixtureShape> = new Set<FixtureShape>(["par", "wash", "profile", "bar", "pixelPanel", "strobe", "blinder", "laser"]);

/**
 * 本地坐标系里的尺寸（米，`[right, up, front]`）。
 *
 * @param shape 外形模板。
 * @param dimensionsMm 模型的尺寸（OFL 含义的宽、高、深，毫米）；省略时用外形的默认尺寸。
 * @returns 尺寸（米）。
 */
export function localDims(shape: FixtureShape, dimensionsMm: readonly [number, number, number] | undefined): Vec3 {
  const [w, h, d] = (dimensionsMm ?? DEFAULT_DIMS_MM[shape]).map((v) => Math.min(5000, Math.max(20, v)) / 1000);
  return BEAM_ALONG_DEPTH.has(shape) ? [w, d, h] : [w, h, d];
}

/** 外形的默认光束角（度）：模型没有物理参数时。 */
export const DEFAULT_BEAM_DEG: Record<FixtureShape, number> = {
  movingHead: 18,
  scanner: 14,
  par: 30,
  wash: 60,
  profile: 26,
  bar: 40,
  pixelPanel: 90,
  strobe: 90,
  blinder: 50,
  fogger: 30,
  laser: 2,
  generic: 30,
};

/**
 * 释放几何体组。
 *
 * @param set 几何体组。
 */
export function disposeMeshSet(set: FixtureMeshSet): void {
  set.base.dispose();
  set.yoke?.dispose();
  set.head?.dispose();
  set.lens?.dispose();
}
