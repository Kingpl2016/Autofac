import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDroppable } from "@dnd-kit/core";
import { EyeOff, Move, Power, Sparkle } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppearanceRevision } from "@/features/appearance";
import { useEngine } from "../engine/useEngine";
import { STAGE_DROP_ID, type StageDropData } from "../hooks/fixtureDrop";
import { usePreviewProject } from "../hooks/usePreviewProject";
import { createPreviewEvaluator } from "../lib/color";
import { createDmxEvaluator } from "../lib/dmxPreview";
import { buildSheet } from "../lib/fixtureSheet";
import { analyzePatch } from "../lib/patch";
import { moveFixtures, removeStageObject, snap, STAGE_SNAP_M, updateStageObject } from "../lib/stageOps";
import { formatTimecode } from "../lib/time";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProgrammerStore } from "../stores/useProgrammerStore";
import { useProjectStore } from "../stores/useProjectStore";
import { StageLayoutBar } from "./StageLayoutBar";
import { Canvas2DStageRenderer, FIXTURE_RADIUS, type StageFixture, type StageRenderer, type StageTheme } from "./StageRenderer";
import { fitStage, hitFixture, hitObject, lassoFixtures, placeFixtures, toCanvas, toStage } from "./stageGeometry";
import { useStageBackground } from "./useStageBackground";

/** 默认 Pan 行程（度）：模型没有物理参数时。 */
const DEFAULT_PAN_RANGE = 540;
/** 指针移动超过这个距离才算拖动 / 框选。 */
const DRAG_THRESHOLD = 4;
/** 键盘微调步长（米）：普通 / Shift。 */
const NUDGE_M = 0.1;
const NUDGE_BIG_M = 1;

/** 拖动吸附步长：按住 Alt（`free`）时不吸附。 */
function step(free: boolean): number {
  return free ? 0 : STAGE_SNAP_M;
}

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
  | { kind: "object"; id: string; sx: number; sy: number; dx: number; dy: number; free: boolean; active: boolean };

