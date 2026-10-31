import type { FixtureInstance, StageLayout, StageObject, StagePlacement } from "../lib/project";

/**
 * 舞台监视器的纯几何：舞台坐标（米）与画布像素的换算、没有摆放位置的灯具自动排布、点选与框选。
 *
 * 舞台坐标：原点在舞台前沿中央，x 向右，y 向后（纵深）；俯视图里观众在下方，所以画布上 y 越大越靠上。
 */

/** 画布到舞台的换算。 */
export interface StageView {
  /** 每米像素数 */
  scale: number;
  /** 舞台中心线（x = 0）在画布上的横坐标 */
  originX: number;
  /** 舞台前沿（y = 0）在画布上的纵坐标 */
  originY: number;
}

/** 舞台四周留白（像素）。 */
export const STAGE_PADDING = 24;

/**
 * 让整个舞台居中放进画布。
 *
 * @param stage 舞台。
 * @param width 画布宽（CSS 像素）。
 * @param height 画布高。
 * @returns 换算。
 */
export function fitStage(stage: Pick<StageLayout, "width" | "depth">, width: number, height: number): StageView {
  const w = Math.max(1, stage.width);
  const d = Math.max(1, stage.depth);
  const scale = Math.max(1, Math.min((width - STAGE_PADDING * 2) / w, (height - STAGE_PADDING * 2) / d));
  return { scale, originX: width / 2, originY: height / 2 + (d * scale) / 2 };
}

/** 视图的缩放与平移（相对“适应窗口”）：`zoom` 1 为整个舞台放进画布，平移为画布像素。 */
export interface StageCamera {
  zoom: number;
  panX: number;
  panY: number;
}

/** 适应窗口（不缩放、不平移）。 */
export const FIT_CAMERA: StageCamera = { zoom: 1, panX: 0, panY: 0 };

/** 缩放范围（相对适应窗口）。 */
export const ZOOM_RANGE = { min: 0.25, max: 8 } as const;

/**
 * 在“适应窗口”的换算上叠加缩放与平移：以画布中心为缩放中心，再平移。
 *
 * @param fit 适应窗口的换算（{@link fitStage}）。
 * @param camera 缩放与平移。
 * @param width 画布宽。
 * @param height 画布高。
 * @returns 实际使用的换算。
 */
export function applyCamera(fit: StageView, camera: StageCamera, width: number, height: number): StageView {
  const cx = width / 2;
  const cy = height / 2;
  return {
    scale: fit.scale * camera.zoom,
    originX: cx + (fit.originX - cx) * camera.zoom + camera.panX,
    originY: cy + (fit.originY - cy) * camera.zoom + camera.panY,
  };
}

/**
 * 以指针为中心缩放：指针下的舞台点缩放前后保持在同一个画布位置。
 *
 * @param fit 适应窗口的换算。
 * @param camera 当前缩放与平移。
 * @param width 画布宽。
 * @param height 画布高。
 * @param px 指针 x（画布）。
 * @param py 指针 y（画布）。
 * @param factor 缩放倍数（> 1 放大）。
 * @returns 新的缩放与平移（缩放夹在 {@link ZOOM_RANGE} 内）。
 */
export function zoomAt(
  fit: StageView,
  camera: StageCamera,
  width: number,
  height: number,
  px: number,
  py: number,
  factor: number,
): StageCamera {
  const zoom = Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, camera.zoom * (Number.isFinite(factor) && factor > 0 ? factor : 1)));
  const s = toStage(applyCamera(fit, camera, width, height), px, py);
  const cx = width / 2;
  const cy = height / 2;
  const scale = fit.scale * zoom;
  return {
    zoom,
    panX: px - (cx + (fit.originX - cx) * zoom + s.x * scale),
    panY: py - (cy + (fit.originY - cy) * zoom - s.y * scale),
  };
}

/**
 * 舞台坐标 → 画布坐标。
 *
 * @param view 换算。
 * @param x 舞台 x（米）。
 * @param y 舞台 y（米）。
 * @returns 画布坐标。
 */
export function toCanvas(view: StageView, x: number, y: number): { x: number; y: number } {
  return { x: view.originX + x * view.scale, y: view.originY - y * view.scale };
}

/**
 * 画布坐标 → 舞台坐标。
 *
 * @param view 换算。
 * @param px 画布 x。
 * @param py 画布 y。
 * @returns 舞台坐标（米）。
 */
export function toStage(view: StageView, px: number, py: number): { x: number; y: number } {
  return { x: (px - view.originX) / view.scale, y: (view.originY - py) / view.scale };
}

/**
 * 没有摆放位置的灯具按顺序排成网格（与引擎“按舞台位置分布”的默认排布无关，只用于显示）。
 * 已摆放的灯具保持原位。
 *
 * @param fixtures 灯具（工程顺序）。
 * @param stage 舞台。
 * @returns 灯具 id → 位置。
 */
export function placeFixtures(
  fixtures: readonly Pick<FixtureInstance, "id" | "stage">[],
  stage: Pick<StageLayout, "width" | "depth">,
): Map<string, StagePlacement> {
  const out = new Map<string, StagePlacement>();
  const loose = fixtures.filter((f) => !f.stage);
  const n = loose.length;
  if (n > 0) {
    const aspect = Math.max(0.1, stage.width / Math.max(0.1, stage.depth));
    const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * aspect))));
    const rows = Math.ceil(n / cols);
    loose.forEach((f, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      // 每行居中；从舞台后方往前排（第一排在最后面，像挂在顶上的灯杆）
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const x = ((c + 0.5) / inRow - 0.5) * stage.width * 0.9;
      const y = stage.depth * (1 - (r + 0.5) / rows);
      out.set(f.id, { x, y });
    });
  }
  for (const f of fixtures) if (f.stage) out.set(f.id, f.stage);
  return out;
}

