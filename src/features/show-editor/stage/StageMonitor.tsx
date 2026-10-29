import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDroppable } from "@dnd-kit/core";
import { EyeOff, Maximize, Minus, Move, Plus, Power, Settings2, Sparkle } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppearanceRevision } from "@/features/appearance";
import { layoutOf } from "@/features/fixtures";
import { announce } from "@/shared/stores/announcerStore";
import { useElementSize } from "@/shared/hooks/useElementSize";
import { HelpTip } from "../components/HelpTip";
import { useEngine } from "../engine/useEngine";
import { STAGE_DROP_ID, type StageDropData } from "../hooks/fixtureDrop";
import { revealInPatch } from "../hooks/selectionActions";
import { toggleLocate } from "../hooks/transportActions";
import { usePreviewProject } from "../hooks/usePreviewProject";
import { createPreviewEvaluator } from "../lib/color";
import { createDmxEvaluator } from "../lib/dmxPreview";
import { sameModelIds } from "../lib/fixtureBatch";
import { baseOf, pixelRefsOf } from "../lib/fixtureRef";
import { buildSheet, type SheetRow } from "../lib/fixtureSheet";
import { analyzePatch } from "../lib/patch";
import { knockout } from "../lib/programmer";
import { moveFixtures, removeStageObject, resetPlacements, snap, updateStageObject } from "../lib/stageOps";
import { formatTimecode } from "../lib/time";
import { STAGE_LABELS, STAGE_SNAP_STEPS, useEditorPrefsStore, type StageLabel } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { StageLayoutBar } from "./StageLayoutBar";
import { Canvas2DStageRenderer, FIXTURE_RADIUS, type StageFixture, type StageRenderer, type StageTheme } from "./StageRenderer";
import {
  applyCamera,
  FIT_CAMERA,
  fitStage,
  hitFixture,
  hitObject,
  lassoFixtures,
  placeFixtures,
  toCanvas,
  toStage,
  zoomAt,
  type StageCamera,
} from "./stageGeometry";
import { useStageBackground } from "./useStageBackground";

/** 默认 Pan 行程（度）：模型没有物理参数时。 */
const DEFAULT_PAN_RANGE = 540;
/** 指针移动超过这个距离才算拖动 / 框选。 */
const DRAG_THRESHOLD = 4;
/** 键盘微调步长（米）：普通 / Shift。 */
const NUDGE_M = 0.1;
const NUDGE_BIG_M = 1;
/** 键盘平移视图的步长（像素）。 */
const PAN_STEP_PX = 40;
/** 按钮 / 键盘缩放一步的倍数。 */
const ZOOM_STEP = 1.25;
/** 背景图不透明度的可选值。 */
const BACKGROUND_OPACITIES = [0.15, 0.3, 0.45, 0.7, 1] as const;

/** 从 CSS 变量读舞台配色。 */
function readTheme(el: HTMLElement): StageTheme {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--stage-bg", "black"),
    grid: v("--stage-grid", "dimgray"),
    outline: v("--border", "gray"),
    selection: v("--primary", "white"),
    programmed: v("--keyframe", "orange"),
    text: v("--muted-foreground", "silver"),
  };
}

/** 进行中的指针手势。 */
type Gesture =
  | { kind: "lasso"; x0: number; y0: number; x1: number; y1: number; additive: boolean; active: boolean }
  | { kind: "fixtures"; ids: string[]; sx: number; sy: number; dx: number; dy: number; free: boolean; active: boolean }
  | { kind: "object"; id: string; sx: number; sy: number; dx: number; dy: number; free: boolean; active: boolean }
  | { kind: "pan"; sx: number; sy: number; panX: number; panY: number };

