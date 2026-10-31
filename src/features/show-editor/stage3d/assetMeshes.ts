import { BufferAttribute, type BufferGeometry, type Mesh, type Object3D } from "three";

import type { Vec3 } from "./math";
import { disposeMeshSet, type FixtureMeshSet } from "./shapes";
import { lensDiscAt, STUDIO_EXTRAS_KEY, type StudioExtras } from "./glbFormat";

/**
 * 导入的 3D 模型（规整后的 GLB，见 `glbFormat.ts`）在 3D 舞台里的几何体缓存。
 *
 * - 按散列缓存；第一次用到时加载（GLTFLoader 按需动态导入），加载完成后通知视图重画。
 * - 视图每次渲染告诉缓存“现在还用哪些散列”（{@link retain}），不用的立即释放，切回 2D 时全部释放。
 * - 加载失败的散列记下来，不反复重试；渲染器对它们一直用外形模板。
 */
export class AssetMeshCache {
  readonly #sets = new Map<string, FixtureMeshSet>();
  readonly #loading = new Set<string>();
  readonly #failed = new Set<string>();
  readonly #urlOf: (hash: string) => string | null;
  readonly #onReady: () => void;
  #disposed = false;

  /**
   * @param urlOf 散列 → 文件地址（asset 协议）；资源库里没有时返回 `null`。
   * @param onReady 有模型加载完成时调用（视图据此重画）。
   */
  constructor(urlOf: (hash: string) => string | null, onReady: () => void) {
    this.#urlOf = urlOf;
    this.#onReady = onReady;
  }

  /**
   * 取一个模板的几何体组（`glb:<散列>`）；还没加载好时开始加载并返回 `null`。
   *
   * @param template 模板键。
   * @returns 几何体组。
   */
  get(template: string): FixtureMeshSet | null {
    if (!template.startsWith("glb:")) return null;
    const hash = template.slice(4);
    const hit = this.#sets.get(hash);
    if (hit) return hit;
    if (!this.#loading.has(hash) && !this.#failed.has(hash)) void this.#load(hash);
    return null;
  }

  /** 已经加载失败的散列（HUD 提示）。 */
  get failed(): ReadonlySet<string> {
    return this.#failed;
  }

  /**
   * 只保留仍在使用的模型，其余释放。
   *
   * @param hashes 仍在使用的散列。
   */
  retain(hashes: ReadonlySet<string>): void {
    for (const [hash, set] of this.#sets) {
      if (hashes.has(hash)) continue;
      disposeMeshSet(set);
      this.#sets.delete(hash);
    }
  }

  /** 释放全部。 */
  dispose(): void {
    this.#disposed = true;
    for (const set of this.#sets.values()) disposeMeshSet(set);
    this.#sets.clear();
  }

  async #load(hash: string): Promise<void> {
    const url = this.#urlOf(hash);
    if (!url) {
      this.#failed.add(hash);
      return;
    }
    this.#loading.add(hash);
    try {
      const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().loadAsync(url);
      const set = meshSetFrom(gltf.scene);
      // 加载期间视图已经关闭：立即释放
      if (this.#disposed) {
        disposeMeshSet(set);
        return;
      }
      this.#sets.set(hash, set);
      this.#onReady();
    } catch {
      this.#failed.add(hash);
    } finally {
      this.#loading.delete(hash);
    }
  }
}

/** 取场景里某个名字的网格的几何体（拿走后从场景里摘掉，场景剩下的部分随垃圾回收）。 */
function takeGeometry(root: Object3D, name: string): BufferGeometry | undefined {
  const mesh = root.getObjectByName(name) as Mesh | undefined;
  if (!mesh?.isMesh) return undefined;
  const geo = mesh.geometry;
  mesh.geometry = undefined as unknown as BufferGeometry;
  if (!geo.getAttribute("color")) {
    const n = geo.getAttribute("position").count;
    const colors = new Float32Array(n * 3).fill(0.5);
    geo.setAttribute("color", new BufferAttribute(colors, 3));
  }
  if (!geo.getAttribute("normal")) geo.computeVertexNormals();
  return geo;
}

/**
 * 规整后的 GLB 场景 → 几何体组。
 *
 * @param scene GLTFLoader 读出的场景。
 * @returns 几何体组（米制，不再按尺寸缩放）。
 */
export function meshSetFrom(scene: Object3D): FixtureMeshSet {
  let extras: StudioExtras | undefined;
  scene.traverse((o) => {
    extras ??= o.userData?.[STUDIO_EXTRAS_KEY] as StudioExtras | undefined;
  });
  const base = takeGeometry(scene, "base");
  if (!base) throw new Error("not a normalized fixture model");
  const yoke = takeGeometry(scene, "yoke");
  const head = takeGeometry(scene, "head");
  const jointed = yoke !== undefined && head !== undefined;
  const headPivot: Vec3 = jointed ? (extras?.headPivot ?? [0, 0, 0]) : [0, 0, 0];
  const beamOrigin: Vec3 = extras?.beamOrigin ?? [0, 0, 0];
  const lens = extras?.lensRadius ? lensDiscAt(extras.lensRadius, beamOrigin) : undefined;
  const count = (g?: BufferGeometry) => (g ? (g.index ? g.index.count : g.getAttribute("position").count) / 3 : 0);
  return {
    base,
    yoke: jointed ? yoke : undefined,
    head: jointed ? head : undefined,
    lens,
    headPivot,
    beamOrigin,
    emitsBeam: extras?.emitsBeam ?? true,
    unit: false,
    tris: count(base) + count(yoke) + count(head) + count(lens),
  };
}