/** 画布上的一台灯具（点选用）。 */
export interface PlacedPoint {
  id: string;
  x: number;
  y: number;
}

/**
 * 点选：离指针最近、且在 `radius` 像素以内的灯具。
 *
 * @param points 灯具在画布上的位置。
 * @param px 指针 x。
 * @param py 指针 y。
 * @param radius 命中半径（像素）。
 * @returns 灯具 id；没有命中时为 `null`。
 */
export function hitFixture(points: readonly PlacedPoint[], px: number, py: number, radius: number): string | null {
  let best: string | null = null;
  let bestD = radius;
  for (const p of points) {
    const d = Math.hypot(p.x - px, p.y - py);
    if (d <= bestD) {
      best = p.id;
      bestD = d;
    }
  }
  return best;
}

/**
 * 框选：落在矩形里的灯具。
 *
 * @param points 灯具在画布上的位置。
 * @param a 一个角。
 * @param b 对角。
 * @returns 灯具 id（保持输入顺序）。
 */
export function lassoFixtures(
  points: readonly PlacedPoint[],
  a: { x: number; y: number },
  b: { x: number; y: number },
): string[] {
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return points.filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1).map((p) => p.id);
}

/**
 * 光束方向与长度（俯视示意）：Pan 决定方向，Tilt 偏离垂直越多光束投得越远。
 *
 * @param pan Pan（0~1，0.5 为正前方）。
 * @param tilt Tilt（0~1，0.5 为垂直向下）。
 * @param panRangeDeg Pan 总行程（度）。
 * @param rotationDeg 灯具水平朝向（度）。
 * @returns 方向（弧度，画布坐标系，0 指向观众方向即画布下方）与长度系数（0~1）。
 */
export function beamOf(pan: number, tilt: number, panRangeDeg: number, rotationDeg = 0): { angle: number; reach: number } {
  const deg = (pan - 0.5) * panRangeDeg + rotationDeg;
  return { angle: (deg * Math.PI) / 180, reach: Math.min(1, Math.abs(tilt - 0.5) * 2) };
}

/**
 * 点选布景物件：把指针换算到物件自身坐标系（考虑旋转）判断是否落在矩形 / 圆内。后加的物件画在上面，优先命中。
 *
 * @param objects 布景物件。
 * @param view 换算。
 * @param px 指针 x（画布）。
 * @param py 指针 y（画布）。
 * @param tolerancePx 容差（像素），细长的桁架也好点。
 * @returns 物件 id；没有命中时为 `null`。
 */
export function hitObject(
  objects: readonly StageObject[],
  view: StageView,
  px: number,
  py: number,
  tolerancePx = 4,
): string | null {
  const s = toStage(view, px, py);
  const tol = tolerancePx / view.scale;
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const o = objects[i];
    const dx = s.x - o.x;
    const dy = s.y - o.y;
    if (o.kind === "circle" || o.kind === "pillar") {
      if (Math.hypot(dx, dy) <= o.w / 2 + tol) return o.id;
      continue;
    }
    const a = (o.rotation * Math.PI) / 180;
    const lx = dx * Math.cos(a) + dy * Math.sin(a);
    const ly = -dx * Math.sin(a) + dy * Math.cos(a);
    if (o.kind === "polygon" && o.points && o.points.length >= 3) {
      if (pointInPolygon(o.points, lx, ly) || nearPolygonEdge(o.points, lx, ly, tol)) return o.id;
      continue;
    }
    if (Math.abs(lx) <= o.w / 2 + tol && Math.abs(ly) <= o.h / 2 + tol) return o.id;
  }
  return null;
}

/**
 * 点是否在多边形内（射线法，非零 / 奇偶在简单多边形上一致）。
 *
 * @param pts 顶点。
 * @param x 点 x。
 * @param y 点 y。
 * @returns 是否在内部。
 */
export function pointInPolygon(pts: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 点到多边形任一条边的距离是否在容差内。 */
function nearPolygonEdge(pts: readonly (readonly [number, number])[], x: number, y: number, tol: number): boolean {
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j];
    const [bx, by] = pts[i];
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0;
    if (Math.hypot(x - ax - vx * t, y - ay - vy * t) <= tol) return true;
  }
  return false;
}

/**
 * 点选多边形物件的顶点手柄（编辑顶点用）。
 *
 * @param o 多边形物件。
 * @param view 换算。
 * @param px 指针 x（画布）。
 * @param py 指针 y（画布）。
 * @param tolerancePx 容差（像素）。
 * @returns 顶点下标；没有命中时为 `-1`。
 */
export function hitPolygonVertex(o: StageObject, view: StageView, px: number, py: number, tolerancePx = 6): number {
  if (o.kind !== "polygon" || !o.points) return -1;
  const s = toStage(view, px, py);
  const { x, y } = objectLocal(o, s.x, s.y);
  const tol = tolerancePx / view.scale;
  return o.points.findIndex(([vx, vy]) => Math.abs(vx - x) <= tol && Math.abs(vy - y) <= tol);
}

/**
 * 舞台坐标换算到物件自身坐标（相对中心、旋转前）。
 *
 * @param o 物件。
 * @param x 舞台 x。
 * @param y 舞台 y。
 * @returns 本地坐标。
 */
export function objectLocal(o: Pick<StageObject, "x" | "y" | "rotation">, x: number, y: number): { x: number; y: number } {
  const a = (o.rotation * Math.PI) / 180;
  const dx = x - o.x;
  const dy = y - o.y;
  return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
}