/**
 * 舞台监视器（俯视）：每台灯按舞台位置画出实际输出颜色、光晕和摇头灯的光束方向，与后端输出同一份引擎求值，
 * 叠加编程器；点选 / 框选灯具（与编程器共用选择），悬停显示数值；HUD 上可开关黑场、盲改、光晕。
 *
 * - 视图：滚轮以指针为中心缩放，Shift + 滚轮横向平移，中键拖动平移；HUD 的 − / + / 适应窗口，键盘 + / − / F；
 *   不在布置模式时方向键平移视图。缩放只影响显示，不改工程。
 * - 键盘（画布获得焦点时）：Ctrl+A 全选、Esc 取消选择。
 * - 右键：只选这台、选同型号、Locate、在 Patch 中定位、清除编程器值、复位位置，以及全选 / 取消选择 / 适应窗口。
 * - “视图”菜单：灯具旁的文字（选中时名称 / 全部名称 / 地址 / 只在悬停时）、吸附步长、背景图不透明度；
 *   这些与光晕开关记在编辑器偏好里。
 * - “布置”模式下可拖动灯具和布景物件（按吸附步长吸附，按住 Alt 自由移动；方向键微调，Shift 加大步长），
 *   底部工具条添加物件、改舞台尺寸 / 背景图、对齐 / 分布 / 镜像 / 排列选中的灯。
 *
 * 渲染经 [`StageRenderer`] 接口，当前是 Canvas2D 实现。每帧只为带 Pan / Tilt 的灯和悬停的灯读取通道值。
 */
