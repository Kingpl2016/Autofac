import {
  Box3,
  BufferAttribute,
  Color,
  Group,
  LoadingManager,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { assetUrl, fixtureAssetSourceAuthorize } from "@/features/fixtures";
import type { Vec3 } from "./math";
import { STUDIO_EXTRAS_KEY, STUDIO_FORMAT_VERSION, type StudioExtras } from "./glbFormat";

/**
 * 3D 文件导入：读 GLB / glTF / OBJ，规整成 3D 舞台用的 GLB（见 `glbFormat.ts`）。
 *
 * 步骤：
 * 1. 读文件（glTF 的外部 `.bin` / 贴图按同目录的相对路径取）；
 * 2. 按“光轴朝向”把模型转到 Y 为光轴；按模型尺寸（或单位猜测）缩放；底面中心移到原点；
 * 3. 找名为 `pan` / `yoke` 与 `tilt` / `head` 的节点作为关节（Tilt 节点要在 Pan 节点下面）；
 * 4. 每个部分（底座、摇臂、灯头）合并成一个几何体，材质颜色烘焙成顶点色，丢掉贴图与 UV；
 * 5. 三角面超过上限时简化；导出为 GLB。
 *
 * 规整后的文件只有几何体，显存小、同型号的灯能共用一组实例网格。
 */

/** 光轴（灯头出光方向）在源文件里朝哪边。 */
export type BeamAxis = "up" | "down" | "front" | "back";

/** 三角面上限：超过时简化。 */
export const MAX_TRIANGLES = 100_000;
/** 规整后文件的大小上限（与后端一致）。 */
export const MAX_GLB_BYTES = 16 * 1024 * 1024;
/** 允许导入的扩展名。 */
export const MODEL_EXTENSIONS = ["glb", "gltf", "obj"] as const;

/** 导入选项。 */
export interface ImportOptions {
  /** 光轴在源文件里的方向 */
  beamAxis: BeamAxis;
  /** 目标尺寸（米，本地 right / up / front）；有时按最大边缩放到它，否则按单位猜测 */
  targetDims?: Vec3;
}

/** 规整结果。 */
export interface NormalizedModel {
  /** GLB 文件内容 */
  glb: Uint8Array;
  /** 三角面数（简化后） */
  tris: number;
  /** 简化前的三角面数 */
  sourceTris: number;
  /** 包围盒（毫米，本地 right / up / front） */
  bboxMm: [number, number, number];
  /** 找到了 Pan / Tilt 关节 */
  jointed: boolean;
}

/** 从源文件读出的场景（各加载器的结果统一成一个根节点）。 */
type Loaded = Object3D;

/**
 * 读取 3D 文件。
 *
 * @param url 文件地址（asset 协议）。
 * @param ext 扩展名（小写）。
 * @param resolve glTF 外部资源的相对路径 → 地址。
 * @returns 根节点。
 */
export async function loadModel(url: string, ext: string, resolve: (relative: string) => string): Promise<Loaded> {
  const manager = new LoadingManager();
  manager.setURLModifier((u) => (/^(blob:|data:|https?:|asset:)/.test(u) || u === url ? u : resolve(decodeURIComponent(u))));
  if (ext === "obj") {
    const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js");
    return new OBJLoader(manager).loadAsync(url);
  }
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/libs/meshopt_decoder.module.js"),
  ]);
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  return gltf.scene;
}

/**
 * 读取用户选择的 3D 文件：先放行 asset 协议对它（glTF 连同所在目录）的访问，再按扩展名读取。
 *
 * @param path 文件路径。
 * @returns 根节点（用完后用 {@link disposeLoaded} 释放）。
 */
export async function loadModelFile(path: string): Promise<Loaded> {
  await fixtureAssetSourceAuthorize(path);
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const dir = path.replace(/[\\/][^\\/]*$/, "");
  const sep = path.includes("\\") ? "\\" : "/";
  return loadModel(assetUrl(path), ext, (rel) => assetUrl(`${dir}${sep}${rel.replace(/[\\/]/g, sep)}`));
}

/** 名字像关节的节点。 */
const PAN_NAME = /(^|[^a-z])(pan|yoke)([^a-z]|$)/i;
const TILT_NAME = /(^|[^a-z])(tilt|head)([^a-z]|$)/i;

/**
 * 找 Pan / Tilt 关节：Tilt 节点必须在 Pan 节点下面。
 *
 * @param root 根节点。
 * @returns 两个关节；找不到时为 `null`。
 */
