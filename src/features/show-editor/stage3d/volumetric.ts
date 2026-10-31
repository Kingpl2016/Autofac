import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  ConeGeometry,
  DepthTexture,
  Float32BufferAttribute,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from "three";

import { ATLAS_COLS, ATLAS_ROWS } from "./goboAtlas";

/**
 * 体积光：在半分辨率的缓冲里对每束光做光线步进，再叠加到画面上。
 *
 * 1. 深度预渲染：场景里不透明的部分（台面、布景、灯体）按半分辨率只写深度；
 * 2. 光束：每束光是一个封闭圆锥（只画背面），片元着色器求视线与圆锥的进出点（解析解），
 *    按场景深度截断后在区间内步进采样：图案（图集）、边缘柔化、离光源越远越淡、光束越窄越亮；
 * 3. 合成：把半分辨率的结果（半精度浮点，不支持时退回 8 位）用 `1 - e^-x` 压缩后叠加到画面。
 *
 * 显存：两张半分辨率缓冲（深度 + 颜色），1080p 下约 6 MB；第一次用到时创建。
 */

/** 体积光所在的图层（主渲染不画它）。 */
export const VOLUMETRIC_LAYER = 2;
/** 单次最多画多少束体积光（实例容量的上限）。 */
export const MAX_VOLUMETRIC = 512;

const VERTEX = /* glsl */ `
attribute vec4 aBeam;
varying vec3 vLocal;
varying vec3 vCamLocal;
varying vec3 vWorld;
varying vec4 vBeam;
varying vec3 vTint;
varying float vViewZ;
varying vec2 vScale;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 world = m * vec4(position, 1.0);
  vec4 view = viewMatrix * world;
  vLocal = position;
  vCamLocal = (inverse(m) * vec4(cameraPosition, 1.0)).xyz;
  vWorld = world.xyz;
  vBeam = aBeam;
  vTint = instanceColor;
  vViewZ = view.z;
  vScale = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
  gl_Position = projectionMatrix * view;
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uGain;
uniform float uSteps;
varying vec3 vLocal;
varying vec3 vCamLocal;
varying vec3 vWorld;
varying vec4 vBeam;
varying vec3 vTint;
varying float vViewZ;
varying vec2 vScale;

vec2 atlasUv(float slot, vec2 uv) {
  vec2 cell = vec2(mod(slot, ${ATLAS_COLS}.0), floor(slot / ${ATLAS_COLS}.0));
  return (cell + clamp(uv, 0.004, 0.996)) / vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0);
}

// 圆锥本地坐标：尖端在原点、沿 +Y 张开，y = 1 处半径为 1（x² + z² = y²，0 ≤ y ≤ 1）
bool insideCap(vec3 p) { return p.x * p.x + p.z * p.z <= p.y * p.y + 1e-4; }

void main() {
  vec3 ro = vCamLocal;
  vec3 rd = vLocal - vCamLocal; // t = 1 在这个背面片元上
  // 场景深度截断（同一条视线上，观察空间的 z 与 t 成正比）
  float depth = texture2D(uDepth, gl_FragCoord.xy / uResolution).x;
  float sceneZ = (uNear * uFar) / ((uFar - uNear) * depth - uFar);
  float tExit = depth >= 1.0 ? 1.0 : min(1.0, sceneZ / vViewZ);

  // 进入点：凸体只有一个进入点，取 1 之前满足条件的最大交点；都没有则相机在锥内
  float tEnter = 0.0;
  float a = rd.y * rd.y - rd.x * rd.x - rd.z * rd.z;
  float b = 2.0 * (ro.y * rd.y - ro.x * rd.x - ro.z * rd.z);
  float c = ro.y * ro.y - ro.x * ro.x - ro.z * ro.z;
  float lim = 1.0 - 1e-3;
  if (abs(a) > 1e-7) {
    float disc = b * b - 4.0 * a * c;
    if (disc >= 0.0) {
      float s = sqrt(disc);
      float r1 = (-b - s) / (2.0 * a);
      float r2 = (-b + s) / (2.0 * a);
      float y1 = ro.y + r1 * rd.y;
      float y2 = ro.y + r2 * rd.y;
      if (r1 < lim && y1 >= 0.0 && y1 <= 1.0) tEnter = max(tEnter, r1);
      if (r2 < lim && y2 >= 0.0 && y2 <= 1.0) tEnter = max(tEnter, r2);
    }
  }
  if (abs(rd.y) > 1e-7) {
    float tc = (1.0 - ro.y) / rd.y;
    vec3 pc = ro + rd * tc;
    if (tc < lim && pc.x * pc.x + pc.z * pc.z <= 1.0) tEnter = max(tEnter, tc);
  }
  if (tEnter >= tExit) discard;

  float rayLen = length(vWorld - cameraPosition);
  float span = tExit - tEnter;
  float dl = rayLen * span / uSteps;
  float ang = vBeam.y;
  float soft = vBeam.z;
  float cs = cos(ang);
  float sn = sin(ang);
  // 每个像素错开起点，减少步进的条纹
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float sum = 0.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= uSteps) break;
    vec3 p = ro + rd * (tEnter + (float(i) + jitter) / uSteps * span);
    float along = max(p.y, 1e-4);
    vec2 q = p.xz / along;
    float r = length(q);
    if (r > 1.0) continue;
    vec2 uv = vec2(cs * q.x - sn * q.y, sn * q.x + cs * q.y) * 0.5 + 0.5;
    float g = texture2D(uAtlas, atlasUv(vBeam.x, uv)).r;
    g = mix(g, 0.55, soft * 0.8);
    float edge = 1.0 - smoothstep(0.86 - soft * 0.5, 1.0, r);
    float radiusM = along * vScale.x;
    float fade = smoothstep(0.0, 0.06, along) / (1.0 + along * vScale.y * 0.08);
    sum += g * edge * fade / (0.04 + radiusM * radiusM);
  }
  float energy = sum * dl * uGain * vBeam.w;
  gl_FragColor = vec4(vTint * energy, 1.0);
}`;

