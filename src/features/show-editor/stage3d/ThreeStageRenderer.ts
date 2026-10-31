import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  ConeGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  RGBAFormat,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  VideoTexture,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Texture,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { StageLayout } from "../lib/project";
import { DEFAULT_HAZE } from "../lib/stageOps";
import type { Fixture3D } from "./frame";
import { ATLAS_COLS, ATLAS_ROWS, GoboAtlas } from "./goboAtlas";
import { beamDirection, floorHit, MAX_BEAM_M, spotEllipse, toScene, type Vec3 } from "./math";
import { marchSteps, volumetricBudget, type BeamTier } from "./quality";
import { buildScenery, disposeGroup, OUTLINE_COLOR, type Scenery } from "./scenery";
import { buildShape, disposeMeshSet, type FixtureMeshSet } from "./shapes";
import { VenueModel } from "./venue";
import { VolumetricBeams } from "./volumetric";

/** 3D 舞台的配色（从 CSS 变量读取）。 */
export interface Stage3DTheme {
  background: string;
  grid: string;
  deck: string;
  selection: string;
}

/** LED 屏这一帧的画面：视频元素，或像素灯的像素（行优先、第一行在上，RGBA）。 */
export type ScreenFeed =
  | { objectId: string; video: HTMLVideoElement }
  | { objectId: string; pixels: { cols: number; rows: number; data: Uint8Array } };

/** 一帧要画的内容。 */
export interface Stage3DScene {
  stage: StageLayout;
  fixtures: readonly Fixture3D[];
  theme: Stage3DTheme;
  /** 画光束 */
  beams: boolean;
  /** 光束亮度（0~1） */
  beamOpacity: number;
  /** 悬停的灯具 */
  hover: string | null;
  /** 背景图（铺满台面）；没有时为 `null` */
  background: { image: HTMLImageElement; opacity: number } | null;
  /** 光束画质档位 */
  tier: BeamTier;
  /** 画面静止（暂停、拖动播放头）：按高一档画 */
  still: boolean;
  /** 选中的布景物件 */
  selectedObject: string | null;
  /** LED 屏的画面 */
  screens: readonly ScreenFeed[];
}

/** 渲染器需要的外部资源。 */
export interface RendererAssets {
  /** 导入的 3D 模型（`glb:<散列>` → 几何体组）；还没加载好时返回 `null` */
  external: (template: string) => FixtureMeshSet | null;
  /** 资源散列 → 文件地址（图案图片、场馆模型）；资源库里没有时返回 `null` */
  urlOf: (hash: string) => string | null;
  /** 图案图片或场馆模型加载完成（视图据此重画） */
  onAssetReady: () => void;
}

/** 相机预设：观众视角、俯视、侧面。 */
export type CameraPreset = "front" | "top" | "side";

/** 渲染统计（HUD 用）。 */
export interface Stage3DStats {
  geometries: number;
  textures: number;
  calls: number;
  triangles: number;
  /** 上一帧画成体积光的光束数 */
  volumetric: number;
}

/** 设备像素比上限：高分屏上限制填充率与显存。 */
const MAX_DPR = 1.5;
/** 绘制缓冲的像素数上限（约 2 百万像素，相当于 1920×1080）。 */
const MAX_PIXELS = 2_000_000;
/** 一束光最多分成几束（棱镜）。 */
const MAX_PRISM = 8;
/** 棱镜分出的光束偏开主光轴的角度（弧度）。 */
const PRISM_SPREAD = (5 * Math.PI) / 180;
/** 光束、光斑与选择圈所在的图层（不写深度，体积光的深度预渲染跳过它）。 */
const OVERLAY_LAYER = 1;

/** 每种几何体组画成的实例网格。 */
interface TemplateMeshes {
  set: FixtureMeshSet;
  base: InstancedMesh;
  yoke: InstancedMesh | null;
  head: InstancedMesh | null;
  lens: InstancedMesh | null;
  /** 这一组里的灯（帧里的下标） */
  members: number[];
}

/** 这一帧的一束光（棱镜分光后的每一束各一个）。对象在帧之间复用。 */
interface BeamItem {
  origin: Vector3;
  /** 场景方向（单位向量） */
  dir: Vector3;
  /** 舞台方向（落点计算用） */
  dirStage: [number, number, number];
  length: number;
  radius: number;
  hit: { distance: number; point: Vec3 } | null;
  color: Color;
  lum: number;
  slot: number;
  angle: number;
  soft: number;
  intensity: number;
  beamDeg: number;
}

