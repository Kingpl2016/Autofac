import { Box3, DirectionalLight, Group, HemisphereLight, Mesh, MeshLambertMaterial, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from "three";

import { meshSetFrom } from "./assetMeshes";
import { disposeMeshSet } from "./shapes";

/** 缩略图边长（像素）。 */
const THUMB_PX = 160;

/**
 * 给规整后的 GLB 生成缩略图（WebP）：临时开一个小的离屏渲染器，画完立即释放 WebGL 上下文。
 *
 * @param glb 规整后的 GLB。
 * @returns WebP 内容；浏览器不支持 WebP 编码或渲染失败时为 `null`。
 */
export async function renderThumbnail(glb: Uint8Array): Promise<Uint8Array | null> {
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const gltf = await new GLTFLoader().parseAsync(glb.slice().buffer, "");
  const set = meshSetFrom(gltf.scene);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = THUMB_PX;
  let renderer: WebGLRenderer | null = null;
  const mat = new MeshLambertMaterial({ vertexColors: true });
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setSize(THUMB_PX, THUMB_PX, false);
    const scene = new Scene();
    scene.add(new HemisphereLight(0xffffff, 0x303038, 1.6));
    const sun = new DirectionalLight(0xffffff, 0.9);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    const model = new Group();
    model.add(new Mesh(set.base, mat));
    if (set.yoke && set.head) {
      model.add(new Mesh(set.yoke, mat));
      const head = new Mesh(set.head, mat);
      head.position.set(...set.headPivot);
      model.add(head);
    }
    scene.add(model);
    const box = new Box3().setFromObject(model);
    const center = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2 || 0.5;
    const camera = new PerspectiveCamera(35, 1, radius / 100, radius * 20);
    camera.position.copy(center).add(new Vector3(1, 0.7, 1.4).normalize().multiplyScalar(radius * 3));
    camera.lookAt(center);
    renderer.render(scene, camera);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
    if (!blob || blob.type !== "image/webp") return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  } finally {
    mat.dispose();
    disposeMeshSet(set);
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