/**
 * 舞台监视器（俯视）：每台灯按舞台位置画出实际输出颜色、光晕和摇头灯的光束方向，与后端输出同一份引擎求值，
 * 叠加编程器；点选 / 框选灯具（与编程器共用选择），悬停显示数值；HUD 上可开关黑场、盲改、光晕。
 *
 * “布置”模式下可拖动灯具和布景物件（吸附 0.25 m，按住 Alt 自由移动；方向键微调，Shift 加大步长），
 * 底部工具条添加物件、改舞台尺寸 / 背景图、对齐排列选中的灯。
 *
 * 渲染经 [`StageRenderer`] 接口，当前是 Canvas2D 实现。
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
  const setBlackout = useEditorUiStore((s) => s.setBlackout);
  const values = useProgrammerStore((s) => s.values);
  const live = useProgrammerStore((s) => s.live);
  const setLive = useProgrammerStore((s) => s.setLive);
  const engine = useEngine();
  const revision = useAppearanceRevision();
  const background = useStageBackground(project.stage.backgroundPath);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<string | null>(null);
  // 别处（Universe 视图、通道格）悬停的灯具：在舞台上一并高亮
  const sharedHover = useEditorUiStore((s) => s.hoverFixtureId);
  const setSharedHover = useEditorUiStore((s) => s.setHoverFixture);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [bloom, setBloom] = useState(true);
  const [editing, setEditing] = useState(false);
  const [selectedObjectRaw, setSelectedObject] = useState<string | null>(null);
  // 物件被删除（撤销等）后自动失效
  const selectedObject = project.stage.objects.some((o) => o.id === selectedObjectRaw) ? selectedObjectRaw : null;

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

  const view = fitStage(project.stage, size.width, size.height);

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
    const s = step(gesture.free);
    return { ids: new Set(gesture.ids), dx: snap(lead.x + gesture.dx, s) - lead.x, dy: snap(lead.y + gesture.dy, s) - lead.y };
  }, [gesture, placements]);
  const objects = useMemo(() => {
    if (gesture?.kind !== "object" || !gesture.active) return project.stage.objects;
    const s = step(gesture.free);
    return project.stage.objects.map((o) =>
      o.id === gesture.id ? { ...o, x: snap(o.x + gesture.dx, s), y: snap(o.y + gesture.dy, s) } : o,
    );
  }, [gesture, project.stage.objects]);

  const colors = colorsAt(playheadMs);
  const frames = new Map<number, Uint8Array>();
  const sheet = buildSheet(
    project,
    (u) => {
      let f = frames.get(u);
      if (!f) {
        f = dmxAt(playheadMs, u);
        frames.set(u, f);
      }
      return f;
    },
    values,
  );
  const selected = new Set(selectedIds);
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const fixtures: StageFixture[] = project.fixtures.map((f, i) => {
    const place = placements.get(f.id) ?? { x: 0, y: 0 };
    const shift = fixtureShift?.ids.has(f.id) ? fixtureShift : null;
    const cells = sheet[i]?.cells;
    return {
      id: f.id,
      name: f.name,
      x: place.x + (shift?.dx ?? 0),
      y: place.y + (shift?.dy ?? 0),
      rotation: place.rotation ?? 0,
      hanging: place.hanging === true,
      rgb: colors.get(f.id) ?? [0, 0, 0],
      pan: cells?.get("pan")?.fraction ?? null,
      tilt: cells?.get("tilt")?.fraction ?? null,
      panRange: models.get(f.modelId)?.physical?.panRangeDeg ?? DEFAULT_PAN_RANGE,
      selected: selected.has(f.id),
      programmed: values[f.id] !== undefined,
      parked: parked.has(f.id),
    };
  });
  const points = fixtures.map((f) => ({ id: f.id, ...toCanvas(view, f.x, f.y) }));

  // 画布尺寸
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
      bloom: bloom ? 1 : 0,
      editing,
      selectedObject,
      background: background.status === "ready" ? background.image : null,
    });
  });
  void revision;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const hitAt = (p: { x: number; y: number }) => hitFixture(points, p.x, p.y, FIXTURE_RADIUS + 4);
  const capture = (e: PointerEvent<HTMLCanvasElement>) => e.currentTarget.setPointerCapture?.(e.pointerId);

  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
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
    if (!g) return;
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
      update((d) => moveFixtures(d, g.ids, g.dx, g.dy, step(g.free)));
    } else {
      const o = project.stage.objects.find((x) => x.id === g.id);
      if (o) {
        const s = step(g.free);
        update((d) => updateStageObject(d, g.id, { x: snap(o.x + g.dx, s), y: snap(o.y + g.dy, s) }));
      }
    }
  };

  /** 布置模式的键盘：方向键微调选中的物件或灯具，Delete 删除选中的物件。 */
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (!editing) return;
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const dir = dirs[e.key];
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

  const hovered = fixtures.find((f) => f.id === hover);
  const hoveredCells = hovered ? sheet.find((r) => r.fixtureId === hovered.id)?.cells : undefined;
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

  const cursor =
    gesture?.kind === "fixtures" || gesture?.kind === "object" ? "cursor-grabbing" : editing && hover ? "cursor-grab" : "cursor-default";

  return (
    <div className="flex h-full min-h-48 w-full flex-col">
      <div
        ref={(el) => {
          wrapRef.current = el;
          setDropRef(el);
        }}
        className="relative min-h-0 flex-1 overflow-hidden bg-stage-bg"
      >
        <canvas
          ref={canvasRef}
          role="img"
          tabIndex={editing ? 0 : -1}
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
          onDoubleClick={(e) => {
            const hit = hitAt(local(e));
            if (hit) {
              setSelected([hit]);
              useEditorUiStore.getState().setInspectorTab("program");
            }
          }}
        />
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
        <div className="absolute right-2 top-2 flex gap-1">
          {toggle(t("editor.stage.layoutMode"), editing, () => setEditing(!editing), <Move aria-hidden className="size-3" />)}
          {toggle(t("editor.stage.bloom"), bloom, () => setBloom(!bloom), <Sparkle aria-hidden className="size-3" />)}
          {toggle(t("editor.stage.blind"), !live, () => setLive(!live), <EyeOff aria-hidden className="size-3" />)}
          {toggle(t("editor.stage.blackout"), blackout, () => setBlackout(!blackout), <Power aria-hidden className="size-3" />, "warn")}
        </div>
        {hovered && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-2 left-2 rounded-md border border-border bg-background/80 px-2 py-1 text-[11px] backdrop-blur-sm"
          >
            <span className="font-medium">{hovered.name}</span>
            <span className="num ml-2 text-muted-foreground">
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
