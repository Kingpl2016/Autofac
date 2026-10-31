import { placeFixtures } from "../stage/stageGeometry";
import { newId } from "./ids";
import type { ScreenContent, ShowProject, StageObject, StagePlacement, StageVenue } from "./project";

/**
 * 舞台布置的编辑操作（在 immer 草稿上执行，一次调用 = 一步撤销）：舞台尺寸、灯具摆位（拖动、
 * 微调、对齐排列、朝向 / 吊挂）、布景物件增删改、背景图。
 *
 * 坐标单位为米，原点在舞台前沿中央，x 向右、y 向后。
 */

/** 舞台宽 / 纵深的范围（米）。 */
export const STAGE_SIZE_RANGE = { min: 1, max: 200 } as const;

/** 台面高度的范围（米，与工程校验一致）。 */
const DECK_RANGE = { min: 0, max: 20 } as const;
/** 灯具安装高度与物件离地高度 / 自身高度的范围（米）。 */
const HEIGHT_RANGE = { min: 0, max: 100 } as const;
/** 俯仰安装角的范围（度）。 */
const PITCH_RANGE = { min: -90, max: 90 } as const;

/** 夹取并去掉浮点尾数。 */
function clampNum(v: number, r: { min: number; max: number }): number {
  return snap(Math.min(r.max, Math.max(r.min, v)), 0.001);
}

/** 布景物件省略自身高度时的默认值（米）：桁架按截面、平台按常见台阶高度、文字不占高度。 */
const OBJECT_HEIGHT: Record<StageObject["kind"], number> = {
  truss: 0.3,
  rect: 0.4,
  circle: 0.4,
  label: 0,
  screen: 3,
  stairs: 0.8,
  pillar: 4,
  polygon: 0.4,
};

/**
 * 布景物件的自身高度（米）：没填时按类型取默认值。
 *
 * @param o 物件。
 * @returns 竖直方向的厚度。
 */
export function objectHeight(o: Pick<StageObject, "kind" | "height">): number {
  return o.height ?? OBJECT_HEIGHT[o.kind];
}

/**
 * 设置舞台台面高度（米，夹到 0~20；0 时省略字段）。
 *
 * @param d 工程草稿。
 * @param height 台面高度。
 */
export function setStageHeight(d: ShowProject, height: number): void {
  if (!Number.isFinite(height)) return;
  const h = clampNum(height, DECK_RANGE);
  if (h === 0) delete d.stage.height;
  else d.stage.height = h;
}

/** 新建布景物件的默认尺寸（米）。 */
const OBJECT_DEFAULTS: Record<StageObject["kind"], { w: number; h: number }> = {
  truss: { w: 6, h: 0.3 },
  rect: { w: 2, h: 1 },
  circle: { w: 2, h: 2 },
  label: { w: 2, h: 0.5 },
  screen: { w: 5, h: 0.2 },
  stairs: { w: 2, h: 1.2 },
  pillar: { w: 0.4, h: 0.4 },
  polygon: { w: 3, h: 2 },
};

/** 台阶级数的范围。 */
const STEPS_RANGE = { min: 1, max: 50 } as const;
/** 台阶省略级数时的默认值。 */
export const DEFAULT_STAIR_STEPS = 4;
/** 多边形顶点数的范围。 */
export const POLYGON_POINTS_RANGE = { min: 3, max: 64 } as const;
/** 烟雾浓度省略时的默认值。 */
export const DEFAULT_HAZE = 0.35;

/**
 * 正多边形的顶点（相对中心的本地坐标，第一个顶点在正后方，逆时针）。
 *
 * @param sides 边数（夹到 3~64）。
 * @param w 包围宽度（米）。
 * @param h 包围纵深（米）。
 * @returns 顶点列表。
 */
export function regularPolygon(sides: number, w: number, h: number): [number, number][] {
  const n = Math.round(Math.min(POLYGON_POINTS_RANGE.max, Math.max(POLYGON_POINTS_RANGE.min, sides)));
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([snap((-Math.sin(a) * w) / 2, 0.001), snap((Math.cos(a) * h) / 2, 0.001)]);
  }
  return pts;
}

