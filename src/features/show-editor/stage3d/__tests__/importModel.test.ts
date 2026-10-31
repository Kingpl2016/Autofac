// @vitest-environment jsdom
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from "three";
import { describe, expect, it } from "vitest";

import { meshSetFrom } from "../assetMeshes";
import { findJoints, normalizeModel } from "../importModel";
import { disposeMeshSet } from "../shapes";

/** 一台“摇头灯”：底座 + pan 节点（摇臂）+ tilt 节点（灯头），单位是毫米，光轴朝前（+Z）。 */
function sampleHead(): Group {
  const root = new Group();
  const red = new MeshStandardMaterial({ color: 0xff0000 });
  const base = new Mesh(new BoxGeometry(350, 300, 120), red);
  base.position.set(0, 0, 60);
  base.name = "Body";
  const pan = new Object3D();
  pan.name = "Pan_Joint";
  pan.add(new Mesh(new BoxGeometry(300, 60, 200), red));
  const tilt = new Object3D();
  tilt.name = "Head";
  tilt.position.set(0, 0, 350);
  tilt.add(new Mesh(new BoxGeometry(220, 220, 300), red));
  pan.add(tilt);
  root.add(base, pan);
  return root;
}

describe("importModel", () => {
  it("按名字找关节：tilt 要在 pan 下面", () => {
    const head = sampleHead();
    const joints = findJoints(head);
    expect(joints?.pan.name).toBe("Pan_Joint");
    expect(joints?.tilt.name).toBe("Head");
    const flat = new Group();
    flat.add(Object.assign(new Object3D(), { name: "Head" }), Object.assign(new Object3D(), { name: "pan" }));
    expect(findJoints(flat)).toBeNull();
  });

  it("规整：转到 Y 为光轴、毫米换成米、按部件合并、写出关节；读回来是同样的几何体组", async () => {
    const out = await normalizeModel(sampleHead(), { beamAxis: "front" });
    expect(out.jointed).toBe(true);
    // 源文件是毫米：沿光轴从 -100（摇臂）到 500（灯头）共 600 mm
    expect(out.bboxMm[1]).toBe(600);
    expect(out.tris).toBe(36);
    expect(out.glb.byteLength).toBeGreaterThan(0);

    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().parseAsync(out.glb.slice().buffer, "");
    const set = meshSetFrom(gltf.scene);
    expect(set.unit).toBe(false);
    expect(set.yoke && set.head).toBeTruthy();
    // 底面移到 0：灯头支点在源文件的 350 mm 处，即离底面 450 mm
    expect(set.headPivot[1]).toBeCloseTo(0.45, 3);
    expect(set.beamOrigin[1]).toBeCloseTo(0.15, 3);
    const colors = set.base.getAttribute("color");
    expect(colors.getX(0)).toBeCloseTo(1, 3);
    expect(colors.getY(0)).toBeCloseTo(0, 3);
    disposeMeshSet(set);
  });

  it("按目标尺寸缩放；没有关节时并成一个灯体", async () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(2, 1, 1)));
    const out = await normalizeModel(root, { beamAxis: "up", targetDims: [0.5, 0.25, 0.25] });
    expect(out.jointed).toBe(false);
    expect(out.bboxMm).toEqual([500, 250, 250]);
    await expect(normalizeModel(new Group(), { beamAxis: "up" })).rejects.toThrow("no_mesh");
  });
});
