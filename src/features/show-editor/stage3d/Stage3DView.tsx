import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Box, Eye, Move3d, Rotate3d, ScanEye, Sun, Upload } from "lucide-react";

import { cn } from "@/lib/utils";
import { assetUrl, useFixtureAssetStore } from "@/features/fixtures";
import { useAppearanceRevision } from "@/features/appearance";
import { useElementSize } from "@/shared/hooks/useElementSize";
import { announce } from "@/shared/stores/announcerStore";
import type { FixtureInstance } from "../lib/project";
import { moveFixtures, removeStageObject, snap, updateStageObject } from "../lib/stageOps";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";
import { StageLayoutBar } from "../stage/StageLayoutBar";
import { hitFixture, lassoFixtures } from "../stage/stageGeometry";
import { useStageBackground } from "../stage/useStageBackground";
import { AssetMeshCache } from "./assetMeshes";
import type { Fixture3D } from "./frame";
import { effectiveTier, QualityGovernor, type BeamTier } from "./quality";
import { SceneSettings } from "./SceneSettings";
import { screenFeeds } from "./screenFeeds";
import { useFixtureGizmo, type GizmoMode } from "./useFixtureGizmo";
import { useStage3DFrame } from "./useStage3DFrame";
import { ThreeStageRenderer, type CameraPreset, type Stage3DStats, type Stage3DTheme } from "./ThreeStageRenderer";
import { ModelImportDialog } from "./ModelImportDialog";

/** 指针移动超过这个距离才算拖动（框选 / 旋转视角 / 平面拖动）。 */
const DRAG_THRESHOLD = 4;
/** 点选的命中半径（像素）。 */
const HIT_RADIUS = 14;
/** 不在布置模式时手柄不挂任何灯（引用稳定，避免手柄反复重建）。 */
const NO_FIXTURES: readonly FixtureInstance[] = [];

/** 从 CSS 变量读配色。 */
function readTheme(el: HTMLElement): Stage3DTheme {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--stage-bg", "#0b0c0f"),
    grid: v("--stage-grid", "#2a2d33"),
    deck: v("--surface-2", "#1c1e23"),
    selection: v("--primary", "#7aa2ff"),
  };
}

/** 平面拖动的公共字段：拖动平面的高度、起点（舞台坐标）、位移、是否吸附、是否已经开始。 */
interface PlaneDrag {
  z: number;
  /** 按下处的画布坐标（判断是否开始拖动） */
  px: number;
  py: number;
  /** 按下处在拖动平面上的舞台坐标 */
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  free: boolean;
  active: boolean;
}