/**
 * 顶点的包围盒尺寸。
 *
 * @param pts 顶点。
 * @returns 宽与纵深（米）。
 */
function pointsExtent(pts: readonly [number, number][]): { w: number; h: number } {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { w: snap(Math.max(...xs) - Math.min(...xs), 0.001), h: snap(Math.max(...ys) - Math.min(...ys), 0.001) };
}

/**
 * 吸附到步长的整数倍。
 *
 * @param value 数值。
 * @param step 步长；不大于 0 时原样返回。
 * @returns 吸附后的值（消除 -0 和浮点尾数）。
 */
export function snap(value: number, step: number): number {
  if (step <= 0) return value;
  const v = Math.round(value / step) * step;
  return Number(v.toFixed(4)) + 0;
}

/**
 * 夹在舞台范围内（允许超出边缘一米，例如侧台、台口外的灯）。
 *
 * @param stage 舞台尺寸。
 * @param x 舞台 x。
 * @param y 舞台 y。
 * @returns 夹取后的坐标。
 */
export function clampToStage(stage: { width: number; depth: number }, x: number, y: number): { x: number; y: number } {
  const half = stage.width / 2 + 1;
  return { x: Math.min(half, Math.max(-half, x)), y: Math.min(stage.depth + 1, Math.max(-1, y)) };
}

/**
 * 设置舞台尺寸（夹到 {@link STAGE_SIZE_RANGE}）。
 *
 * @param d 工程草稿。
 * @param width 宽（米）。
 * @param depth 纵深（米）。
 */
export function setStageSize(d: ShowProject, width: number, depth: number): void {
  const clamp = (v: number) => Math.min(STAGE_SIZE_RANGE.max, Math.max(STAGE_SIZE_RANGE.min, v));
  if (Number.isFinite(width)) d.stage.width = clamp(width);
  if (Number.isFinite(depth)) d.stage.depth = clamp(depth);
}

/**
 * 把还没有舞台位置的灯具固定在当前的自动排布位置上。
 *
 * 自动排布只按“没摆放的灯”计算，挪动其中一台会让其余的重新排；所以第一次手动摆位前先全部固定下来。
 *
 * @param d 工程草稿。
 */
export function materializePlacements(d: ShowProject): void {
  if (d.fixtures.every((f) => f.stage)) return;
  const placed = placeFixtures(d.fixtures, d.stage);
  for (const f of d.fixtures) {
    if (f.stage) continue;
    const p = placed.get(f.id);
    if (p) f.stage = { x: snap(p.x, 0.01), y: snap(p.y, 0.01) };
  }
}

/**
 * 平移一组灯具。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id。
 * @param dx x 方向位移（米）。
 * @param dy y 方向位移（米）。
 * @param step 吸附步长（米），0 为不吸附；吸附作用于第一台灯的落点，其余保持相对位置。
 */
export function moveFixtures(d: ShowProject, ids: readonly string[], dx: number, dy: number, step = 0): void {
  const set = new Set(ids);
  const moving = d.fixtures.filter((f) => set.has(f.id));
  if (moving.length === 0) return;
  materializePlacements(d);
  const lead = moving[0].stage as StagePlacement;
  const tx = snap(lead.x + dx, step) - lead.x;
  const ty = snap(lead.y + dy, step) - lead.y;
  for (const f of moving) {
    const s = f.stage as StagePlacement;
    const p = clampToStage(d.stage, s.x + tx, s.y + ty);
    s.x = snap(p.x, 0.001);
    s.y = snap(p.y, 0.001);
  }
}

/**
 * 把一台灯具放到舞台上的指定坐标（属性面板里直接输入 x / y）。坐标会夹在舞台范围内。
 *
 * @param d 工程草稿。
 * @param id 灯具 id。
 * @param patch 新的 x / y（米）；省略的保持不变，非有限数忽略。
 */
