import { BufferAttribute, Group, MeshLambertMaterial, type BufferGeometry, type Mesh, type Object3D } from "three";

import type { StageVenue } from "../lib/project";

/**
 * 场馆模型（资源库里规整过的 GLB，见 `importModel.ts` 的 `normalizeVenue`）：作为 3D 舞台的背景。
 *
 * - 第一次用到某个散列时加载（GLTFLoader 按需导入），加载完成后通知视图重画；换模型或清除时立即释放。
 * - 所有网格共用一个顶点色的 Lambert 材质（不用贴图），显存只有几何体本身。
 * - 位置 / 角度 / 缩放变化只改组的变换，不重新加载。
 */
export class VenueModel {
  readonly group = new Group();
  readonly #material = new MeshLambertMaterial({ vertexColors: true });
  readonly #urlOf: (hash: string) => string | null;
  readonly #onReady: () => void;
  #hash: string | null = null;
  #root: Object3D | null = null;
  readonly #failed = new Set<string>();
  #disposed = false;

  /**
   * @param urlOf 散列 → 文件地址；资源库里没有时返回 `null`。
   * @param onReady 模型加载完成时调用。
   */
  constructor(urlOf: (hash: string) => string | null, onReady: () => void) {
    this.#urlOf = urlOf;
    this.#onReady = onReady;
    this.group.name = "venue";
  }

  /** 当前的模型加载失败（HUD 提示）。 */
  get failed(): boolean {
    return this.#hash !== null && this.#failed.has(this.#hash);
  }

  /**
   * 设置场馆（每帧调用；散列不变时只更新变换）。
   *
   * @param venue 场馆；`null` 为没有。
   */
  set(venue: StageVenue | null): void {
    if (this.#disposed) return;
    const hash = venue?.hash ?? null;
    if (hash !== this.#hash) {
      this.#clear();
      this.#hash = hash;
      if (hash && !this.#failed.has(hash)) void this.#load(hash);
    }
    if (venue) {
      this.group.position.set(venue.x, venue.z, -venue.y);
      this.group.rotation.set(0, (venue.rotation * Math.PI) / 180, 0);
      this.group.scale.setScalar(venue.scale);
    }
  }

  /** 释放全部。 */
  dispose(): void {
    this.#disposed = true;
    this.#clear();
    this.#material.dispose();
  }

  #clear(): void {
    if (!this.#root) return;
    this.group.remove(this.#root);
    this.#root.traverse((o) => (o as Mesh).geometry?.dispose());
    this.#root = null;
  }

  async #load(hash: string): Promise<void> {
    const url = this.#urlOf(hash);
    if (!url) {
      this.#failed.add(hash);
      return;
    }
    try {
      const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().loadAsync(url);
      const root = gltf.scene;
      root.traverse((o) => {
        const mesh = o as Mesh<BufferGeometry>;
        if (!mesh.isMesh) return;
        const old = mesh.material;
        for (const m of Array.isArray(old) ? old : [old]) m.dispose();
        mesh.material = this.#material;
        const geo = mesh.geometry;
        if (!geo.getAttribute("normal")) geo.computeVertexNormals();
        if (!geo.getAttribute("color")) geo.setAttribute("color", new BufferAttribute(new Float32Array(geo.getAttribute("position").count * 3).fill(0.55), 3));
      });
      // 加载期间换了模型或视图已关闭：丢弃
      if (this.#disposed || this.#hash !== hash) {
        root.traverse((o) => (o as Mesh).geometry?.dispose());
        return;
      }
      this.#root = root;
      this.group.add(root);
      this.#onReady();
    } catch {
      this.#failed.add(hash);
      this.#onReady();
    }
  }
}