/** 进行中的指针手势：按下（还没动）、框选、平面拖动灯具 / 布景物件。 */
type Gesture =
  | { kind: "press"; x: number; y: number; additive: boolean }
  | { kind: "lasso"; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | ({ kind: "fixtures"; ids: string[]; lead: { x: number; y: number } } & PlaneDrag)
  | ({ kind: "object"; id: string; origin: { x: number; y: number } } & PlaneDrag);

/**
 * 3D 舞台（按需加载）：与 2D 舞台同一份预览求值，画出灯体、光束（体积光 / 光锥，带图案、棱镜、频闪）、地面光斑、
 * 布景、LED 屏画面与场馆模型。
 *
 * - 视角：左键拖动旋转、右键拖动平移、滚轮缩放；HUD 上有观众 / 俯视 / 侧面预设。
 * - 选择：单击选灯（Ctrl / Shift 加选），按住 Shift 拖动框选；Ctrl+A 全选，Esc 取消。选择与编程器共用。
 * - 布置：打开后底部显示与 2D 相同的布置工具条；直接拖动灯具或布景物件在水平面上移动（按偏好吸附，Alt 不吸附），
 *   选中的灯上有手柄：上下拖动改高度，旋转手柄改朝向与俯仰。所有修改都是一步撤销。
 * - 画质：自动档在播放时按帧间隔调节；暂停时按高一档画。
 * - 内存：视图卸载时释放全部几何体、纹理与 WebGL 上下文；导入的 3D 模型与场馆不再使用时立即释放。
 */
export function Stage3DView() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedIds = useEditorUiStore((s) => s.selectedFixtureIds);
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const setSharedHover = useEditorUiStore((s) => s.setHoverFixture);
  const sharedHover = useEditorUiStore((s) => s.hoverFixtureId);
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const playing = usePlaybackStore((s) => s.state?.transport === "playing");
  const prefs = useEditorPrefsStore((s) => s.stage);
  const ensureAssets = useFixtureAssetStore((s) => s.ensure);
  const byHash = useFixtureAssetStore((s) => s.byHash);
  const revision = useAppearanceRevision();
  const background = useStageBackground(project.stage.backgroundPath);
  const frame = useStage3DFrame();

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<ThreeStageRenderer | null>(null);
  const cacheRef = useRef<AssetMeshCache | null>(null);
  const urlRef = useRef<(hash: string, kind: "model" | "other") => string | null>(() => null);
  const size = useElementSize(wrapRef);
  const [hover, setHover] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [editing, setEditing] = useState(false);
  const [selectedObject, setSelectedObject] = useState<string | null>(null);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>("height");
  const [beams, setBeams] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<Stage3DStats | null>(null);
  const [assetRevision, setAssetRevision] = useState(0);
  const [lost, setLost] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [autoTier, setAutoTier] = useState<BeamTier>("mid");

  useEffect(() => {
    void ensureAssets();
  }, [ensureAssets]);
  useEffect(() => {
    urlRef.current = (hash, kind) => {
      const a = byHash.get(hash);
      if (!a) return null;
      if (kind === "model") return a.kind === "model" ? assetUrl(a.path) : null;
      return a.kind === "gobo" || a.kind === "venue" ? assetUrl(a.path) : null;
    };
  }, [byHash]);

  // 渲染器与导入模型的缓存：画布挂上时创建，卸下时释放（含 WebGL 上下文）
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    if (!canvas) return;
    const ready = () => setAssetRevision((r) => r + 1);
    const cache = new AssetMeshCache((h) => urlRef.current(h, "model"), ready);
    cacheRef.current = cache;
    let r: ThreeStageRenderer;
    try {
      r = new ThreeStageRenderer(canvas, { external: (tpl) => cache.get(tpl), urlOf: (h) => urlRef.current(h, "other"), onAssetReady: ready });
    } catch {
      setLost(true);
      return () => cache.dispose();
    }
    const onLost = (e: Event) => {
      e.preventDefault();
      setLost(true);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    setRenderer(r);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      r.dispose();
      cache.dispose();
      cacheRef.current = null;
      canvasRef.current = null;
      setRenderer(null);
    };
  }, []);

  useEffect(() => {
    renderer?.resize(size.width, size.height, window.devicePixelRatio || 1);
  }, [renderer, size]);

  // 自动画质：播放时用 rAF 的帧间隔调节档位
  useEffect(() => {
    if (!playing || prefs.beamQuality !== "auto") return;
    const governor = new QualityGovernor(autoTier);
    let last = performance.now();
    let id = requestAnimationFrame(function tick(now) {
      if (governor.sample(now - last, now)) setAutoTier(governor.tier);
      last = now;
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
    // 档位变化不重启测量（调节器自己记着当前档）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, prefs.beamQuality]);

  // 平面拖动中的灯具：按吸附后的位移预览（与 `moveFixtures` 同样的规则：吸附作用于第一台灯）
  const fixtures = useMemo((): readonly Fixture3D[] => {
    if (gesture?.kind !== "fixtures" || !gesture.active) return frame.fixtures;
    const step = gesture.free ? 0 : prefs.snapM;
    const dx = snap(gesture.lead.x + gesture.dx, step) - gesture.lead.x;
    const dy = snap(gesture.lead.y + gesture.dy, step) - gesture.lead.y;
    const ids = new Set(gesture.ids);
    return frame.fixtures.map((f) => (ids.has(f.id) ? { ...f, position: [f.position[0] + dx, f.position[1] + dy, f.position[2]] } : f));
  }, [frame.fixtures, gesture, prefs.snapM]);

  // 每次重新渲染（播放时约 30 次 / 秒）画一帧；导入模型 / 图案 / 场馆加载完成（assetRevision）也会触发
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!renderer || !wrap || size.width === 0) return;
    cacheRef.current?.retain(new Set(fixtures.flatMap((f) => (f.template.startsWith("glb:") ? [f.template.slice(4)] : []))));
    renderer.render({
      stage: project.stage,
      fixtures,
      theme: readTheme(wrap),
      beams,
      beamOpacity: 1,
      hover: hover ?? sharedHover,
      background: background.status === "ready" ? { image: background.image, opacity: prefs.backgroundOpacity } : null,
      tier: effectiveTier(prefs.beamQuality, autoTier),
      still: !playing,
      selectedObject: editing ? selectedObject : null,
      screens: screenFeeds(project, frame.colors, playheadMs),
    });
  });
  void revision;
  void assetRevision;

  // 统计（只在打开时每秒刷新）
  useEffect(() => {
    if (!showStats || !renderer) return;
    const id = window.setInterval(() => setStats(renderer.stats()), 1000);
    return () => window.clearInterval(id);
  }, [showStats, renderer]);

  const selection = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedFixtures = useMemo(() => project.fixtures.filter((f) => selection.has(f.id)), [project.fixtures, selection]);
  const gizmo = useFixtureGizmo(renderer, editing ? selectedFixtures : NO_FIXTURES, frame.statics, gizmoMode);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const points = () => renderer?.projectFixtures(size.width, size.height) ?? [];
  const hitAt = (p: { x: number; y: number }) => hitFixture(points(), p.x, p.y, HIT_RADIUS);
  const ground = (p: { x: number; y: number }, z: number) => renderer?.groundPoint(p.x, p.y, size.width, size.height, z) ?? null;

  /** 布置模式下按在灯具或布景上：开始平面拖动（返回是否开始了）。 */
  const startPlaneDrag = (p: { x: number; y: number }, free: boolean): boolean => {
    if (!renderer) return false;
    const hit = hitAt(p);
    if (hit) {
      const s = frame.statics.find((x) => x.id === hit);
      if (!s) return false;
      const z = s.placement.z ?? 0;
      const start = ground(p, z);
      if (!start) return false;
      const ids = selection.has(hit) ? [hit, ...selectedIds.filter((id) => id !== hit)] : [hit];
      if (!selection.has(hit)) setSelected([hit]);
      setSelectedObject(null);
      renderer.setOrbitEnabled(false);
      setGesture({ kind: "fixtures", ids, lead: { x: s.placement.x, y: s.placement.y }, z, px: p.x, py: p.y, sx: start.x, sy: start.y, dx: 0, dy: 0, free, active: false });
      return true;
    }
    const objId = renderer.pickObject(p.x, p.y, size.width, size.height);
    const o = objId ? project.stage.objects.find((x) => x.id === objId) : undefined;
    if (!o) return false;
    const z = o.z ?? 0;
    const start = ground(p, z);
    setSelectedObject(o.id);
    if (!start) return true;
    renderer.setOrbitEnabled(false);
    setGesture({ kind: "object", id: o.id, origin: { x: o.x, y: o.y }, z, px: p.x, py: p.y, sx: start.x, sy: start.y, dx: 0, dy: 0, free, active: false });
    return true;
  };

  const onDownCapture = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !renderer || (e.target as HTMLElement).tagName !== "CANVAS") return;
    const p = local(e);
    if (editing && !e.shiftKey && !e.ctrlKey && !e.metaKey && !gizmo.overHandle() && startPlaneDrag(p, e.altKey)) return;
    // Shift 拖动是框选：先关掉轨道控制，免得同时旋转视角
    if (e.shiftKey) renderer.setOrbitEnabled(false);
    setGesture({ kind: "press", x: p.x, y: p.y, additive: e.shiftKey || e.ctrlKey || e.metaKey });
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    if (!gesture) {
      if (e.buttons !== 0) return;
      const hit = hitAt(p);
      if (hit !== hover) {
        setHover(hit);
        setSharedHover(hit);
      }
      return;
    }
    if (gesture.kind === "fixtures" || gesture.kind === "object") {
      if (gizmo.dragging.current) return;
      const active = gesture.active || Math.hypot(p.x - gesture.px, p.y - gesture.py) >= DRAG_THRESHOLD;
      const cur = ground(p, gesture.z);
      if (!cur) return;
      const next = { ...gesture, dx: cur.x - gesture.sx, dy: cur.y - gesture.sy, free: e.altKey, active };
      setGesture(next);
      if (next.kind === "object" && active) {
        const step = next.free ? 0 : prefs.snapM;
        renderer?.setObjectOffset(next.id, snap(next.origin.x + next.dx, step) - next.origin.x, snap(next.origin.y + next.dy, step) - next.origin.y);
      }
      return;
    }
    if (gesture.kind === "press") {
      if (Math.hypot(p.x - gesture.x, p.y - gesture.y) < DRAG_THRESHOLD) return;
      // 不按 Shift 的拖动交给轨道控制（旋转视角）
      if (!e.shiftKey) {
        setGesture(null);
        return;
      }
      setGesture({ kind: "lasso", x0: gesture.x, y0: gesture.y, x1: p.x, y1: p.y, additive: gesture.additive });
      return;
    }
    setGesture({ ...gesture, x1: p.x, y1: p.y });
  };
  const onUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const g = gesture;
    setGesture(null);
    renderer?.setOrbitEnabled(true);
    if (!g || gizmo.dragging.current) {
      renderer?.setObjectOffset(null);
      return;
    }
    if (g.kind === "fixtures" || g.kind === "object") {
      renderer?.setObjectOffset(null);
      if (!g.active) return;
      const step = g.free ? 0 : prefs.snapM;
      if (g.kind === "fixtures") {
        update((d) => moveFixtures(d, g.ids, g.dx, g.dy, step));
        announce(t("editor.stage3d.moved", { count: g.ids.length }));
      } else {
        const o = project.stage.objects.find((x) => x.id === g.id);
        update((d) => updateStageObject(d, g.id, { x: snap(g.origin.x + g.dx, step), y: snap(g.origin.y + g.dy, step) }));
        if (o) announce(t("editor.stage3d.objectMoved", { kind: t(`editor.stage.layout.kinds.${o.kind}`) }));
      }
      return;
    }
    if (g.kind === "lasso") {
      const hits = lassoFixtures(points(), { x: g.x0, y: g.y0 }, { x: g.x1, y: g.y1 });
      setSelected(g.additive ? [...new Set([...selectedIds, ...hits])] : hits);
      return;
    }
    const hit = hitAt(local(e));
    if (!hit) {
      if (!g.additive) setSelected([]);
      if (editing) setSelectedObject(renderer?.pickObject(local(e).x, local(e).y, size.width, size.height) ?? null);
      return;
    }
    if (g.additive) setSelected(selection.has(hit) ? selectedIds.filter((x) => x !== hit) : [...selectedIds, hit]);
    else setSelected([hit]);
  };

  const camera = (preset: CameraPreset) => {
    renderer?.setCamera(preset);
    announce(t(`editor.stage3d.camera.${preset}`));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a") {
      setSelected(project.fixtures.map((f) => f.id));
      e.preventDefault();
    } else if (e.key === "Escape" && (selectedIds.length > 0 || selectedObject)) {
      setSelected([]);
      setSelectedObject(null);
      e.preventDefault();
    } else if (editing && selectedObject && (e.key === "Delete" || e.key === "Backspace")) {
      const id = selectedObject;
      update((d) => removeStageObject(d, id));
      setSelectedObject(null);
      e.preventDefault();
    } else if (!mod && (e.key === "f" || e.key === "F" || e.key === "Home")) {
      camera("front");
      e.preventDefault();
    }
  };

  const toggle = (label: string, on: boolean, onClick: () => void, icon: ReactNode) => (
    <button
      type="button"
      aria-pressed={on}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px] backdrop-blur-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "border-primary bg-primary/25 text-foreground" : "border-border bg-background/60 text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const hudButton = (label: string, onClick: () => void, icon: ReactNode, disabled = false) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-3.5"
    >
      {icon}
    </button>
  );

  const hovered = fixtures.find((f) => f.id === hover);
  const lasso = gesture?.kind === "lasso" ? gesture : null;
  const firstModelId = selectedFixtures[0]?.modelId;
  const objectInStage = selectedObject && project.stage.objects.some((o) => o.id === selectedObject) ? selectedObject : null;
  const dragging = gesture?.kind === "fixtures" || gesture?.kind === "object";

  return (
    <div className="flex h-full min-h-48 w-full flex-col">
      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden bg-stage-bg" onPointerDownCapture={onDownCapture}>
        <canvas
          ref={attachCanvas}
          role="application"
          tabIndex={0}
          aria-roledescription={t("editor.stage3d.roleDescription")}
          aria-label={t("editor.stage3d.label", { count: project.fixtures.length, selected: selectedIds.length })}
          className={cn(
            "absolute inset-0 h-full w-full touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            dragging && "cursor-grabbing",
          )}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => {
            setGesture(null);
            renderer?.setObjectOffset(null);
            renderer?.setOrbitEnabled(true);
          }}
          onPointerLeave={() => {
            setHover(null);
            setSharedHover(null);
          }}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => e.preventDefault()}
        />
        {lasso && (
          <div
            aria-hidden
            className="pointer-events-none absolute border border-primary bg-primary/10"
            style={{
              left: Math.min(lasso.x0, lasso.x1),
              top: Math.min(lasso.y0, lasso.y1),
              width: Math.abs(lasso.x1 - lasso.x0),
              height: Math.abs(lasso.y1 - lasso.y0),
            }}
          />
        )}
        {lost && (
          <div role="alert" className="absolute inset-0 flex items-center justify-center bg-background/80 p-4 text-center text-sm text-destructive">
            {t("editor.stage3d.contextLost")}
          </div>
        )}

        <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5">
          <div role="group" aria-label={t("editor.stage3d.camera.group")} className="flex items-center rounded-md border border-border bg-background/60 backdrop-blur-sm">
            {hudButton(t("editor.stage3d.camera.front"), () => camera("front"), <Eye aria-hidden />)}
            {hudButton(t("editor.stage3d.camera.top"), () => camera("top"), <ScanEye aria-hidden />)}
            {hudButton(t("editor.stage3d.camera.side"), () => camera("side"), <Box aria-hidden />)}
          </div>
          {toggle(t("editor.stage3d.beams"), beams, () => setBeams((b) => !b), <Sun aria-hidden className="size-3" />)}
          <SceneSettings tier={autoTier} venueFailed={renderer?.venueFailed ?? false} />
          {toggle(t("editor.stage.layoutMode"), editing, () => setEditing((v) => !v), <Move3d aria-hidden className="size-3" />)}
          {editing && (
            <div role="radiogroup" aria-label={t("editor.stage3d.gizmo.group")} className="flex items-center rounded-md border border-border bg-background/60 backdrop-blur-sm">
              {(["height", "rotate"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={gizmoMode === m}
                  title={t(`editor.stage3d.gizmo.${m}Hint`)}
                  onClick={() => setGizmoMode(m)}
                  className={cn(
                    "flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    gizmoMode === m ? "bg-primary/25 text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m === "height" ? <Move3d aria-hidden className="size-3" /> : <Rotate3d aria-hidden className="size-3" />}
                  {t(`editor.stage3d.gizmo.${m}`)}
                </button>
              ))}
            </div>
          )}
          {hudButton(t("editor.stage3d.import"), () => setImportOpen(true), <Upload aria-hidden />, !firstModelId)}
          {toggle(t("editor.stage3d.stats"), showStats, () => setShowStats((v) => !v), <Activity aria-hidden className="size-3" />)}
        </div>

        <div className="pointer-events-none absolute right-2 top-2 flex max-w-72 flex-col items-end gap-1 text-[11px]">
          {frame.missingModels > 0 && (
            <span role="status" className="rounded bg-background/70 px-1.5 py-0.5 text-warning">
              {t("editor.stage3d.missing", { count: frame.missingModels })}
            </span>
          )}
          {showStats && stats && (
            <span className="num rounded bg-background/70 px-1.5 py-0.5 text-muted-foreground">
              {t("editor.stage3d.statsText", { ...stats })}
            </span>
          )}
          {hovered && <span className="rounded bg-background/70 px-1.5 py-0.5 text-foreground">{hovered.name}</span>}
        </div>
        {project.fixtures.length === 0 && (
          <p className="pointer-events-none absolute inset-x-0 bottom-8 text-center text-xs text-muted-foreground">{t("editor.stage3d.empty")}</p>
        )}
        <p className="pointer-events-none absolute bottom-1 left-2 text-[10px] text-muted-foreground/80">
          {editing ? t("editor.stage3d.hintEditing") : t("editor.stage3d.hint")}
        </p>
      </div>
      {editing && <StageLayoutBar selectedObjectId={objectInStage} onSelectObject={setSelectedObject} background={background} />}
      {importOpen && firstModelId && <ModelImportDialog modelId={firstModelId} onClose={() => setImportOpen(false)} />}
    </div>
  );
}
