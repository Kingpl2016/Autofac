import { useEffect, useRef, type RefObject } from "react";
import { Matrix4, Object3D, Vector3 } from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";

import type { FixtureInstance } from "../lib/project";
import { normalizeDeg, setFixturePlacement } from "../lib/stageOps";
import { useProjectStore } from "../stores/useProjectStore";
import type { FixtureStatic } from "./frame";
import { toScene, type Vec3 } from "./math";
import type { ThreeStageRenderer } from "./ThreeStageRenderer";

/** 手柄模式：上下拖动改高度，或旋转改朝向与俯仰。 */
export type GizmoMode = "height" | "rotate";

/** 高度的吸附步长（米）。 */
const HEIGHT_SNAP = 0.05;

/**
 * 由灯体的姿态（舞台坐标的 up / front）反求水平朝向与俯仰（度），与 `fixtureBasis` 互逆（不含横滚）。
 *
 * @param up 光轴方向。
 * @param front 前方。
 * @param hanging 是否吊挂。
 * @returns 朝向（-180~180）与俯仰（-90~90）。
 */
export function attitudeOf(up: Vec3, front: Vec3, hanging: boolean): { rotation: number; pitch: number } {
  // 水平朝向取 front 的水平分量；front 竖直时（俯仰 ±90）退回 up 的水平分量
  let fx = front[0];
  let fy = front[1];
  if (Math.hypot(fx, fy) < 1e-3) {
    fx = up[0];
    fy = up[1];
  }
  const n = Math.hypot(fx, fy) || 1;
  fx /= n;
  fy /= n;
  const rotation = (Math.atan2(fx, -fy) * 180) / Math.PI;
  const pitch = (Math.atan2(up[0] * fx + up[1] * fy, up[2] * (hanging ? -1 : 1)) * 180) / Math.PI;
  return { rotation: normalizeDeg(Math.round(rotation)), pitch: Math.max(-90, Math.min(90, Math.round(pitch))) };
}

/**
 * 布置模式下选中灯具上的变换手柄（three.js 的 TransformControls）。
 *
 * 手柄放在第一台选中的灯上；松开时把变化量（高度差、朝向差、俯仰差）应用到全部选中的灯，一步撤销。
 * 拖动期间暂停轨道相机。平面位置不在这里改（视图里直接拖动灯具，见 `Stage3DView`）。
 *
 * @param renderer 渲染器；还没创建时为 `null`。
 * @param selected 选中的灯具（空数组时不显示手柄）。
 * @param statics 灯具的静态信息（位置与姿态）。
 * @param mode 手柄模式。
 * @returns 手柄的状态。
 */
export function useFixtureGizmo(
  renderer: ThreeStageRenderer | null,
  selected: readonly FixtureInstance[],
  statics: readonly FixtureStatic[],
  mode: GizmoMode,
): GizmoHandle {
  const update = useProjectStore((s) => s.update);
  // 正在（或刚刚）拖动手柄：视图据此忽略这次点击，不改选择
  const draggingRef = useRef(false);
  const controlsRef = useRef<TransformControls | null>(null);
  const leadId = selected[0]?.id;
  const lead = leadId ? statics.find((s) => s.id === leadId) : undefined;
  const ids = selected.map((f) => f.id).join(",");

  useEffect(() => {
    if (!renderer || !lead) return;
    const targets = ids.split(",");
    const proxy = new Object3D();
    const pos = toScene([lead.placement.x, lead.placement.y, lead.placement.z ?? 0]);
    const r = toScene(lead.basis.right);
    const u = toScene(lead.basis.up);
    const f = toScene(lead.basis.front);
    proxy.position.set(pos[0], pos[1], pos[2]);
    proxy.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(...r), new Vector3(...u), new Vector3(...f)));
    renderer.scene.add(proxy);

    const controls = new TransformControls(renderer.camera, renderer.domElement);
    if (mode === "height") {
      controls.setMode("translate");
      controls.setSpace("world");
      controls.showX = false;
      controls.showZ = false;
    } else {
      controls.setMode("rotate");
      controls.setSpace("local");
      controls.showZ = false;
    }
    controls.setSize(0.8);
    controls.attach(proxy);
    controlsRef.current = controls;
    const helper = controls.getHelper();
    renderer.scene.add(helper);
    const startY = proxy.position.y;
    const hanging = lead.placement.hanging === true;

    const onDragging = (e: { value: unknown }) => {
      const dragging = e.value === true;
      renderer.setOrbitEnabled(!dragging);
      if (dragging) draggingRef.current = true;
      // 松开后等这次 pointerup 的点击处理完再清掉
      else window.setTimeout(() => (draggingRef.current = false), 0);
    };
    const onChange = () => renderer.redraw();
    const onUp = () => {
      if (mode === "height") {
        const dz = Math.round((proxy.position.y - startY) / HEIGHT_SNAP) * HEIGHT_SNAP;
        if (Math.abs(dz) < 1e-6) return;
        update((d) => {
          for (const fx of d.fixtures) {
            if (!targets.includes(fx.id)) continue;
            setFixturePlacement(d, [fx.id], { z: Math.max(0, (fx.stage?.z ?? 0) + dz) });
          }
        });
        return;
      }
      const upS = new Vector3(0, 1, 0).applyQuaternion(proxy.quaternion);
      const frS = new Vector3(0, 0, 1).applyQuaternion(proxy.quaternion);
      // 场景 → 舞台：(x, y, z) → (x, -z, y)
      const next = attitudeOf([upS.x, -upS.z, upS.y], [frS.x, -frS.z, frS.y], hanging);
      const dRot = next.rotation - (lead.placement.rotation ?? 0);
      const dPitch = next.pitch - (lead.placement.pitch ?? 0);
      if (Math.abs(dRot) < 0.5 && Math.abs(dPitch) < 0.5) return;
      update((d) => {
        for (const fx of d.fixtures) {
          if (!targets.includes(fx.id)) continue;
          setFixturePlacement(d, [fx.id], {
            rotation: (fx.stage?.rotation ?? 0) + dRot,
            pitch: Math.max(-90, Math.min(90, (fx.stage?.pitch ?? 0) + dPitch)),
          });
        }
      });
    };
    controls.addEventListener("dragging-changed", onDragging);
    controls.addEventListener("change", onChange);
    controls.addEventListener("mouseUp", onUp);
    renderer.redraw();
    return () => {
      controls.removeEventListener("dragging-changed", onDragging);
      controls.removeEventListener("change", onChange);
      controls.removeEventListener("mouseUp", onUp);
      controls.detach();
      renderer.scene.remove(helper, proxy);
      controls.dispose();
      controlsRef.current = null;
      renderer.setOrbitEnabled(true);
      renderer.redraw();
    };
  }, [renderer, lead, ids, mode, update]);
  return { dragging: draggingRef, overHandle: () => (controlsRef.current?.axis ?? null) !== null };
}

/** 手柄的状态。 */
export interface GizmoHandle {
  /** 正在（或刚刚）拖动手柄 */
  dragging: RefObject<boolean>;
  /** 指针正停在手柄上（按下会拖动手柄，而不是选择或平面拖动） */
  overHandle: () => boolean;
}