export function StageMonitor() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const preview = usePreviewProject();
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const selectedIds = useEditorUiStore((s) => s.selectedFixtureIds);
  const setSelected = useEditorUiStore((s) => s.setSelectedFixtures);
  const blackout = useEditorUiStore((s) => s.blackout);
  const outputEnabled = usePlaybackStore((s) => s.state?.outputEnabled ?? true);
  const locateId = usePlaybackStore((s) => s.state?.locate ?? null);
  const setBlackout = useEditorUiStore((s) => s.setBlackout);
  const values = useProgrammerStore((s) => s.values);
  const setValues = useProgrammerStore((s) => s.setValues);
  const live = useProgrammerStore((s) => s.live);
  const setLive = useProgrammerStore((s) => s.setLive);
  const prefs = useEditorPrefsStore((s) => s.stage);
  const setPrefs = useEditorPrefsStore((s) => s.setStagePrefs);
  const engine = useEngine();
  const revision = useAppearanceRevision();
  const background = useStageBackground(project.stage.backgroundPath);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const size = useElementSize(wrapRef);
  const [hover, setHover] = useState<string | null>(null);
  // 别处（Universe 视图、通道格、灯具表）悬停的灯具：在舞台上一并高亮
  const sharedHover = useEditorUiStore((s) => s.hoverFixtureId);
  const setSharedHover = useEditorUiStore((s) => s.setHoverFixture);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [camera, setCamera] = useState<StageCamera>(FIT_CAMERA);
  const [editing, setEditing] = useState(false);
  const [menuTarget, setMenuTarget] = useState<string | null>(null);
  const [selectedObjectRaw, setSelectedObject] = useState<string | null>(null);
  // 物件被删除（撤销等）后自动失效
  const selectedObject = project.stage.objects.some((o) => o.id === selectedObjectRaw) ? selectedObjectRaw : null;
  const snapStep = (free: boolean) => (free ? 0 : prefs.snapM);

  const colorsAt = useMemo(() => createPreviewEvaluator(preview, engine), [preview, engine]);
  const dmxAt = useMemo(() => createDmxEvaluator(preview, engine), [preview, engine]);
  const placements = useMemo(() => placeFixtures(project.fixtures, project.stage), [project.fixtures, project.stage]);
  const parked = useMemo(() => {
    // 灯具占用的通道里有被锁定的，就画 P 角标
    const status = analyzePatch(project);
    const out = new Set<string>();
    for (const f of project.fixtures) {
      const r = status.get(f.id)?.range;
      if (r && project.output.park.some((p) => p.universe === r.universe && p.channel >= r.start && p.channel <= r.end)) out.add(f.id);
    }
    return out;
  }, [project]);
  // 带 Pan / Tilt 的灯（画光束要读通道值）；其余的灯每帧不必生成灯具表
  const movers = useMemo(() => {
    const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
    const out = new Set<string>();
    for (const f of project.fixtures) {
      const m = models.get(f.modelId);
      const layout = m ? (layoutOf(m, f.modeId) ?? []) : [];
      if (layout.some((p) => p.function === "pan" || p.function === "tilt")) out.add(f.id);
    }
    return out;
  }, [project.fixtures, project.fixtureModels]);

  const fit = fitStage(project.stage, size.width, size.height);
  const view = applyCamera(fit, camera, size.width, size.height);
  // 滚轮监听（非被动）里读最新的换算
  const geomRef = useRef({ fit, width: size.width, height: size.height });
  useEffect(() => {
    geomRef.current = { fit, width: size.width, height: size.height };
  });

  // 从左侧灯具页拖来的模型：放在落点（舞台坐标，米）
  const dropData: StageDropData = {
    kind: "stage",
    toStagePoint: (x, y) => {
      const r = canvasRef.current?.getBoundingClientRect();
      if (!r || r.width === 0) return null;
      return toStage(view, x - r.left, y - r.top);
    },
  };
  const { setNodeRef: setDropRef, isOver, active: dragActive } = useDroppable({ id: STAGE_DROP_ID, data: dropData });
  const dropping = isOver && (dragActive?.data.current as { kind?: string } | undefined)?.kind === "fixtureModel";

  // 拖动中的预览位移（与 `moveFixtures` 同样的吸附规则：吸附作用于第一台灯）
  const fixtureShift = useMemo(() => {
    if (gesture?.kind !== "fixtures" || !gesture.active) return null;
    const lead = placements.get(gesture.ids[0]) ?? { x: 0, y: 0 };
    const s = gesture.free ? 0 : prefs.snapM;
    return { ids: new Set(gesture.ids), dx: snap(lead.x + gesture.dx, s) - lead.x, dy: snap(lead.y + gesture.dy, s) - lead.y };
  }, [gesture, placements, prefs.snapM]);
  const objects = useMemo(() => {
    if (gesture?.kind !== "object" || !gesture.active) return project.stage.objects;
    const s = gesture.free ? 0 : prefs.snapM;
    return project.stage.objects.map((o) =>
      o.id === gesture.id ? { ...o, x: snap(o.x + gesture.dx, s), y: snap(o.y + gesture.dy, s) } : o,
    );
  }, [gesture, project.stage.objects, prefs.snapM]);

  const colors = colorsAt(playheadMs);
  // 只为带 Pan / Tilt 的灯和悬停的灯生成灯具表（灯多时每帧省掉大部分通道换算）
  const frames = new Map<number, Uint8Array>();
  const sheetFixtures = project.fixtures.filter((f) => movers.has(f.id) || f.id === hover);
  const sheet = new Map<string, SheetRow>(
    buildSheet(
      { fixtures: sheetFixtures, fixtureModels: project.fixtureModels },
      (u) => {
        let f = frames.get(u);
        if (!f) {
          f = dmxAt(playheadMs, u);
          frames.set(u, f);
        }
        return f;
      },
      values,
    ).map((r) => [r.fixtureId, r]),
  );
  // 选中像素时高亮它所属的灯具（舞台上每台灯只画一个点）
  const selected = new Set(selectedIds.map(baseOf));
  // 编程器里有整灯或任一像素的值时，舞台上标为已编程
  const programmed = new Set(Object.keys(values).map(baseOf));
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const fixtures: StageFixture[] = project.fixtures.map((f) => {
    const place = placements.get(f.id) ?? { x: 0, y: 0 };
    const shift = fixtureShift?.ids.has(f.id) ? fixtureShift : null;
    const cells = sheet.get(f.id)?.cells;
    return {
      id: f.id,
      name: f.name,
      address: `U${f.universe} @${f.address}`,
      x: place.x + (shift?.dx ?? 0),
      y: place.y + (shift?.dy ?? 0),
      rotation: place.rotation ?? 0,
      hanging: place.hanging === true,
      rgb: colors.get(f.id) ?? [0, 0, 0],
      pan: cells?.get("pan")?.fraction ?? null,
      tilt: cells?.get("tilt")?.fraction ?? null,
      panRange: models.get(f.modelId)?.physical?.panRangeDeg ?? DEFAULT_PAN_RANGE,
      selected: selected.has(f.id),
      programmed: programmed.has(f.id),
      parked: parked.has(f.id),
    };
  });
  const points = fixtures.map((f) => ({ id: f.id, ...toCanvas(view, f.x, f.y) }));

  // 渲染器（策略）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new Canvas2DStageRenderer(canvas);
    rendererRef.current = renderer;
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.resize(size.width, size.height, window.devicePixelRatio || 1);
  }, [size]);

  // 滚轮：以指针为中心缩放（Shift 为横向平移）；需要非被动监听才能阻止页面滚动
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { fit: f, width, height } = geomRef.current;
      if (e.shiftKey) {
        const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        setCamera((c) => ({ ...c, panX: c.panX - delta }));
        return;
      }
      const r = canvas.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setCamera((c) => zoomAt(f, c, width, height, e.clientX - r.left, e.clientY - r.top, factor));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // 每次重新渲染都画一帧（播放时约 30 次 / 秒）；外观变化（revision）也会触发重新渲染，从而重读配色
  useEffect(() => {
    const renderer = rendererRef.current;
    const wrap = wrapRef.current;
    if (!renderer || !wrap || size.width === 0) return;
    renderer.render({
      stage: { ...project.stage, objects },
      view,
      fixtures,
      theme: readTheme(wrap),
      hover: hover ?? sharedHover,
      lasso: gesture?.kind === "lasso" && gesture.active ? gesture : null,
      bloom: prefs.bloom ? 1 : 0,
      editing,
      selectedObject,
      background: background.status === "ready" ? background.image : null,
      backgroundOpacity: prefs.backgroundOpacity,
      gridM: prefs.snapM,
      labels: prefs.labels,
    });
  });
  void revision;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const hitAt = (p: { x: number; y: number }) => hitFixture(points, p.x, p.y, FIXTURE_RADIUS + 4);
  const capture = (e: PointerEvent<HTMLCanvasElement>) => e.currentTarget.setPointerCapture?.(e.pointerId);
  const zoomBy = (factor: number) => setCamera((c) => zoomAt(fit, c, size.width, size.height, size.width / 2, size.height / 2, factor));
  const fitView = () => setCamera(FIT_CAMERA);
  const selectAll = () => setSelected(project.fixtures.map((f) => f.id));
  const clearSelection = () => {
    setSelected([]);
    setSelectedObject(null);
  };

  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    // 中键拖动：平移视图
    if (e.button === 1) {
      e.preventDefault();
      capture(e);
      setGesture({ kind: "pan", sx: e.clientX, sy: e.clientY, panX: camera.panX, panY: camera.panY });
      return;
    }
    if (e.button !== 0) return;
    const p = local(e);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const hit = hitAt(p);
    if (hit) {
      if (additive) {
        setSelected(selected.has(hit) ? selectedIds.filter((x) => x !== hit) : [...selectedIds, hit]);
        return;
      }
      if (!editing) {
        setSelected([hit]);
        return;
      }
      // 拖动已选中的灯时整组一起动，否则只动这一台
      const ids = selected.has(hit) ? project.fixtures.filter((f) => selected.has(f.id)).map((f) => f.id) : [hit];
      if (!selected.has(hit)) setSelected([hit]);
      // 第一台（吸附基准）用按下的那台
      const ordered = [hit, ...ids.filter((id) => id !== hit)];
      setSelectedObject(null);
      capture(e);
      setGesture({ kind: "fixtures", ids: ordered, sx: p.x, sy: p.y, dx: 0, dy: 0, free: e.altKey, active: false });
      return;
    }
    if (editing) {
      const obj = hitObject(project.stage.objects, view, p.x, p.y);
      if (obj) {
        setSelectedObject(obj);
        capture(e);
        setGesture({ kind: "object", id: obj, sx: p.x, sy: p.y, dx: 0, dy: 0, free: e.altKey, active: false });
        return;
      }
      setSelectedObject(null);
    }
    capture(e);
    setGesture({ kind: "lasso", x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive, active: false });
  };

  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    if (!gesture) {
      const hit = hitAt(p);
      setHover(hit);
      setSharedHover(hit);
      return;
    }
    if (gesture.kind === "pan") {
      setCamera((c) => ({ ...c, panX: gesture.panX + e.clientX - gesture.sx, panY: gesture.panY + e.clientY - gesture.sy }));
      return;
    }
    if (gesture.kind === "lasso") {
      const active = gesture.active || Math.hypot(p.x - gesture.x0, p.y - gesture.y0) >= DRAG_THRESHOLD;
      setGesture({ ...gesture, x1: p.x, y1: p.y, active });
      return;
    }
    const active = gesture.active || Math.hypot(p.x - gesture.sx, p.y - gesture.sy) >= DRAG_THRESHOLD;
    // 画布 y 向下，舞台 y 向后（画布上方）
    setGesture({ ...gesture, dx: (p.x - gesture.sx) / view.scale, dy: (gesture.sy - p.y) / view.scale, free: e.altKey, active });
  };

  const onUp = () => {
    const g = gesture;
    setGesture(null);
    if (!g || g.kind === "pan") return;
    if (g.kind === "lasso") {
      if (g.active) {
        const hits = lassoFixtures(points, { x: g.x0, y: g.y0 }, { x: g.x1, y: g.y1 });
        setSelected(g.additive ? [...new Set([...selectedIds, ...hits])] : hits);
      } else if (!g.additive) {
        setSelected([]);
      }
      return;
    }
    if (!g.active) return;
    if (g.kind === "fixtures") {
      update((d) => moveFixtures(d, g.ids, g.dx, g.dy, snapStep(g.free)));
    } else {
      const o = project.stage.objects.find((x) => x.id === g.id);
      if (o) {
        const s = snapStep(g.free);
        update((d) => updateStageObject(d, g.id, { x: snap(o.x + g.dx, s), y: snap(o.y + g.dy, s) }));
      }
    }
  };

  /**
   * 画布的键盘：Ctrl+A 全选、Esc 取消选择、+ / − / F 缩放与适应窗口；
   * 布置模式下方向键微调选中的物件或灯具、Delete 删除选中的物件，否则方向键平移视图。
   * 处理过的按键阻止默认行为（全局快捷键不再响应）。
   */
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a") {
      selectAll();
      e.preventDefault();
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === "Escape") {
      if (selectedIds.length === 0 && !selectedObject) return;
      clearSelection();
      e.preventDefault();
      return;
    }
    if (e.key === "+" || e.key === "=") {
      zoomBy(ZOOM_STEP);
      e.preventDefault();
      return;
    }
    if (e.key === "-" || e.key === "_") {
      zoomBy(1 / ZOOM_STEP);
      e.preventDefault();
      return;
    }
    if (e.key === "f" || e.key === "F" || e.key === "Home") {
      fitView();
      e.preventDefault();
      return;
    }
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const dir = dirs[e.key];
    if (dir && !editing) {
      setCamera((c) => ({ ...c, panX: c.panX - dir[0] * PAN_STEP_PX, panY: c.panY + dir[1] * PAN_STEP_PX }));
      e.preventDefault();
      return;
    }
    if (!editing) return;
    if (dir) {
      const m = e.shiftKey ? NUDGE_BIG_M : NUDGE_M;
      const [dx, dy] = [dir[0] * m, dir[1] * m];
      if (selectedObject) {
        const o = project.stage.objects.find((x) => x.id === selectedObject);
        if (o) update((d) => updateStageObject(d, o.id, { x: o.x + dx, y: o.y + dy }));
      } else if (selectedIds.length > 0) {
        update((d) => moveFixtures(d, selectedIds, dx, dy));
      } else {
        return;
      }
      e.preventDefault();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedObject) {
      update((d) => removeStageObject(d, selectedObject));
      setSelectedObject(null);
      e.preventDefault();
    }
  };

  // ---- 右键菜单 ----
  const menuIds = menuTarget ? (selected.has(menuTarget) ? project.fixtures.filter((f) => selected.has(f.id)).map((f) => f.id) : [menuTarget]) : [];
  const menuFixture = menuTarget ? project.fixtures.find((f) => f.id === menuTarget) : undefined;
  const programmedRefsOf = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const f = project.fixtures.find((x) => x.id === id);
      return f ? [id, ...pixelRefsOf(project, f)] : [];
    });

  const hovered = fixtures.find((f) => f.id === hover);
  const hoveredCells = hovered ? sheet.get(hovered.id)?.cells : undefined;
  const intensity = hoveredCells?.get("dimmer")?.fraction;

  const toggle = (label: string, on: boolean, onClick: () => void, icon: ReactNode, tone?: "warn") => (
    <button
      type="button"
      aria-pressed={on}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px] backdrop-blur-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on
          ? tone === "warn"
            ? "border-destructive bg-destructive/80 text-destructive-foreground"
            : "border-primary bg-primary/25 text-foreground"
          : "border-border bg-background/60 text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const hudButton = (label: string, onClick: () => void, icon: ReactNode) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
    >
      {icon}
    </button>
  );

  const cursor =
    gesture?.kind === "pan" || gesture?.kind === "fixtures" || gesture?.kind === "object"
      ? "cursor-grabbing"
      : editing && hover
        ? "cursor-grab"
        : "cursor-default";
  const zoomPercent = Math.round(camera.zoom * 100);

  return (
    <div className="flex h-full min-h-48 w-full flex-col">
      <div
        ref={(el) => {
          wrapRef.current = el;
          setDropRef(el);
        }}
        className="relative min-h-0 flex-1 overflow-hidden bg-stage-bg"
      >
        <ContextMenu onOpenChange={(open) => !open && setMenuTarget(null)}>
          <ContextMenuTrigger asChild>
            <canvas
              ref={canvasRef}
              role="application"
              tabIndex={0}
              aria-roledescription={t("editor.stage.roleDescription")}
              aria-label={t(editing ? "editor.stage.labelEditing" : "editor.stage.label", {
                count: project.fixtures.length,
                selected: selectedIds.length,
              })}
              className={cn("absolute inset-0 h-full w-full touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", cursor)}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => setGesture(null)}
              onPointerLeave={() => {
                setHover(null);
                setSharedHover(null);
              }}
              onKeyDown={onKeyDown}
              onContextMenu={(e) => setMenuTarget(hitAt(local(e)))}
              onDoubleClick={(e) => {
                const hit = hitAt(local(e));
                if (hit) {
                  setSelected([hit]);
                  useEditorUiStore.getState().setInspectorTab("program");
                }
              }}
            />
          </ContextMenuTrigger>
          <ContextMenuContent aria-label={t("editor.stage.menu.label")}>
            {menuFixture && (
              <>
                <ContextMenuItem onSelect={() => setSelected([menuFixture.id])}>{t("editor.swatches.menuSelectOnly")}</ContextMenuItem>
                <ContextMenuItem onSelect={() => setSelected(sameModelIds(project, menuIds))}>{t("editor.stage.menu.sameModel")}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => void toggleLocate(menuFixture.id)}>
                  {t(locateId === menuFixture.id ? "editor.swatches.menuLocateStop" : "editor.swatches.menuLocate")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => revealInPatch(menuIds)}>{t("editor.swatches.menuReveal")}</ContextMenuItem>
                <ContextMenuItem
                  disabled={!menuIds.some((id) => programmed.has(id))}
                  onSelect={() => {
                    setValues(knockout(values, programmedRefsOf(menuIds)));
                    announce(t("editor.programmer.knocked", { count: menuIds.length }));
                  }}
                >
                  {t("editor.swatches.menuKnockout", { count: menuIds.length })}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={!project.fixtures.some((f) => menuIds.includes(f.id) && f.stage)}
                  onSelect={() => {
                    update((d) => resetPlacements(d, menuIds));
                    announce(t("editor.stage.menu.resetDone", { count: menuIds.length }));
                  }}
                >
                  {t("editor.stage.menu.reset", { count: menuIds.length })}
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            <ContextMenuItem disabled={project.fixtures.length === 0} onSelect={selectAll}>
              {t("editor.stage.menu.selectAll")}
              <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem disabled={selectedIds.length === 0} onSelect={clearSelection}>
              {t("editor.stage.menu.clearSelection")}
              <ContextMenuShortcut>Esc</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={fitView}>
              {t("editor.stage.zoom.fit")}
              <ContextMenuShortcut>F</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {dropping && (
          <div className="pointer-events-none absolute inset-1 z-10 flex items-end justify-center rounded-md border-2 border-dashed border-primary pb-3">
            <span className="rounded bg-background/80 px-2 py-0.5 text-[11px] text-primary">{t("editor.stage.dropHint")}</span>
          </div>
        )}
        {project.fixtures.length === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-xs text-muted-foreground">
            {t("editor.preview.empty")}
          </p>
        )}
        {/* HUD */}
        <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1">
          <span className="num rounded bg-background/60 px-1.5 py-0.5 text-[11px] text-foreground backdrop-blur-sm">
            {formatTimecode(playheadMs)}
          </span>
          <span className="rounded bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground backdrop-blur-sm">
            {t("editor.stage.selection", { count: selectedIds.length, total: project.fixtures.length })}
          </span>
        </div>
        <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
          <div className="flex gap-1">
            {toggle(t("editor.stage.layoutMode"), editing, () => setEditing(!editing), <Move aria-hidden className="size-3" />)}
            {toggle(t("editor.stage.bloom"), prefs.bloom, () => setPrefs({ bloom: !prefs.bloom }), <Sparkle aria-hidden className="size-3" />)}
            {toggle(t("editor.stage.blind"), !live, () => setLive(!live), <EyeOff aria-hidden className="size-3" />)}
            {toggle(t("editor.stage.blackout"), blackout, () => setBlackout(!blackout), <Power aria-hidden className="size-3" />, "warn")}
          </div>
          <div role="toolbar" aria-label={t("editor.stage.zoom.toolbar")} className="flex items-center rounded-md border border-border bg-background/60 backdrop-blur-sm">
            {hudButton(t("editor.stage.zoom.out"), () => zoomBy(1 / ZOOM_STEP), <Minus aria-hidden />)}
            <span className="num w-10 text-center text-[11px] text-muted-foreground" aria-live="polite" aria-label={t("editor.stage.zoom.level", { percent: zoomPercent })}>
              {zoomPercent}%
            </span>
            {hudButton(t("editor.stage.zoom.in"), () => zoomBy(ZOOM_STEP), <Plus aria-hidden />)}
            {hudButton(t("editor.stage.zoom.fit"), fitView, <Maximize aria-hidden />)}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("editor.stage.view.title")}
                  title={t("editor.stage.view.title")}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5"
                >
                  <Settings2 aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="text-xs">{t("editor.stage.view.labels")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={prefs.labels} onValueChange={(v) => setPrefs({ labels: v as StageLabel })}>
                  {STAGE_LABELS.map((l) => (
                    <DropdownMenuRadioItem key={l} value={l} className="text-xs">
                      {t(`editor.stage.view.labelModes.${l}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs">{t("editor.stage.view.snap")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={String(prefs.snapM)} onValueChange={(v) => setPrefs({ snapM: Number(v) })}>
                  {STAGE_SNAP_STEPS.map((s) => (
                    <DropdownMenuRadioItem key={s} value={String(s)} className="text-xs">
                      {s === 0 ? t("editor.stage.view.snapOff") : t("editor.stage.view.snapM", { m: s })}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {project.stage.backgroundPath && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs">{t("editor.stage.view.backgroundOpacity")}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={String(prefs.backgroundOpacity)} onValueChange={(v) => setPrefs({ backgroundOpacity: Number(v) })}>
                      {BACKGROUND_OPACITIES.map((o) => (
                        <DropdownMenuRadioItem key={o} value={String(o)} className="text-xs">
                          {Math.round(o * 100)}%
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <HelpTip topic="editor.help.stage" className="size-7" />
          </div>
        </div>
        {hovered && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-2 left-2 rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] backdrop-blur-sm"
          >
            <span className="font-medium">{hovered.name}</span>
            <span className="num ml-2 text-muted-foreground">
              {hovered.address} ·{" "}
              {intensity !== undefined && `${t("editor.look.intensity")} ${Math.round(intensity * 100)}% · `}
              RGB {hovered.rgb.join(" ")}
              {hovered.pan !== null && ` · Pan ${Math.round(hovered.pan * 100)}%`}
              {hovered.tilt !== null && ` · Tilt ${Math.round(hovered.tilt * 100)}%`}
              {editing && ` · ${hovered.x.toFixed(2)} m, ${hovered.y.toFixed(2)} m`}
            </span>
          </div>
        )}
        {(blackout || !outputEnabled) && (
          <div className="pointer-events-none absolute bottom-2 right-2 flex flex-col items-end gap-1">
            {/* 输出关闭：只在本机预览，灯不会跟着变 */}
            {!outputEnabled && (
              <span className="rounded border border-warning/40 bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning backdrop-blur-sm">
                {t("editor.stage.previewOnly")}
              </span>
            )}
            {blackout && (
              <span className="rounded bg-destructive px-2 py-0.5 text-[11px] font-medium text-destructive-foreground">
                {t("editor.stage.blackoutOn")}
              </span>
            )}
          </div>
        )}
        {/* 键盘 / 读屏：等价的灯具列表 */}
        <ul className="sr-only" aria-label={t("editor.stage.list")}>
          {fixtures.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                aria-pressed={f.selected}
                onClick={(e) =>
                  setSelected(e.ctrlKey || e.metaKey ? (f.selected ? selectedIds.filter((x) => x !== f.id) : [...selectedIds, f.id]) : [f.id])
                }
              >
                {t("editor.stage.fixtureItem", { name: f.name, r: f.rgb[0], g: f.rgb[1], b: f.rgb[2] })}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {editing && <StageLayoutBar selectedObjectId={selectedObject} onSelectObject={setSelectedObject} background={background} />}
    </div>
  );
}