export function findJoints(root: Object3D): { pan: Object3D; tilt: Object3D } | null {
  let pan: Object3D | null = null;
  root.traverse((o) => {
    if (!pan && o !== root && PAN_NAME.test(o.name)) pan = o;
  });
  if (!pan) return null;
  let tilt: Object3D | null = null;
  (pan as Object3D).traverse((o) => {
    if (!tilt && o !== pan && TILT_NAME.test(o.name)) tilt = o;
  });
  return tilt ? { pan, tilt } : null;
}

/** 光轴 → 转到 +Y 的旋转。 */
function axisFix(axis: BeamAxis): Matrix4 {
  const m = new Matrix4();
  switch (axis) {
    case "up":
      return m;
    case "down":
      return m.makeRotationX(Math.PI);
    case "front":
      return m.makeRotationX(-Math.PI / 2);
    case "back":
      return m.makeRotationX(Math.PI / 2);
  }
}

/** 材质的颜色（没有颜色属性的材质按浅灰）。 */
function materialColor(mat: Material | Material[] | undefined): Color {
  const m = Array.isArray(mat) ? mat[0] : mat;
  const c = (m as MeshStandardMaterial | undefined)?.color;
  return c ? c.clone() : new Color(0.6, 0.6, 0.6);
}

/**
 * 一个网格 → 只有位置 / 法线 / 顶点色（Float32、带索引）的几何体，已变换到 `matrix` 的坐标里。
 *
 * @param mesh 网格。
 * @param matrix 变换。
 * @returns 几何体。
 */
function flatten(mesh: Mesh, matrix: Matrix4): BufferGeometry {
  const src = mesh.geometry;
  const geo = src.clone();
  for (const name of Object.keys(geo.attributes)) if (name !== "position" && name !== "normal" && name !== "color") geo.deleteAttribute(name);
  geo.morphAttributes = {};
  geo.applyMatrix4(matrix);
  if (!geo.getAttribute("normal")) geo.computeVertexNormals();
  const n = geo.getAttribute("position").count;
  const tint = materialColor(mesh.material);
  const old = geo.getAttribute("color");
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const k = old ? [old.getX(i), old.getY(i), old.getZ(i)] : [1, 1, 1];
    colors[i * 3] = k[0] * tint.r;
    colors[i * 3 + 1] = k[1] * tint.g;
    colors[i * 3 + 2] = k[2] * tint.b;
  }
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  for (const name of ["position", "normal"] as const) {
    const a = geo.getAttribute(name);
    if (!(a.array instanceof Float32Array)) {
      const f = new Float32Array(a.count * 3);
      for (let i = 0; i < a.count; i += 1) f.set([a.getX(i), a.getY(i), a.getZ(i)], i * 3);
      geo.setAttribute(name, new BufferAttribute(f, 3));
    }
  }
  if (!geo.index) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) idx[i] = i;
    geo.setIndex(new BufferAttribute(idx, 1));
  }
  return geo;
}

/** 收集 `root` 下属于某部分的网格（跳过 `exclude` 子树）。 */
function meshesUnder(root: Object3D, exclude: Object3D | null): Mesh[] {
  const out: Mesh[] = [];
  const walk = (o: Object3D) => {
    if (o === exclude) return;
    if ((o as Mesh).isMesh && o.visible) out.push(o as Mesh);
    for (const c of o.children) walk(c);
  };
  walk(root);
  return out;
}

/** 合并若干网格（世界坐标乘以 `post`）；没有网格时为 `null`。 */
function mergePart(meshes: readonly Mesh[], post: Matrix4): BufferGeometry | null {
  if (meshes.length === 0) return null;
  const parts = meshes.map((m) => flatten(m, new Matrix4().multiplyMatrices(post, m.matrixWorld)));
  const out = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return out;
}

const trisOf = (g: BufferGeometry | null) => (g ? (g.index ? g.index.count : g.getAttribute("position").count) / 3 : 0);

/** 按比例简化一个几何体到目标三角面数（SimplifyModifier 按需加载）。 */
async function simplify(g: BufferGeometry, targetTris: number): Promise<BufferGeometry> {
  const tris = trisOf(g);
  if (tris <= targetTris) return g;
  const { SimplifyModifier } = await import("three/addons/modifiers/SimplifyModifier.js");
  const vertices = g.getAttribute("position").count;
  const remove = Math.floor(vertices * (1 - targetTris / tris));
  const out = new SimplifyModifier().modify(g, remove);
  g.dispose();
  return out;
}

/**
 * 规整一个已读入的模型。
 *
 * @param source 读入的根节点（会被修改）。
 * @param options 导入选项。
 * @returns 规整后的 GLB 与统计。
 * @throws 模型里没有任何网格、或导出后仍超过大小上限时。
 */