const COMPOSITE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
const COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D uBeams;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uBeams, vUv).rgb;
  gl_FragColor = vec4(1.0 - exp(-c), 1.0);
}`;

/**
 * 体积光渲染。由 {@link ThreeStageRenderer} 持有：每帧 {@link begin} → 若干次 {@link push} → {@link finish}，
 * 主渲染之后调用 {@link render}。
 */
export class VolumetricBeams {
  readonly mesh: InstancedMesh;
  readonly #material: ShaderMaterial;
  readonly #beamAttr: InstancedBufferAttribute;
  readonly #depthMat = new MeshBasicMaterial({ colorWrite: false });
  readonly #quadScene = new Scene();
  readonly #quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly #quadMat: ShaderMaterial;
  #depthTarget: WebGLRenderTarget | null = null;
  #beamTarget: WebGLRenderTarget | null = null;
  #count = 0;
  readonly #size = new Vector2();
  readonly #clear = new Color();

  /**
   * @param atlas 图案图集纹理。
   */
  constructor(atlas: Texture) {
    // 封闭圆锥：尖端在原点、沿 +Y 张开到 y = 1（半径 1）
    const cone = new ConeGeometry(1, 1, 24, 1, false);
    cone.rotateX(Math.PI);
    cone.translate(0, 0.5, 0);
    this.#material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uAtlas: { value: atlas },
        uDepth: { value: null },
        uResolution: { value: new Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 400 },
        uGain: { value: 0.3 },
        uSteps: { value: 14 },
      },
      side: BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.mesh = new InstancedMesh(cone, this.#material, MAX_VOLUMETRIC);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.layers.set(VOLUMETRIC_LAYER);
    this.#beamAttr = new InstancedBufferAttribute(new Float32Array(MAX_VOLUMETRIC * 4), 4);
    this.mesh.geometry.setAttribute("aBeam", this.#beamAttr);
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(MAX_VOLUMETRIC * 3), 3);

    this.#quadMat = new ShaderMaterial({
      vertexShader: COMPOSITE_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      uniforms: { uBeams: { value: null } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const tri = new BufferGeometry();
    tri.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const quad = new Mesh(tri, this.#quadMat);
    quad.frustumCulled = false;
    this.#quadScene.add(quad);
  }

  /** 这一帧还有没有空位。 */
  get full(): boolean {
    return this.#count >= MAX_VOLUMETRIC;
  }

  /** 这一帧已加入的光束数。 */
  get count(): number {
    return this.#count;
  }

  /** 开始新的一帧。 */
  begin(): void {
    this.#count = 0;
  }

  /**
   * 加入一束光。
   *
   * @param matrix 圆锥的实例矩阵（尖端在光源，Y 轴沿光束，缩放为半径 / 长度 / 半径）。
   * @param color 颜色（线性）。
   * @param slot 图案在图集里的格号。
   * @param angle 图案旋转角（弧度）。
   * @param soft 柔化（0~1）。
   * @param intensity 亮度倍数（棱镜分光时小于 1）。
   */
  push(matrix: Matrix4, color: Color, slot: number, angle: number, soft: number, intensity: number): void {
    if (this.full) return;
    const i = this.#count++;
    this.mesh.setMatrixAt(i, matrix);
    this.mesh.setColorAt(i, color);
    this.#beamAttr.setXYZW(i, slot, angle, soft, intensity);
  }

  /** 结束这一帧（提交实例数据）。 */
  finish(): void {
    this.mesh.count = this.#count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.#beamAttr.needsUpdate = true;
  }

  /**
   * 画体积光并叠加到当前画面（在主渲染之后调用）。
   *
   * @param renderer 渲染器。
   * @param scene 场景。
   * @param camera 相机（会临时切换图层）。
   * @param steps 每条光线的采样数。
   * @param gain 总亮度（烟雾浓度 × 光束亮度）。
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, steps: number, gain: number): void {
    if (this.#count === 0 || steps <= 0 || gain <= 0) return;
    renderer.getDrawingBufferSize(this.#size);
    const w = Math.max(1, Math.floor(this.#size.x / 2));
    const h = Math.max(1, Math.floor(this.#size.y / 2));
    const { depth, beams } = this.#targets(renderer, w, h);

    const layers = camera.layers.mask;
    const clear = renderer.getClearColor(this.#clear);
    const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    try {
      // 1. 深度预渲染（只画图层 0：不透明的场景）
      camera.layers.set(0);
      scene.overrideMaterial = this.#depthMat;
      renderer.setRenderTarget(depth);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      scene.overrideMaterial = null;

      // 2. 光束
      const u = this.#material.uniforms;
      u.uDepth.value = depth.depthTexture;
      (u.uResolution.value as Vector2).set(w, h);
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uSteps.value = Math.min(64, Math.max(4, Math.round(steps)));
      u.uGain.value = gain;
      camera.layers.set(VOLUMETRIC_LAYER);
      renderer.setRenderTarget(beams);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.render(scene, camera);

      // 3. 合成到画面
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      this.#quadMat.uniforms.uBeams.value = beams.texture;
      renderer.render(this.#quadScene, this.#quadCamera as Camera);
    } finally {
      scene.overrideMaterial = null;
      camera.layers.mask = layers;
      renderer.autoClear = autoClear;
      renderer.setClearColor(clear, clearAlpha);
      renderer.setRenderTarget(null);
    }
  }

  /** 释放缓冲、几何体与材质。 */
  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.#material.dispose();
    this.#quadMat.dispose();
    this.#depthMat.dispose();
    for (const child of this.#quadScene.children) (child as Mesh).geometry.dispose();
    this.#depthTarget?.dispose();
    this.#depthTarget?.depthTexture?.dispose();
    this.#beamTarget?.dispose();
    this.#depthTarget = this.#beamTarget = null;
  }

  /** 半分辨率缓冲（尺寸变化时重建）。 */
  #targets(renderer: WebGLRenderer, w: number, h: number): { depth: WebGLRenderTarget; beams: WebGLRenderTarget } {
    if (!this.#depthTarget || this.#depthTarget.width !== w || this.#depthTarget.height !== h) {
      this.#depthTarget?.depthTexture?.dispose();
      this.#depthTarget?.dispose();
      this.#beamTarget?.dispose();
      const depthTexture = new DepthTexture(w, h);
      this.#depthTarget = new WebGLRenderTarget(w, h, { depthBuffer: true, depthTexture, minFilter: NearestFilter, magFilter: NearestFilter });
      const half = renderer.extensions.has("EXT_color_buffer_half_float") || renderer.extensions.has("EXT_color_buffer_float");
      this.#beamTarget = new WebGLRenderTarget(w, h, { depthBuffer: false, type: half ? HalfFloatType : UnsignedByteType });
    }
    return { depth: this.#depthTarget, beams: this.#beamTarget as WebGLRenderTarget };
  }
}
