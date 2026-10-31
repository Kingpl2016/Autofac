import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  EdgesGeometry,
  ExtrudeGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Shape,
  SRGBColorSpace,
  type Material,
  type Object3D,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { StageLayout, StageObject } from "../lib/project";
import { DEFAULT_STAIR_STEPS, objectHeight } from "../lib/stageOps";

/**
 * 3D 舞台的布景：观众区地面、台面（可铺背景图）、每米网格线与布景物件（桁架、平台、圆台、多边形台面、台阶、立柱、LED 屏）。
 *
 * 每个物件是一个以物件中心为原点的组（`userData.objectId` 供点选），带一圈轮廓线（选中时换成选中色）；
 * LED 屏的屏面单独记下，渲染器每帧给它贴视频或像素画面。
 */

/** 布景的配色。 */
export interface SceneryTheme {
  background: string;
  grid: string;
  deck: string;
}

/** 背景图贴到台面上的最长边（像素）：大图先缩小，省显存。 */
const MAX_BACKGROUND_PX = 2048;

/** 构建结果。 */
export interface Scenery {
  group: Group;
  /** 物件 id → 物件的组（拖动预览时直接移动它） */
  objects: Map<string, Group>;
  /** 物件 id → 轮廓线材质（选中高亮） */
  outlines: Map<string, LineBasicMaterial>;
  /** LED 屏的物件 id → 屏面 */
  screens: Map<string, Mesh<PlaneGeometry, MeshBasicMaterial>>;
  /** 可点选的网格 */
  pickables: Mesh[];
}

/** 物件轮廓的默认颜色。 */
export const OUTLINE_COLOR = 0x8a909c;

/**
 * 释放一个组下面的全部几何体与材质（贴图由各自的所有者释放）。
 *
 * @param group 组。
 */
export function disposeGroup(group: Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((o: Object3D) => {
      const mesh = o as Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as Material | Material[] | undefined;
      for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        // 自己创建的贴图（背景图）跟着材质释放；屏幕画面的贴图由渲染器管理
        if (x.userData.ownsMap === true) (x as MeshLambertMaterial).map?.dispose();
        x.dispose();
      }
    });
  }
}

/**
 * 台阶：`steps` 级方块合成一个几何体，前低后高（本地 -y 为前，场景里是 +z）。
 *
 * @param o 台阶物件。
 * @returns 几何体（底面在 y = 0）。
 */
function stairsGeometry(o: StageObject): BufferGeometry {
  const n = Math.max(1, o.steps ?? DEFAULT_STAIR_STEPS);
  const total = Math.max(0.02, objectHeight(o));
  const depth = Math.max(0.02, o.h);
  const run = depth / n;
  const parts: BufferGeometry[] = [];
  for (let k = 0; k < n; k++) {
    const h = (total * (k + 1)) / n;
    const g = new BoxGeometry(Math.max(0.02, o.w), h, run);
    // 舞台本地 y = -depth/2 + (k + 0.5) * run → 场景 z 取反
    g.translate(0, h / 2, depth / 2 - (k + 0.5) * run);
    parts.push(g);
  }
  const out = mergeGeometries(parts, false) ?? new BoxGeometry(o.w, total, depth);
  for (const p of parts) p.dispose();
  return out;
}

/**
 * 多边形台面：顶点围成的形状向上挤出物件高度。
 *
 * @param o 多边形物件。
 * @returns 几何体（底面在 y = 0）；顶点不足 3 个时退回矩形。
 */
function polygonGeometry(o: StageObject): BufferGeometry {
  const pts = o.points ?? [];
  const h = Math.max(0.02, objectHeight(o));
  if (pts.length < 3) {
    const g = new BoxGeometry(Math.max(0.02, o.w), h, Math.max(0.02, o.h));
    g.translate(0, h / 2, 0);
    return g;
  }
  const shape = new Shape();
  pts.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const g = new ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
  // 形状在 XY 平面、沿 +Z 挤出：转到 Y 向上（本地 (x, y) → 场景 (x, -y)，挤出方向 → +Y）
  g.rotateX(-Math.PI / 2);
  return g;
}

/** 物件的主体几何体（底面在 y = 0，中心在原点）。 */
function objectGeometry(o: StageObject): BufferGeometry {
  const h = Math.max(0.02, objectHeight(o));
  let g: BufferGeometry;
  switch (o.kind) {
    case "circle":
      g = new CylinderGeometry(o.w / 2, o.w / 2, h, 32);
      break;
    case "pillar":
      g = new CylinderGeometry(Math.max(0.01, o.w / 2), Math.max(0.01, o.w / 2), h, 20);
      break;
    case "stairs":
      return stairsGeometry(o);
    case "polygon":
      return polygonGeometry(o);
    default:
      g = new BoxGeometry(Math.max(0.02, o.w), h, Math.max(0.02, o.h));
  }
  g.translate(0, h / 2, 0);
  return g;
}