export function setFixturePosition(d: ShowProject, id: string, patch: { x?: number; y?: number }): void {
  if (!d.fixtures.some((f) => f.id === id)) return;
  materializePlacements(d);
  const s = d.fixtures.find((f) => f.id === id)?.stage;
  if (!s) return;
  const x = patch.x !== undefined && Number.isFinite(patch.x) ? patch.x : s.x;
  const y = patch.y !== undefined && Number.isFinite(patch.y) ? patch.y : s.y;
  const p = clampToStage(d.stage, x, y);
  s.x = snap(p.x, 0.001);
  s.y = snap(p.y, 0.001);
}

/**
 * 修改一组灯具的安装参数（高度、朝向、俯仰、吊挂）。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id。
 * @param patch 要改的字段；朝向会规整到 -180~180，高度夹到 0~100 米，俯仰夹到 -90~90（0 时省略字段）。
 */
export function setFixturePlacement(
  d: ShowProject,
  ids: readonly string[],
  patch: Partial<Pick<StagePlacement, "z" | "rotation" | "pitch" | "hanging">>,
): void {
  const set = new Set(ids);
  if (!d.fixtures.some((f) => set.has(f.id))) return;
  materializePlacements(d);
  for (const f of d.fixtures) {
    if (!set.has(f.id) || !f.stage) continue;
    if (patch.z !== undefined && Number.isFinite(patch.z)) f.stage.z = clampNum(patch.z, HEIGHT_RANGE);
    if (patch.rotation !== undefined) f.stage.rotation = normalizeDeg(patch.rotation);
    if (patch.pitch !== undefined && Number.isFinite(patch.pitch)) {
      const p = clampNum(patch.pitch, PITCH_RANGE);
      if (p === 0) delete f.stage.pitch;
      else f.stage.pitch = p;
    }
    if (patch.hanging !== undefined) {
      if (patch.hanging) f.stage.hanging = true;
      else delete f.stage.hanging;
    }
  }
}

/**
 * 角度规整到 (-180, 180]。
 *
 * @param deg 角度。
 * @returns 规整后的角度。
 */