export async function normalizeModel(source: Loaded, options: ImportOptions): Promise<NormalizedModel> {
  const root = new Group();
  root.add(source);
  root.updateMatrixWorld(true);
  const joints = findJoints(source);

  // 1. 统一方向与尺寸：先转到 Y 为光轴，再按包围盒缩放、底面中心归零
  const fix = axisFix(options.beamAxis);
  const box = new Box3();
  const tmp = new Box3();
  source.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (bb) box.union(tmp.copy(bb).applyMatrix4(new Matrix4().multiplyMatrices(fix, mesh.matrixWorld)));
  });
  if (box.isEmpty()) throw new Error("no_mesh");
  const size = box.getSize(new Vector3());
  const maxEdge = Math.max(size.x, size.y, size.z);
  let k = 1;
  if (options.targetDims) k = Math.max(...options.targetDims) / maxEdge;
  else if (maxEdge > 20) k = 0.001; // 毫米
  else if (maxEdge > 5) k = 0.01; // 厘米
  const center = box.getCenter(new Vector3());
  const post = new Matrix4().makeScale(k, k, k).multiply(new Matrix4().makeTranslation(-center.x, -box.min.y, -center.z)).multiply(fix);

  // 2. 关节支点（规整后的坐标）
  let headPivot: Vec3 | undefined;
  if (joints) {
    const p = new Vector3().setFromMatrixPosition(joints.tilt.matrixWorld).applyMatrix4(post);
    headPivot = [0, p.y, 0];
  }

  // 3. 合并各部分
  let base = mergePart(meshesUnder(source, joints?.pan ?? null), post);
  let yoke = joints ? mergePart(meshesUnder(joints.pan, joints.tilt), post) : null;
  let head = joints && headPivot ? mergePart(meshesUnder(joints.tilt, null), new Matrix4().makeTranslation(-headPivot[0], -headPivot[1], -headPivot[2]).multiply(post)) : null;
  const jointed = yoke !== null && head !== null;
  if (!jointed) {
    // 关节不完整：全部并成一个灯体
    for (const g of [base, yoke, head]) g?.dispose();
    base = mergePart(meshesUnder(source, null), post);
    yoke = head = null;
  }
  if (!base) throw new Error("no_mesh");

  // 4. 简化
  const sourceTris = trisOf(base) + trisOf(yoke) + trisOf(head);
  if (sourceTris > MAX_TRIANGLES) {
    const ratio = MAX_TRIANGLES / sourceTris;
    base = await simplify(base, Math.max(12, Math.floor(trisOf(base) * ratio)));
    if (yoke) yoke = await simplify(yoke, Math.max(12, Math.floor(trisOf(yoke) * ratio)));
    if (head) head = await simplify(head, Math.max(12, Math.floor(trisOf(head) * ratio)));
  }

  // 5. 光束起点与发光面：灯头（或灯体）沿光轴的顶端
  const lensFrom = (head ?? base).clone();
  lensFrom.computeBoundingBox();
  const lb = lensFrom.boundingBox as Box3;
  lensFrom.dispose();
  const beamOrigin: Vec3 = [0, lb.max.y, 0];
  const lensRadius = Math.max(0.01, 0.35 * Math.min(lb.max.x - lb.min.x, lb.max.z - lb.min.z));

  // 6. 导出
  const out = new Group();
  out.name = "fixture";
  const extras: StudioExtras = { version: STUDIO_FORMAT_VERSION, headPivot, beamOrigin, lensRadius, emitsBeam: true };
  out.userData = { [STUDIO_EXTRAS_KEY]: extras };
  const mat = new MeshStandardMaterial({ vertexColors: true });
  const baseMesh = new Mesh(base, mat);
  baseMesh.name = "base";
  out.add(baseMesh);
  if (yoke && head && headPivot) {
    const panNode = new Object3D();
    panNode.name = "pan";
    const yokeMesh = new Mesh(yoke, mat);
    yokeMesh.name = "yoke";
    const tiltNode = new Object3D();
    tiltNode.name = "tilt";
    tiltNode.position.set(...headPivot);
    const headMesh = new Mesh(head, mat);
    headMesh.name = "head";
    tiltNode.add(headMesh);
    panNode.add(yokeMesh, tiltNode);
    out.add(panNode);
  }
  const all = new Box3().setFromObject(out);
  const s = all.getSize(new Vector3());
  const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
  const buffer = (await new GLTFExporter().parseAsync(out, { binary: true })) as ArrayBuffer;
  const tris = trisOf(base) + trisOf(yoke) + trisOf(head);
  for (const g of [base, yoke, head]) g?.dispose();
  mat.dispose();
  if (buffer.byteLength > MAX_GLB_BYTES) throw new Error("too_large");
  return {
    glb: new Uint8Array(buffer),
    tris,
    sourceTris,
    bboxMm: [Math.round(s.x * 1000), Math.round(s.y * 1000), Math.round(s.z * 1000)],
    jointed,
  };
}