/**
 * 背景图 → 台面贴图（按最长边缩小到 2048 像素）。
 *
 * @param image 已解码的图片。
 * @returns 贴图；画布不可用时为 `null`。
 */
function backgroundTexture(image: HTMLImageElement): CanvasTexture | null {
  const k = Math.min(1, MAX_BACKGROUND_PX / Math.max(1, image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * k));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * 构建布景。
 *
 * @param stage 舞台布置。
 * @param theme 配色。
 * @param background 背景图（铺满台面）与不透明度；没有时为 `null`。
 * @returns 布景组与索引（调用方负责用 {@link disposeGroup} 释放，背景贴图随之释放）。
 */
export function buildScenery(stage: StageLayout, theme: SceneryTheme, background: { image: HTMLImageElement; opacity: number } | null): Scenery {
  const group = new Group();
  const objects = new Map<string, Group>();
  const outlines = new Map<string, LineBasicMaterial>();
  const screens = new Map<string, Mesh<PlaneGeometry, MeshBasicMaterial>>();
  const pickables: Mesh[] = [];
  const { width: w, depth: d } = stage;
  const deck = stage.height ?? 0;

  const ground = new Mesh(new PlaneGeometry(200, 200), new MeshLambertMaterial({ color: new Color(theme.background).multiplyScalar(1.4) }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -deck - 0.002;
  group.add(ground);
  const deckMat = new MeshLambertMaterial({ color: theme.deck });
  if (deck > 0) {
    const body = new Mesh(new BoxGeometry(w, deck, d), deckMat);
    body.position.set(0, -deck / 2, -d / 2);
    group.add(body);
  } else {
    const top = new Mesh(new PlaneGeometry(w, d), deckMat);
    top.rotation.x = -Math.PI / 2;
    top.position.set(0, 0.001, -d / 2);
    group.add(top);
  }
  const tex = background ? backgroundTexture(background.image) : null;
  if (tex && background) {
    const mat = new MeshLambertMaterial({ map: tex, transparent: true, opacity: Math.min(1, Math.max(0, background.opacity)), depthWrite: false });
    mat.userData.ownsMap = true;
    const img = new Mesh(new PlaneGeometry(w, d), mat);
    img.rotation.x = -Math.PI / 2;
    img.position.set(0, 0.0015, -d / 2);
    group.add(img);
  }

  // 每米一条网格线 + 轮廓
  const pts: number[] = [];
  for (let x = Math.ceil(-w / 2); x <= w / 2; x += 1) pts.push(x, 0.003, 0, x, 0.003, -d);
  for (let y = 0; y <= d; y += 1) pts.push(-w / 2, 0.003, -y, w / 2, 0.003, -y);
  pts.push(-w / 2, 0.003, 0, -w / 2, 0.003, -d, w / 2, 0.003, 0, w / 2, 0.003, -d, -w / 2, 0.003, -d, w / 2, 0.003, -d);
  const grid = new BufferGeometry();
  grid.setAttribute("position", new BufferAttribute(new Float32Array(pts), 3));
  group.add(new LineSegments(grid, new LineBasicMaterial({ color: theme.grid, transparent: true, opacity: tex ? 0.35 : 0.6 })));

  const objMat = new MeshLambertMaterial({ color: 0x4a4f58 });
  const screenBodyMat = new MeshLambertMaterial({ color: 0x15161a });
  for (const o of stage.objects) {
    if (o.kind === "label") continue;
    const root = new Group();
    root.position.set(o.x, o.z ?? 0, -o.y);
    root.rotation.y = (o.rotation * Math.PI) / 180;
    root.userData.objectId = o.id;
    const geo = objectGeometry(o);
    const mesh = new Mesh(geo, o.kind === "screen" ? screenBodyMat : objMat);
    mesh.userData.objectId = o.id;
    root.add(mesh);
    pickables.push(mesh);
    const outline = new LineBasicMaterial({ color: OUTLINE_COLOR, transparent: true, opacity: o.kind === "truss" ? 1 : 0.55 });
    root.add(new LineSegments(new EdgesGeometry(geo, 25), outline));
    outlines.set(o.id, outline);
    if (o.kind === "screen") {
      const h = Math.max(0.02, objectHeight(o));
      const face = new Mesh(new PlaneGeometry(Math.max(0.02, o.w), h), new MeshBasicMaterial({ color: 0x000000 }));
      face.position.set(0, h / 2, Math.max(0.01, o.h) / 2 + 0.003);
      face.userData.objectId = o.id;
      root.add(face);
      pickables.push(face);
      screens.set(o.id, face);
    }
    objects.set(o.id, root);
    group.add(root);
  }
  return { group, objects, outlines, screens, pickables };
}
