import { placeFixtures } from "../stage/stageGeometry";
import { newId } from "./ids";
import type { ShowProject, StageObject, StagePlacement } from "./project";

/**
 * 舞台布置的编辑操作（在 immer 草稿上执行，一次调用 = 一步撤销）：舞台尺寸、灯具摆位（拖动、
 * 微调、对齐排列、朝向 / 吊挂）、布景物件增删改、背景图。
 *
 * 坐标单位为米，原点在舞台前沿中央，x 向右、y 向后。
 */

/** 舞台宽 / 纵深的范围（米）。 */
export const STAGE_SIZE_RANGE = { min: 1, max: 200 } as const;

/** 拖动时的吸附步长（米）。 */
export const STAGE_SNAP_M = 0.25;

/** 新建布景物件的默认尺寸（米）。 */
const OBJECT_DEFAULTS: Record<StageObject["kind"], { w: number; h: number }> = {
  truss: { w: 6, h: 0.3 },
  rect: { w: 2, h: 1 },
  circle: { w: 2, h: 2 },
  label: { w: 2, h: 0.5 },
};

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
 * 修改一组灯具的安装参数（高度、朝向、吊挂）。
 *
 * @param d 工程草稿。
 * @param ids 灯具 id。
 * @param patch 要改的字段；朝向会规整到 -180~180。
 */
export function setFixturePlacement(
  d: ShowProject,
  ids: readonly string[],
  patch: Partial<Pick<StagePlacement, "z" | "rotation" | "hanging">>,
): void {
  const set = new Set(ids);
  if (!d.fixtures.some((f) => set.has(f.id))) return;
  materializePlacements(d);
  for (const f of d.fixtures) {
    if (!set.has(f.id) || !f.stage) continue;
    if (patch.z !== undefined) f.stage.z = patch.z;
    if (patch.rotation !== undefined) f.stage.rotation = normalizeDeg(patch.rotation);
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
  d.stage.objects.push({
    id,
    kind,
    x: at?.x ?? 0,
    y: at?.y ?? d.stage.depth / 2,
    w: size.w,
    h: size.h,
    rotation: 0,
    label,
  });
  return id;
}

/**
 * 修改布景物件（尺寸夹到 ≥ 0，角度规整）。
 *
 * @param d 工程草稿。
 * @param id 物件 id。
 * @param patch 要改的字段。
 */
export function updateStageObject(d: ShowProject, id: string, patch: Partial<Omit<StageObject, "id" | "kind">>): void {
  const o = d.stage.objects.find((x) => x.id === id);
  if (!o) return;
  if (patch.x !== undefined || patch.y !== undefined) {
    const p = clampToStage(d.stage, patch.x ?? o.x, patch.y ?? o.y);
    o.x = snap(p.x, 0.001);
    o.y = snap(p.y, 0.001);
  }
  if (patch.w !== undefined && Number.isFinite(patch.w)) o.w = Math.max(0, patch.w);
  if (patch.h !== undefined && Number.isFinite(patch.h)) o.h = Math.max(0, patch.h);
  if (patch.rotation !== undefined) o.rotation = normalizeDeg(patch.rotation);
  if (patch.label !== undefined) o.label = patch.label;
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