/** 场馆模型的三角面上限：超过时简化。 */
export const MAX_VENUE_TRIANGLES = 300_000;
/** 规整后场馆文件的大小上限（与后端一致）。 */
const MAX_VENUE_GLB_BYTES = 64 * 1024 * 1024;

/** 场馆模型的单位：自动按尺寸猜，或指定。 */
export type VenueUnit = "auto" | "m" | "cm" | "mm" | "in";
/** 可选的单位（界面顺序）。 */
export const VENUE_UNITS: readonly VenueUnit[] = ["auto", "m", "cm", "mm", "in"];
const UNIT_SCALE: Record<Exclude<VenueUnit, "auto">, number> = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 };

/** 场馆导入选项。 */
export interface VenueOptions {
  unit: VenueUnit;
  /** 源文件 Z 轴向上（多数 CAD / SketchUp 导出的 OBJ）；否则按 glTF 约定 Y 向上 */
  zUp: boolean;
}

/** 场馆规整结果。 */
export interface NormalizedVenue {
  glb: Uint8Array;
  tris: number;
  sourceTris: number;
  /** 规整后的尺寸（米，宽 / 高 / 深） */
  sizeM: [number, number, number];
  /** 实际采用的单位 */
  unit: Exclude<VenueUnit, "auto">;
}

/**
 * 规整一个场馆模型：转到 Y 向上、换算成米、水平居中且底面落在 0，全部网格合并成一个带顶点色的几何体，
 * 超过 {@link MAX_VENUE_TRIANGLES} 时简化。
 *
 * @param source 读入的根节点（会被修改）。
 * @param options 单位与朝向。
 * @returns 规整后的 GLB 与统计。
 * @throws 模型里没有网格（`no_mesh`）或导出后超过大小上限（`too_large`）时。
 */
export async function normalizeVenue(source: Loaded, options: VenueOptions): Promise<NormalizedVenue> {
  const root = new Group();
  root.add(source);
  root.updateMatrixWorld(true);
  const fix = options.zUp ? new Matrix4().makeRotationX(-Math.PI / 2) : new Matrix4();
  const box = new Box3();
  const tmp = new Box3();
  const meshes = meshesUnder(source, null);
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (bb) box.union(tmp.copy(bb).applyMatrix4(new Matrix4().multiplyMatrices(fix, mesh.matrixWorld)));
  }
  if (box.isEmpty()) throw new Error("no_mesh");
  const size = box.getSize(new Vector3());
  const maxEdge = Math.max(size.x, size.y, size.z);
  const unit = options.unit !== "auto" ? options.unit : maxEdge > 3000 ? "mm" : maxEdge > 400 ? "cm" : "m";
  const k = UNIT_SCALE[unit];
  const center = box.getCenter(new Vector3());
  const post = new Matrix4().makeScale(k, k, k).multiply(new Matrix4().makeTranslation(-center.x, -box.min.y, -center.z)).multiply(fix);

  let geo = mergePart(meshes, post);
  if (!geo) throw new Error("no_mesh");
  const sourceTris = trisOf(geo);
  if (sourceTris > MAX_VENUE_TRIANGLES) geo = await simplify(geo, MAX_VENUE_TRIANGLES);
  const tris = trisOf(geo);

  const out = new Group();
  out.name = "venue";
  const mat = new MeshStandardMaterial({ vertexColors: true });
  const mesh = new Mesh(geo, mat);
  mesh.name = "venue";
  out.add(mesh);
  const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
  const buffer = (await new GLTFExporter().parseAsync(out, { binary: true })) as ArrayBuffer;
  geo.dispose();
  mat.dispose();
  if (buffer.byteLength > MAX_VENUE_GLB_BYTES) throw new Error("too_large");
  // 包围盒是转到 Y 向上之后算的，所以这里已是宽 / 高 / 深
  const s = size.multiplyScalar(k);
  return { glb: new Uint8Array(buffer), tris, sourceTris, sizeM: [s.x, s.y, s.z], unit };
}

/**
 * 释放读入的源场景（几何体、材质与贴图）。
 *
 * @param root 根节点。
 */
export function disposeLoaded(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v && typeof v === "object" && "isTexture" in v) (v as { dispose: () => void }).dispose();
      m.dispose();
    }
  });
}