export function normalizeDeg(deg: number): number {
  const r = ((((deg + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r + 0;
}

/**
 * 清除一组灯具的手动位置（回到自动排布）。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id。
 */
export function resetPlacements(d: ShowProject, ids: readonly string[]): void {
  const set = new Set(ids);
  for (const f of d.fixtures) if (set.has(f.id)) delete f.stage;
}

/** 排列方式。 */
export type Arrangement =
  | { kind: "line" }
  | { kind: "arc"; /** 弧的张角（度） */ sweepDeg: number }
  | { kind: "grid"; columns: number }
  | { kind: "circle" };

/**
 * 把一组灯具按选择顺序排成直线 / 弧线 / 网格 / 圆。
 *
 * 排布范围取这组灯当前的包围盒：直线沿包围盒的长边均分；弧线以包围盒中心为圆心、朝向观众；
 * 网格按指定列数铺满包围盒；圆以包围盒中心为圆心。包围盒退化（所有灯在同一点）时用舞台宽的一半。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id（顺序即排列顺序）。
 * @param how 排列方式。
 */
export function arrangeFixtures(d: ShowProject, ids: readonly string[], how: Arrangement): void {
  const byId = new Map(d.fixtures.map((f) => [f.id, f]));
  const list = ids.map((id) => byId.get(id)).filter((f) => f !== undefined);
  const n = list.length;
  if (n < 2) return;
  materializePlacements(d);
  const xs = list.map((f) => f.stage!.x);
  const ys = list.map((f) => f.stage!.y);
  let [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  if (x1 - x0 < 0.01 && y1 - y0 < 0.01) {
    x0 = cx - d.stage.width / 4;
    x1 = cx + d.stage.width / 4;
  }
  const width = x1 - x0;
  const height = y1 - y0;
  const put = (i: number, x: number, y: number) => {
    const p = clampToStage(d.stage, x, y);
    list[i].stage!.x = snap(p.x, 0.001);
    list[i].stage!.y = snap(p.y, 0.001);
  };
  switch (how.kind) {
    case "line": {
      const horizontal = width >= height;
      list.forEach((_, i) => {
        const t = i / (n - 1);
        put(i, horizontal ? x0 + t * width : cx, horizontal ? cy : y1 - t * height);
      });
      break;
    }
    case "arc": {
      // 弧线向舞台后方凸起（两端靠前），像一排朝向观众的灯
      const sweep = (Math.min(359, Math.max(10, how.sweepDeg)) * Math.PI) / 180;
      const radius = Math.max(width, height, 0.5) / 2 / Math.max(0.1, Math.sin(Math.min(sweep, Math.PI) / 2));
      list.forEach((_, i) => {
        const a = -sweep / 2 + (i / (n - 1)) * sweep;
        put(i, cx + Math.sin(a) * radius, cy + Math.cos(a) * radius - radius);
      });
      break;
    }
    case "grid": {
      const cols = Math.max(1, Math.min(n, Math.round(how.columns)));
      const rows = Math.ceil(n / cols);
      // 包围盒某一边退化（例如原本排成一行）时，用另一边的间距
      let colGap = cols > 1 && width > 0.01 ? width / (cols - 1) : 0;
      let rowGap = rows > 1 && height > 0.01 ? height / (rows - 1) : 0;
      if (colGap === 0) colGap = rowGap || 1;
      if (rowGap === 0) rowGap = colGap;
      const left = cx - (colGap * (cols - 1)) / 2;
      const top = cy + (rowGap * (rows - 1)) / 2;
      list.forEach((_, i) => {
        put(i, left + (i % cols) * colGap, top - Math.floor(i / cols) * rowGap);
      });
      break;
    }
    case "circle": {
      const radius = Math.max(width, height, 0.5) / 2;
      list.forEach((_, i) => {
        const a = (i / n) * Math.PI * 2;
        put(i, cx + Math.sin(a) * radius, cy - Math.cos(a) * radius);
      });
      break;
    }
  }
}

/** 对齐方式：左 / 右 / 后（画布上方）/ 前（画布下方）/ 水平居中 / 纵深居中。 */
export type AlignMode = "left" | "right" | "back" | "front" | "centerX" | "centerY";

/** 平面上的轴：x 为左右，y 为前后（纵深）。 */
export type StageAxis = "x" | "y";

/**
 * 取一组灯（按给定顺序）并先固定自动排布的位置。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id。
 * @returns 灯具的舞台位置（与 `ids` 同序，跳过不存在的）。
 */
function placedList(d: ShowProject, ids: readonly string[]): StagePlacement[] {
  const byId = new Map(d.fixtures.map((f) => [f.id, f]));
  const list = ids.map((id) => byId.get(id)).filter((f) => f !== undefined);
  if (list.length === 0) return [];
  materializePlacements(d);
  return list.map((f) => f.stage as StagePlacement);
}

/** 写入一个位置（夹到舞台范围、去掉浮点尾数）。 */
function putAt(d: ShowProject, s: StagePlacement, x: number, y: number): void {
  const p = clampToStage(d.stage, x, y);
  s.x = snap(p.x, 0.001);
  s.y = snap(p.y, 0.001);
}

/**
 * 对齐一组灯具：按包围盒的一条边或中线对齐（另一个方向不变）。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id（至少 2 台才有意义）。
 * @param mode 对齐方式。
 */
export function alignFixtures(d: ShowProject, ids: readonly string[], mode: AlignMode): void {
  const list = placedList(d, ids);
  if (list.length < 2) return;
  const xs = list.map((s) => s.x);
  const ys = list.map((s) => s.y);
  const target: Record<AlignMode, number> = {
    left: Math.min(...xs),
    right: Math.max(...xs),
    back: Math.max(...ys),
    front: Math.min(...ys),
    centerX: (Math.min(...xs) + Math.max(...xs)) / 2,
    centerY: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
  const v = target[mode];
  const horizontal = mode === "left" || mode === "right" || mode === "centerX";
  for (const s of list) putAt(d, s, horizontal ? v : s.x, horizontal ? s.y : v);
}

/**
 * 等距分布：沿一个轴按当前坐标排序，两端的灯不动，中间的均匀分布（另一个方向不变）。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id（至少 3 台才有变化）。
 * @param axis 轴。
 */
export function distributeFixtures(d: ShowProject, ids: readonly string[], axis: StageAxis): void {
  const list = placedList(d, ids);
  if (list.length < 3) return;
  const sorted = [...list].sort((a, b) => a[axis] - b[axis]);
  const lo = sorted[0][axis];
  const hi = sorted[sorted.length - 1][axis];
  sorted.forEach((s, i) => {
    const v = lo + ((hi - lo) * i) / (sorted.length - 1);
    putAt(d, s, axis === "x" ? v : s.x, axis === "y" ? v : s.y);
  });
}

/**
 * 镜像：以这组灯包围盒的中线翻转位置（`x` 为左右翻转，`y` 为前后翻转），朝向随之镜像。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id。
 * @param axis 翻转哪个坐标。
 */
export function mirrorFixtures(d: ShowProject, ids: readonly string[], axis: StageAxis): void {
  const list = placedList(d, ids);
  if (list.length === 0) return;
  const vs = list.map((s) => s[axis]);
  const mid = (Math.min(...vs) + Math.max(...vs)) / 2;
  for (const s of list) {
    putAt(d, s, axis === "x" ? 2 * mid - s.x : s.x, axis === "y" ? 2 * mid - s.y : s.y);
    if (s.rotation !== undefined && s.rotation !== 0) s.rotation = normalizeDeg(axis === "x" ? -s.rotation : 180 - s.rotation);
  }
}

/**
 * 反转顺序：第一台与最后一台互换位置，第二台与倒数第二台互换……（朝向、高度、吊挂不变）。
 *
 * 舞台上的位置决定“按舞台位置”分布的顺序，这样可以不改工程顺序而让追逐反向。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id（顺序即当前顺序）。
 */
export function reverseFixturePositions(d: ShowProject, ids: readonly string[]): void {
  const list = placedList(d, ids);
  if (list.length < 2) return;
  const spots = list.map((s) => ({ x: s.x, y: s.y })).reverse();
  list.forEach((s, i) => putAt(d, s, spots[i].x, spots[i].y));
}

/**
 * 添加一个布景物件。
 *
 * @param d 工程草稿。
 * @param kind 类型。
 * @param at 位置（米），省略时放在舞台中央。
 * @param label 文字（文字物件的内容，其它物件的标注）。
 * @returns 新物件 id。
 */
export function addStageObject(d: ShowProject, kind: StageObject["kind"], at?: { x: number; y: number }, label = ""): string {
  const id = newId();
  const size = OBJECT_DEFAULTS[kind];
  const o: StageObject = {
    id,
    kind,
    x: at?.x ?? 0,
    y: at?.y ?? d.stage.depth / 2,
    w: size.w,
    h: size.h,
    rotation: 0,
    label,
  };
  if (kind === "polygon") o.points = regularPolygon(6, size.w, size.h);
  // LED 屏默认底边离地 0.5 米
  if (kind === "screen") o.z = 0.5;
  d.stage.objects.push(o);
  return id;
}

/**
 * 多边形顶点平移后的顶点列表（纯函数，拖动预览与提交共用）。
 *
 * @param o 多边形物件。
 * @param index 顶点下标。
 * @param dx 舞台 x 方向位移（米）。
 * @param dy 舞台 y 方向位移（米）。
 * @param step 吸附步长（米，作用于物件本地坐标），0 为不吸附。
 * @returns 新顶点；不是多边形或下标越界时返回原顶点。
 */
export function movePolygonVertex(
  o: Pick<StageObject, "points" | "rotation">,
  index: number,
  dx: number,
  dy: number,
  step = 0,
): [number, number][] {
  const pts = o.points ?? [];
  if (index < 0 || index >= pts.length) return pts;
  const a = (o.rotation * Math.PI) / 180;
  const lx = dx * Math.cos(a) + dy * Math.sin(a);
  const ly = -dx * Math.sin(a) + dy * Math.cos(a);
  return pts.map((p, i) => (i === index ? [snap(p[0] + lx, step), snap(p[1] + ly, step)] : p));
}

/**
 * 物件补丁：在普通字段之外，`content` 可以为 `null`（清除屏幕内容），`sides` 把多边形重新生成为正多边形
 * （按物件当前的宽与纵深；同时给了 `points` 时以 `points` 为准）。
 */
export type StageObjectPatch = Partial<Omit<StageObject, "id" | "kind" | "content">> & { content?: ScreenContent | null; sides?: number };

/**
 * 修改布景物件（尺寸夹到 ≥ 0，角度规整）。
 *
 * @param d 工程草稿。
 * @param id 物件 id。
 * @param patch 要改的字段。
 */
export function updateStageObject(d: ShowProject, id: string, patch: StageObjectPatch): void {
  const o = d.stage.objects.find((x) => x.id === id);
  if (!o) return;
  if (patch.x !== undefined || patch.y !== undefined) {
    const p = clampToStage(d.stage, patch.x ?? o.x, patch.y ?? o.y);
    o.x = snap(p.x, 0.001);
    o.y = snap(p.y, 0.001);
  }
  const oldW = o.w;
  const oldH = o.h;
  if (patch.w !== undefined && Number.isFinite(patch.w)) o.w = Math.max(0, patch.w);
  if (patch.h !== undefined && Number.isFinite(patch.h)) o.h = Math.max(0, patch.h);
  if (o.kind === "polygon") {
    const valid =
      patch.points &&
      patch.points.length >= POLYGON_POINTS_RANGE.min &&
      patch.points.length <= POLYGON_POINTS_RANGE.max &&
      patch.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (valid) {
      o.points = patch.points!.map((p) => [snap(p[0], 0.001), snap(p[1], 0.001)]);
      Object.assign(o, pointsExtent(o.points));
    } else if (patch.sides !== undefined && Number.isFinite(patch.sides)) {
      o.points = regularPolygon(patch.sides, o.w || OBJECT_DEFAULTS.polygon.w, o.h || OBJECT_DEFAULTS.polygon.h);
    } else if (o.points && (o.w !== oldW || o.h !== oldH)) {
      // 改包围盒尺寸 = 按比例缩放顶点
      const sx = oldW > 0 ? o.w / oldW : 1;
      const sy = oldH > 0 ? o.h / oldH : 1;
      o.points = o.points.map((p) => [snap(p[0] * sx, 0.001), snap(p[1] * sy, 0.001)]);
    }
  }
  if (o.kind === "stairs" && patch.steps !== undefined && Number.isFinite(patch.steps)) {
    const n = Math.round(Math.min(STEPS_RANGE.max, Math.max(STEPS_RANGE.min, patch.steps)));
    if (n === DEFAULT_STAIR_STEPS) delete o.steps;
    else o.steps = n;
  }
  if (o.kind === "screen" && patch.content !== undefined) {
    if (patch.content === null) delete o.content;
    else o.content = patch.content;
  }
  if (patch.rotation !== undefined) o.rotation = normalizeDeg(patch.rotation);
  if (patch.label !== undefined) o.label = patch.label;
  if (patch.z !== undefined && Number.isFinite(patch.z)) {
    const z = clampNum(patch.z, HEIGHT_RANGE);
    if (z === 0) delete o.z;
    else o.z = z;
  }
  if (patch.height !== undefined && Number.isFinite(patch.height)) o.height = clampNum(patch.height, HEIGHT_RANGE);
}

/**
 * 删除布景物件。
 *
 * @param d 工程草稿。
 * @param id 物件 id。
 */
export function removeStageObject(d: ShowProject, id: string): void {
  d.stage.objects = d.stage.objects.filter((o) => o.id !== id);
}

/**
 * 设置 / 清除背景图（只引用本地路径，不复制进工程）。
 *
 * @param d 工程草稿。
 * @param path 图片路径；`null` 为清除。
 */
export function setStageBackground(d: ShowProject, path: string | null): void {
  d.stage.backgroundPath = path;
}

/**
 * 设置烟雾浓度（夹到 0~1；等于默认值时省略字段）。
 *
 * @param d 工程草稿。
 * @param haze 浓度。
 */
export function setStageHaze(d: ShowProject, haze: number): void {
  if (!Number.isFinite(haze)) return;
  const v = clampNum(haze, { min: 0, max: 1 });
  if (v === DEFAULT_HAZE) delete d.stage.haze;
  else d.stage.haze = v;
}

/** 场馆缩放的范围。 */
const VENUE_SCALE_RANGE = { min: 0.001, max: 1000 } as const;
/** 场馆偏移的范围（米）。 */
const VENUE_OFFSET_RANGE = { min: -1000, max: 1000 } as const;

/**
 * 设置 / 清除场馆模型（换模型时位置与缩放回到默认）。
 *
 * @param d 工程草稿。
 * @param venue 资源散列与名称；`null` 为清除。
 */
export function setStageVenue(d: ShowProject, venue: { hash: string; name: string } | null): void {
  if (!venue) {
    delete d.stage.venue;
    return;
  }
  if (d.stage.venue?.hash === venue.hash) return;
  d.stage.venue = { hash: venue.hash, name: venue.name, x: 0, y: 0, z: 0, rotation: 0, scale: 1 };
}

/**
 * 调整场馆模型的位置、角度与缩放。
 *
 * @param d 工程草稿。
 * @param patch 要改的字段（非有限数忽略）。
 */
export function updateStageVenue(d: ShowProject, patch: Partial<Omit<StageVenue, "hash" | "name">>): void {
  const v = d.stage.venue;
  if (!v) return;
  for (const k of ["x", "y", "z"] as const) {
    const n = patch[k];
    if (n !== undefined && Number.isFinite(n)) v[k] = clampNum(n, VENUE_OFFSET_RANGE);
  }
  if (patch.rotation !== undefined && Number.isFinite(patch.rotation)) v.rotation = normalizeDeg(patch.rotation);
  if (patch.scale !== undefined && Number.isFinite(patch.scale)) v.scale = clampNum(patch.scale, VENUE_SCALE_RANGE);
}

/**
 * 把一组灯具挂到桁架上：灯具落在桁架中线上、高度为桁架底面、设为吊挂。
 *
 * 不均分时每台灯取它在中线上最近的点（夹在桁架两端之间）；均分时按给定顺序沿桁架等距排开
 * （两端各留半个间距）。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id（顺序即均分顺序）。
 * @param trussId 桁架物件 id（不是桁架时不做任何事）。
 * @param distribute 是否沿桁架均分。
 * @returns 是否挂上了（找不到桁架或灯具时为 `false`）。
 */
export function hangOnTruss(d: ShowProject, ids: readonly string[], trussId: string, distribute: boolean): boolean {
  const truss = d.stage.objects.find((o) => o.id === trussId && o.kind === "truss");
  if (!truss) return false;
  const list = placedList(d, ids);
  if (list.length === 0) return false;
  const a = (truss.rotation * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const half = truss.w / 2;
  const z = clampNum(truss.z ?? 0, HEIGHT_RANGE);
  list.forEach((s, i) => {
    const t = distribute
      ? -half + ((i + 0.5) / list.length) * truss.w
      : Math.min(half, Math.max(-half, (s.x - truss.x) * ux + (s.y - truss.y) * uy));
    putAt(d, s, truss.x + ux * t, truss.y + uy * t);
    s.z = z;
    s.hanging = true;
  });
  return true;
}