const BEAM_VERTEX = /* glsl */ `
varying float vAlong;
varying vec3 vTint;
void main() {
  vAlong = position.y;
  vTint = instanceColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const BEAM_FRAGMENT = /* glsl */ `
uniform float uOpacity;
varying float vAlong;
varying vec3 vTint;
void main() {
  float a = uOpacity * pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.4);
  gl_FragColor = vec4(vTint * a, 1.0);
}`;
const SPOT_VERTEX = /* glsl */ `
attribute vec3 aGobo;
varying vec2 vLocal;
varying vec3 vTint;
varying vec3 vGobo;
void main() {
  vLocal = position.xz;
  vTint = instanceColor;
  vGobo = aGobo;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const SPOT_FRAGMENT = /* glsl */ `
uniform float uOpacity;
uniform sampler2D uAtlas;
varying vec2 vLocal;
varying vec3 vTint;
varying vec3 vGobo;
void main() {
  float r = clamp(length(vLocal), 0.0, 1.0);
  float soft = vGobo.z;
  float cs = cos(vGobo.y);
  float sn = sin(vGobo.y);
  vec2 q = vec2(cs * vLocal.x - sn * vLocal.y, sn * vLocal.x + cs * vLocal.y) * 0.5 + 0.5;
  vec2 cell = vec2(mod(vGobo.x, ${ATLAS_COLS}.0), floor(vGobo.x / ${ATLAS_COLS}.0));
  float g = texture2D(uAtlas, (cell + clamp(q, 0.004, 0.996)) / vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0)).r;
  g = mix(g, 0.55, soft * 0.8);
  float edge = 1.0 - smoothstep(0.8 - soft * 0.5, 1.0, r);
  float a = uOpacity * g * edge * (0.75 + 0.25 * (1.0 - r * r));
  gl_FragColor = vec4(vTint * a, 1.0);
}`;

/** Rec.709 亮度（0~1）。 */
const luminance = ([r, g, b]: readonly [number, number, number]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * three.js 实现的 3D 舞台渲染器。
 *
 * - 同一种几何体组（外形模板或同一个 GLB）的灯共用一组实例网格；摇头灯拆成底座、摇臂、灯头三组，每帧只改实例矩阵。
 * - 光束分三档（见 `quality.ts`）：体积光（{@link VolumetricBeams}，半分辨率光线步进，带图案与烟雾浓度）
 *   与简单光锥（叠加混合的实例网格）；地面光斑按图案投射。棱镜把一束光分成几束。
 * - 布景、LED 屏（视频或像素灯画面）、背景图与场馆模型见 `scenery.ts` / `venue.ts`。
 * - 只在画面变化（新的一帧、相机移动）时绘制；设备像素比上限 1.5。
 * - {@link dispose} 释放全部几何体、纹理、材质与 WebGL 上下文。
 */
export class ThreeStageRenderer {
  readonly #renderer: WebGLRenderer;
  readonly #scene = new Scene();
  readonly #camera = new PerspectiveCamera(45, 1, 0.1, 400);
  readonly #controls: OrbitControls;
  readonly #fixtureGroup = new Group();
  readonly #bodyMat = new MeshLambertMaterial({ vertexColors: true });
  readonly #lensMat = new MeshBasicMaterial({ color: 0xffffff });
  readonly #beamMat: ShaderMaterial;
  readonly #spotMat: ShaderMaterial;
  readonly #selectMat = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, transparent: true, opacity: 0.9, depthWrite: false });
  readonly #templates = new Map<string, FixtureMeshSet>();
  readonly #assets: RendererAssets;
  readonly #atlas: GoboAtlas;
  readonly #volumetric: VolumetricBeams;
  readonly #venue: VenueModel;
  #meshes = new Map<string, TemplateMeshes>();
  #structureKey = "";
  #scenery: Scenery | null = null;
  #sceneryKey: { stage: StageLayout; image: HTMLImageElement | null; opacity: number; theme: string } | null = null;
  #objectOffset: { id: string; dx: number; dy: number } | null = null;
  readonly #screenTextures = new Map<string, { source: HTMLVideoElement | "pixels"; texture: Texture }>();
  #beams: InstancedMesh | null = null;
  #spots: InstancedMesh | null = null;
  #rings: InstancedMesh | null = null;
  #spotGobo: InstancedBufferAttribute | null = null;
  #capacity = 0;
  #last: Stage3DScene | null = null;
  #steps = 0;
  #gain = 0;
  #fitted = false;
  #disposed = false;
  readonly #items: BeamItem[] = [];
  readonly #order: number[] = [];
  readonly #onChange = () => this.redraw();

  // 每帧复用的临时对象（不在循环里分配）
  readonly #m = new Matrix4();
  readonly #mf = new Matrix4();
  readonly #mt = new Matrix4();
  readonly #mh = new Matrix4();
  readonly #mb = new Matrix4();
  readonly #rot = new Matrix4();
  readonly #q = new Quaternion();
  readonly #v = new Vector3();
  readonly #v2 = new Vector3();
  readonly #s = new Vector3();
  readonly #p1 = new Vector3();
  readonly #p2 = new Vector3();
  readonly #c = new Color();
  readonly #yAxis = new Vector3(0, 1, 0);
  readonly #ray = new Raycaster();
  readonly #ndc = new Vector2();
  readonly #plane = new Plane(new Vector3(0, 1, 0), 0);

  /**
   * @param canvas 画布。
   * @param assets 导入的 3D 模型、资源地址与加载完成的回调。
   */
  constructor(canvas: HTMLCanvasElement, assets: RendererAssets) {
    this.#assets = assets;
    this.#renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "default" });
    this.#renderer.outputColorSpace = SRGBColorSpace;
    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.enableDamping = false;
    this.#controls.maxPolarAngle = Math.PI * 0.495;
    this.#controls.addEventListener("change", this.#onChange);
    this.#camera.layers.enable(OVERLAY_LAYER);
    this.#atlas = new GoboAtlas(assets.urlOf, assets.onAssetReady);
    const additive = { transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide } as const;
    this.#beamMat = new ShaderMaterial({ vertexShader: BEAM_VERTEX, fragmentShader: BEAM_FRAGMENT, uniforms: { uOpacity: { value: 0.3 } }, ...additive });
    this.#spotMat = new ShaderMaterial({
      vertexShader: SPOT_VERTEX,
      fragmentShader: SPOT_FRAGMENT,
      uniforms: { uOpacity: { value: 0.8 }, uAtlas: { value: this.#atlas.texture } },
      ...additive,
    });
    this.#volumetric = new VolumetricBeams(this.#atlas.texture);
    this.#venue = new VenueModel(assets.urlOf, assets.onAssetReady);
    this.#scene.add(new HemisphereLight(0xc8d0e0, 0x18181c, 1.4));
    const sun = new DirectionalLight(0xffffff, 0.7);
    sun.position.set(4, 10, 8);
    this.#scene.add(sun, this.#fixtureGroup, this.#venue.group, this.#volumetric.mesh);
  }

  /** 画布（变换手柄监听它的指针事件）。 */
  get domElement(): HTMLCanvasElement {
    return this.#renderer.domElement;
  }

  /**
   * 暂停 / 恢复轨道相机（框选、拖动时暂停）。
   *
   * @param on 是否响应。
   */
  setOrbitEnabled(on: boolean): void {
    this.#controls.enabled = on;
  }

  /** 相机。 */
  get camera(): PerspectiveCamera {
    return this.#camera;
  }

  /** 场景（变换手柄挂在这里）。 */
  get scene(): Scene {
    return this.#scene;
  }

  /** 场馆模型加载失败。 */
  get venueFailed(): boolean {
    return this.#venue.failed;
  }

  /**
   * 画布尺寸变化。
   *
   * @param width CSS 像素宽。
   * @param height CSS 像素高。
   * @param dpr 设备像素比。
   */
  resize(width: number, height: number, dpr: number): void {
    if (width <= 0 || height <= 0) return;
    // 绘制缓冲（含 4 倍多重采样）随像素数增长：大窗口时降低像素比，把显存控制在约 70 MB 以内
    const cap = Math.sqrt(MAX_PIXELS / (width * height));
    this.#renderer.setPixelRatio(Math.max(0.5, Math.min(MAX_DPR, dpr, cap)));
    this.#renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
    this.redraw();
  }

  /**
   * 画一帧。
   *
   * @param scene 帧内容。
   */
  render(scene: Stage3DScene): void {
    if (this.#disposed) return;
    this.#last = scene;
    this.#ensureScenery(scene);
    if (!this.#fitted) {
      this.setCamera("front");
      this.#fitted = true;
    }
    this.#renderer.setClearColor(scene.theme.background);
    this.#selectMat.color.set(scene.theme.selection);
    this.#highlightObject(scene.selectedObject, scene.theme.selection);
    this.#updateScreens(scene.screens);
    this.#venue.set(scene.stage.venue ?? null);
    this.#updateFixtures(scene);
    this.#draw();
  }

  /** 用上一帧的内容重画（相机移动、尺寸变化、手柄拖动时）。 */
  redraw(): void {
    if (this.#disposed || !this.#last) return;
    this.#draw();
  }

  /**
   * 拖动布景物件时的预览位移（不改工程，松开时由视图提交）。
   *
   * @param id 物件 id；`null` 为取消预览。
   * @param dx 舞台 x 方向位移（米）。
   * @param dy 舞台 y 方向位移（米）。
   */
  setObjectOffset(id: string | null, dx = 0, dy = 0): void {
    const prev = this.#objectOffset;
    this.#objectOffset = id ? { id, dx, dy } : null;
    if (prev && prev.id !== id) this.#placeObject(prev.id);
    if (id) this.#placeObject(id);
    this.redraw();
  }

  /**
   * 切到相机预设。
   *
   * @param preset 预设。
   */
  setCamera(preset: CameraPreset): void {
    const stage = this.#last?.stage ?? this.#sceneryKey?.stage;
    const w = stage?.width ?? 12;
    const d = stage?.depth ?? 8;
    const span = Math.max(w, d);
    const target = new Vector3(0, 1.2, -d / 2);
    const pos =
      preset === "top"
        ? new Vector3(0, span * 1.25 + 4, -d / 2 + 0.01)
        : preset === "side"
          ? new Vector3(w / 2 + span * 0.9 + 3, span * 0.45 + 2, -d / 2)
          : new Vector3(0, span * 0.35 + 3, span * 0.75 + 4);
    this.#camera.position.copy(pos);
    this.#controls.target.copy(target);
    this.#controls.update();
    this.redraw();
  }

  /**
   * 把灯具的位置投影到画布（点选 / 框选用）。
   *
   * @param width 画布 CSS 宽。
   * @param height 画布 CSS 高。
   * @returns 每台灯的画布坐标；在相机后面的不返回。
   */
  projectFixtures(width: number, height: number): { id: string; x: number; y: number }[] {
    const out: { id: string; x: number; y: number }[] = [];
    for (const f of this.#last?.fixtures ?? []) {
      const center = this.#fixtureCenter(f);
      this.#v.set(center[0], center[1], center[2]).project(this.#camera);
      if (this.#v.z < -1 || this.#v.z > 1) continue;
      out.push({ id: f.id, x: ((this.#v.x + 1) / 2) * width, y: ((1 - this.#v.y) / 2) * height });
    }
    return out;
  }

  /**
   * 点选布景物件（射线与物件网格求交，最近的优先）。
   *
   * @param x 画布 x（CSS 像素）。
   * @param y 画布 y。
   * @param width 画布 CSS 宽。
   * @param height 画布 CSS 高。
   * @returns 物件 id；没有命中时为 `null`。
   */
  pickObject(x: number, y: number, width: number, height: number): string | null {
    if (!this.#scenery || width <= 0 || height <= 0) return null;
    this.#ray.setFromCamera(this.#ndc.set((x / width) * 2 - 1, 1 - (y / height) * 2), this.#camera);
    const hit = this.#ray.intersectObjects(this.#scenery.pickables, false)[0];
    return (hit?.object.userData.objectId as string | undefined) ?? null;
  }

  /**
   * 画布上的一点落在某个高度的水平面上的舞台坐标（平面拖动用）。
   *
   * @param x 画布 x（CSS 像素）。
   * @param y 画布 y。
   * @param width 画布 CSS 宽。
   * @param height 画布 CSS 高。
   * @param z 平面高度（米，从台面算起）。
   * @returns 舞台坐标；视线与平面平行或交点在相机后面时为 `null`。
   */
  groundPoint(x: number, y: number, width: number, height: number, z: number): { x: number; y: number } | null {
    if (width <= 0 || height <= 0) return null;
    this.#ray.setFromCamera(this.#ndc.set((x / width) * 2 - 1, 1 - (y / height) * 2), this.#camera);
    this.#plane.constant = -z;
    const p = this.#ray.ray.intersectPlane(this.#plane, this.#v);
    return p ? { x: p.x, y: -p.z } : null;
  }

  /**
   * 灯具中心的场景坐标（变换手柄放在这里）。
   *
   * @param f 灯具。
   * @returns 场景坐标。
   */
  #fixtureCenter(f: Fixture3D): Vec3 {
    const up = toScene(f.basis.up);
    const p = toScene(f.position);
    const h = f.dims[1] / 2;
    return [p[0] + up[0] * h, p[1] + up[1] * h, p[2] + up[2] * h];
  }

  /**
   * 渲染统计。
   *
   * @returns 几何体、纹理数与上一帧的绘制调用、三角面数、体积光束数。
   */
  stats(): Stage3DStats {
    const info = this.#renderer.info;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      calls: info.render.calls,
      triangles: info.render.triangles,
      volumetric: this.#volumetric.count,
    };
  }

  /** 释放全部资源（几何体、纹理、材质、WebGL 上下文）。 */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controls.removeEventListener("change", this.#onChange);
    this.#controls.dispose();
    this.#clearFixtures();
    this.#clearScenery();
    for (const t of this.#screenTextures.values()) t.texture.dispose();
    this.#screenTextures.clear();
    for (const set of this.#templates.values()) disposeMeshSet(set);
    this.#templates.clear();
    this.#venue.dispose();
    this.#volumetric.dispose();
    this.#atlas.dispose();
    for (const m of [this.#bodyMat, this.#lensMat, this.#beamMat, this.#spotMat, this.#selectMat]) m.dispose();
    this.#renderer.dispose();
    this.#renderer.forceContextLoss();
  }

  // ---- 绘制 ----

  #draw(): void {
    this.#renderer.render(this.#scene, this.#camera);
    if (this.#volumetric.count > 0 && this.#steps > 0) this.#volumetric.render(this.#renderer, this.#scene, this.#camera, this.#steps, this.#gain);
  }

  // ---- 布景 ----

  #clearScenery(): void {
    if (!this.#scenery) return;
    this.#scene.remove(this.#scenery.group);
    disposeGroup(this.#scenery.group);
    this.#scenery = null;
  }

  #ensureScenery(scene: Stage3DScene): void {
    const k = this.#sceneryKey;
    const image = scene.background?.image ?? null;
    const opacity = scene.background?.opacity ?? 0;
    const theme = `${scene.theme.background}|${scene.theme.grid}|${scene.theme.deck}`;
    if (k && k.stage === scene.stage && k.image === image && k.opacity === opacity && k.theme === theme) return;
    this.#clearScenery();
    this.#scenery = buildScenery(scene.stage, scene.theme, scene.background);
    this.#scene.add(this.#scenery.group);
    this.#sceneryKey = { stage: scene.stage, image, opacity, theme };
    if (this.#objectOffset) this.#placeObject(this.#objectOffset.id);
    // 屏幕换了网格：贴图重新挂
    for (const t of this.#screenTextures.values()) t.texture.dispose();
    this.#screenTextures.clear();
  }

  /** 按预览位移摆一个物件。 */
  #placeObject(id: string): void {
    const root = this.#scenery?.objects.get(id);
    const o = this.#sceneryKey?.stage.objects.find((x) => x.id === id);
    if (!root || !o) return;
    const off = this.#objectOffset?.id === id ? this.#objectOffset : null;
    root.position.set(o.x + (off?.dx ?? 0), o.z ?? 0, -(o.y + (off?.dy ?? 0)));
  }

  #highlightObject(selected: string | null, color: string): void {
    for (const [id, mat] of this.#scenery?.outlines ?? []) {
      if (id === selected) mat.color.set(color);
      else mat.color.setHex(OUTLINE_COLOR);
    }
  }

  /** LED 屏：视频片段的画面（VideoTexture）或像素灯的像素（DataTexture，每帧上传）。 */
  #updateScreens(feeds: readonly ScreenFeed[]): void {
    const faces = this.#scenery?.screens;
    if (!faces) return;
    const byId = new Map(feeds.map((f) => [f.objectId, f]));
    for (const [id, face] of faces) {
      const feed = byId.get(id);
      const cached = this.#screenTextures.get(id);
      let texture: Texture | null = null;
      if (feed && "video" in feed) {
        if (cached?.source === feed.video) texture = cached.texture;
        else {
          cached?.texture.dispose();
          const v = new VideoTexture(feed.video);
          v.colorSpace = SRGBColorSpace;
          this.#screenTextures.set(id, { source: feed.video, texture: v });
          texture = v;
        }
      } else if (feed && "pixels" in feed) {
        const { cols, rows, data } = feed.pixels;
        const old = cached?.source === "pixels" ? (cached.texture as DataTexture) : null;
        if (old && old.image.width === cols && old.image.height === rows) {
          (old.image.data as Uint8Array).set(data);
          old.needsUpdate = true;
          texture = old;
        } else {
          cached?.texture.dispose();
          const d = new DataTexture(new Uint8Array(data), cols, rows, RGBAFormat);
          d.colorSpace = SRGBColorSpace;
          d.minFilter = d.magFilter = NearestFilter;
          d.flipY = false;
          d.needsUpdate = true;
          this.#screenTextures.set(id, { source: "pixels", texture: d });
          texture = d;
        }
      } else if (cached) {
        cached.texture.dispose();
        this.#screenTextures.delete(id);
      }
      const mat = face.material;
      if (mat.map !== texture) {
        mat.map = texture;
        mat.color.setHex(texture ? 0xffffff : 0x000000);
        mat.needsUpdate = true;
      }
    }
  }

  // ---- 灯具 ----

  #setOf(template: string, fallback: string): { key: string; set: FixtureMeshSet } {
    if (template.startsWith("glb:")) {
      const ext = this.#assets.external(template);
      if (ext) return { key: template, set: ext };
      template = fallback;
    }
    let set = this.#templates.get(template);
    if (!set) {
      set = buildShape(template.slice("shape:".length) as Fixture3D["shape"]);
      this.#templates.set(template, set);
    }
    return { key: template, set };
  }

  #clearFixtures(): void {
    for (const t of this.#meshes.values()) {
      for (const m of [t.base, t.yoke, t.head, t.lens]) if (m) this.#disposeInstanced(m);
    }
    this.#meshes.clear();
    for (const m of [this.#beams, this.#spots, this.#rings]) if (m) this.#disposeInstanced(m);
    this.#beams = this.#spots = this.#rings = null;
    this.#spotGobo = null;
    this.#capacity = 0;
  }

  /** 移除实例网格（几何体属于缓存的几何体组或这里新建的，分别处理）。 */
  #disposeInstanced(m: InstancedMesh): void {
    this.#fixtureGroup.remove(m);
    m.dispose();
    if (m.userData.ownGeometry === true) m.geometry.dispose();
  }

  #instanced(geometry: BufferGeometry, material: Material, count: number, own = false): InstancedMesh {
    const m = new InstancedMesh(geometry, material, Math.max(1, count));
    m.frustumCulled = false;
    m.count = 0;
    m.userData.ownGeometry = own;
    this.#fixtureGroup.add(m);
    return m;
  }

  /** 灯具的组成变了（数量、外形、GLB 加载完成）时重建实例网格。 */
  #rebuild(scene: Stage3DScene, resolved: { key: string; set: FixtureMeshSet }[]): void {
    this.#clearFixtures();
    const n = scene.fixtures.length;
    const groups = new Map<string, { set: FixtureMeshSet; members: number[] }>();
    resolved.forEach((r, i) => {
      const g = groups.get(r.key) ?? { set: r.set, members: [] };
      g.members.push(i);
      groups.set(r.key, g);
    });
    for (const [key, g] of groups) {
      const c = g.members.length;
      const lens = g.set.lens ? this.#instanced(g.set.lens, this.#lensMat, c) : null;
      if (lens) lens.instanceColor = new InstancedBufferAttribute(new Float32Array(c * 3), 3);
      this.#meshes.set(key, {
        set: g.set,
        base: this.#instanced(g.set.base, this.#bodyMat, c),
        yoke: g.set.yoke ? this.#instanced(g.set.yoke, this.#bodyMat, c) : null,
        head: g.set.head ? this.#instanced(g.set.head, this.#bodyMat, c) : null,
        lens,
        members: g.members,
      });
    }
    // 光锥：尖端在原点、沿 +Y 张开到 y = 1；容量按每台灯最多分成 MAX_PRISM 束
    const cap = Math.max(1, n * MAX_PRISM);
    const cone = new ConeGeometry(1, 1, 24, 1, true);
    cone.rotateX(Math.PI);
    cone.translate(0, 0.5, 0);
    this.#beams = this.#instanced(cone, this.#beamMat, cap, true);
    this.#beams.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.#beams.renderOrder = 2;
    const disc = new CircleGeometry(1, 32);
    disc.rotateX(-Math.PI / 2);
    this.#spotGobo = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    disc.setAttribute("aGobo", this.#spotGobo);
    this.#spots = this.#instanced(disc, this.#spotMat, cap, true);
    this.#spots.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.#spots.renderOrder = 1;
    const ring = new RingGeometry(0.85, 1, 32);
    ring.rotateX(-Math.PI / 2);
    this.#rings = this.#instanced(ring, this.#selectMat, n, true);
    for (const m of [this.#beams, this.#spots, this.#rings]) m.layers.set(OVERLAY_LAYER);
    this.#capacity = n;
  }

  /** 取一个复用的光束对象。 */
  #item(i: number): BeamItem {
    let it = this.#items[i];
    if (!it) {
      it = {
        origin: new Vector3(),
        dir: new Vector3(),
        dirStage: [0, 0, 0],
        length: 0,
        radius: 0,
        hit: null,
        color: new Color(),
        lum: 0,
        slot: 0,
        angle: 0,
        soft: 0,
        intensity: 1,
        beamDeg: 0,
      };
      this.#items[i] = it;
    }
    return it;
  }

  #updateFixtures(scene: Stage3DScene): void {
    const fixtures = scene.fixtures;
    const resolved = fixtures.map((f) => this.#setOf(f.template, `shape:${f.shape}`));
    const key = resolved.map((r) => r.key).join("|");
    if (key !== this.#structureKey || fixtures.length !== this.#capacity) {
      this.#rebuild(scene, resolved);
      this.#structureKey = key;
    }
    const beams = this.#beams;
    const spots = this.#spots;
    const rings = this.#rings;
    const spotGobo = this.#spotGobo;
    if (!beams || !spots || !rings || !spotGobo) return;
    const haze = scene.stage.haze ?? DEFAULT_HAZE;
    this.#beamMat.uniforms.uOpacity.value = Math.min(1, 0.32 * scene.beamOpacity * (0.4 + (haze / DEFAULT_HAZE) * 0.6));
    const stage = scene.stage;
    const deck = stage.height ?? 0;
    this.#atlas.beginFrame();
    let itemCount = 0;
    let ringCount = 0;

    for (const t of this.#meshes.values()) {
      t.members.forEach((fi, slot) => {
        const f = fixtures[fi];
        const set = t.set;
        const dims = set.unit ? f.dims : ([1, 1, 1] as const);
        // 灯具坐标系：位置 + 由 right / up / front 组成的旋转
        const r = toScene(f.basis.right);
        const u = toScene(f.basis.up);
        const fr = toScene(f.basis.front);
        const p = toScene(f.position);
        this.#rot.makeBasis(this.#v.set(r[0], r[1], r[2]), this.#v2.set(u[0], u[1], u[2]), this.#s.set(fr[0], fr[1], fr[2]));
        this.#mf.copy(this.#rot).setPosition(p[0], p[1], p[2]);
        this.#s.set(dims[0], dims[1], dims[2]);
        this.#m.copy(this.#mf).scale(this.#s);
        t.base.setMatrixAt(slot, this.#m);

        const angles = f.head ?? { pan: 0, tilt: 0 };
        const beamFrame = this.#mb.copy(this.#m);
        if (t.yoke && t.head) {
          // 摇臂：绕光轴转 Pan；灯头：再移到支点、绕 right 转 Tilt
          this.#mt.makeRotationY(angles.pan);
          this.#mh.copy(this.#mf).multiply(this.#mt);
          this.#m.copy(this.#mh).scale(this.#s);
          t.yoke.setMatrixAt(slot, this.#m);
          const pv = set.headPivot;
          this.#mt.makeTranslation(pv[0] * dims[0], pv[1] * dims[1], pv[2] * dims[2]);
          this.#mh.multiply(this.#mt);
          this.#mt.makeRotationX(angles.tilt);
          this.#mh.multiply(this.#mt).scale(this.#s);
          t.head.setMatrixAt(slot, this.#mh);
          beamFrame.copy(this.#mh);
        }
        const level = luminance(f.rgb);
        if (t.lens) {
          t.lens.setMatrixAt(slot, beamFrame);
          // 灯灭时发光面显示为暗灰，亮时显示实际颜色
          const k = 1 / 255;
          this.#c.setRGB(Math.max(0.06, f.rgb[0] * k), Math.max(0.06, f.rgb[1] * k), Math.max(0.06, f.rgb[2] * k), SRGBColorSpace);
          t.lens.setColorAt(slot, this.#c);
        }

        if (f.selected || f.id === scene.hover) {
          // 选中 / 悬停：灯体下方（站立时在脚下，吊挂时在灯体下沿）画一个圈
          const ringR = Math.max(f.dims[0], f.dims[2], 0.25) * 0.8 + 0.08;
          const ringY = u[1] >= 0 ? p[1] + 0.01 : p[1] - f.dims[1] - 0.02;
          this.#m.makeScale(ringR, 1, ringR).setPosition(p[0], ringY, p[2]);
          rings.setMatrixAt(ringCount, this.#m);
          ringCount += 1;
        }

        if (!scene.beams || !set.emitsBeam || level < 0.02) return;
        // 光束起点、方向与外观
        const bo = set.beamOrigin;
        this.#v.set(bo[0], bo[1], bo[2]).applyMatrix4(beamFrame);
        const main = toScene(beamDirection(f.basis, angles));
        const look = f.look;
        const gobo = this.#atlas.slotOf(look.gobo);
        const copies = look.prism >= 3 ? Math.min(MAX_PRISM, look.prism) : 1;
        const k = 1 / 255;
        if (copies > 1) {
          // 主光轴的两个垂直方向（棱镜分出的光束绕主光轴排开）
          this.#v2.set(main[0], main[1], main[2]);
          this.#p1.set(Math.abs(main[1]) < 0.9 ? 0 : 1, Math.abs(main[1]) < 0.9 ? 1 : 0, 0).cross(this.#v2).normalize();
          this.#p2.copy(this.#v2).cross(this.#p1).normalize();
        }
        for (let c = 0; c < copies; c++) {
          const it = this.#item(itemCount++);
          it.origin.copy(this.#v);
          it.dir.set(main[0], main[1], main[2]);
          if (copies > 1) {
            const phi = look.prismAngle + (c / copies) * Math.PI * 2;
            it.dir
              .multiplyScalar(Math.cos(PRISM_SPREAD))
              .addScaledVector(this.#p1, Math.cos(phi) * Math.sin(PRISM_SPREAD))
              .addScaledVector(this.#p2, Math.sin(phi) * Math.sin(PRISM_SPREAD))
              .normalize();
          }
          // 场景 → 舞台：(x, y, z) → (x, -z, y)
          it.dirStage[0] = it.dir.x;
          it.dirStage[1] = -it.dir.z;
          it.dirStage[2] = it.dir.y;
          const originStage: Vec3 = [it.origin.x, -it.origin.z, it.origin.y];
          const onDeck = floorHit(originStage, it.dirStage, 0);
          const inside = onDeck && Math.abs(onDeck.point[0]) <= stage.width / 2 && onDeck.point[1] >= 0 && onDeck.point[1] <= stage.depth;
          it.hit = inside ? onDeck : floorHit(originStage, it.dirStage, -deck);
          it.length = it.hit?.distance ?? MAX_BEAM_M * 0.4;
          it.beamDeg = f.beamDeg;
          it.radius = Math.max(0.01, it.length * Math.tan((f.beamDeg * Math.PI) / 360));
          it.intensity = copies > 1 ? 1.4 / copies : 1;
          it.color.setRGB(f.rgb[0] * k, f.rgb[1] * k, f.rgb[2] * k, SRGBColorSpace);
          it.lum = level * it.intensity;
          it.slot = gobo;
          it.angle = look.goboAngle;
          it.soft = look.soft;
        }
      });
      t.base.count = t.members.length;
      t.base.instanceMatrix.needsUpdate = true;
      for (const m of [t.yoke, t.head, t.lens]) {
        if (!m) continue;
        m.count = t.members.length;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }

    // 哪些光束画体积光：预算有限时取最亮的
    const steps = scene.beams ? marchSteps(scene.tier, scene.still) : 0;
    const budget = steps > 0 ? volumetricBudget(scene.tier, scene.still) : 0;
    const order = this.#order;
    order.length = itemCount;
    for (let i = 0; i < itemCount; i++) order[i] = i;
    if (budget < itemCount) order.sort((a, b) => this.#items[b].lum - this.#items[a].lum);
    this.#volumetric.begin();
    let beamCount = 0;
    let spotCount = 0;
    for (let n = 0; n < itemCount; n++) {
      const it = this.#items[order[n]];
      this.#q.setFromUnitVectors(this.#yAxis, it.dir);
      this.#m.compose(it.origin, this.#q, this.#s.set(it.radius, it.length, it.radius));
      if (n < budget && !this.#volumetric.full) {
        this.#volumetric.push(this.#m, it.color, it.slot, it.angle, it.soft, it.intensity);
      } else {
        beams.setMatrixAt(beamCount, this.#m);
        this.#c.copy(it.color).multiplyScalar(it.intensity);
        beams.setColorAt(beamCount, this.#c);
        beamCount += 1;
      }
      if (it.hit) {
        const e = spotEllipse(it.dirStage, it.hit.distance, it.beamDeg);
        const hp = toScene(it.hit.point);
        this.#q.setFromAxisAngle(this.#yAxis, e.heading);
        this.#m.compose(this.#v.set(hp[0], hp[1] + 0.006, hp[2]), this.#q, this.#s.set(Math.max(0.02, e.major), 1, Math.max(0.02, e.minor)));
        spots.setMatrixAt(spotCount, this.#m);
        this.#c.copy(it.color).multiplyScalar(it.intensity);
        spots.setColorAt(spotCount, this.#c);
        spotGobo.setXYZ(spotCount, it.slot, it.angle, it.soft);
        spotCount += 1;
      }
    }
    this.#volumetric.finish();
    this.#steps = steps;
    this.#gain = 0.85 * haze * scene.beamOpacity;
    beams.count = beamCount;
    spots.count = spotCount;
    rings.count = ringCount;
    spotGobo.needsUpdate = true;
    for (const m of [beams, spots, rings]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}
