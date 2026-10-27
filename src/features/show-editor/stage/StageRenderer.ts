import type { Rgb, StageLayout } from "../lib/project";
import { beamOf, toCanvas, type StageView } from "./stageGeometry";

/**
 * 舞台渲染器接口（策略模式）：舞台监视器只依赖这个接口，当前实现是 Canvas2D，
 * 以后可以换成 WebGL / WebGPU 而不改组件。
 */
export interface StageRenderer {
  /**
   * 画布尺寸变化。
   *
   * @param width CSS 像素宽。
   * @param height CSS 像素高。
   * @param dpr 设备像素比。
   */
  resize(width: number, height: number, dpr: number): void;
  /**
   * 画一帧。
   *
   * @param frame 帧数据。
   */
  render(frame: StageFrame): void;
  /** 释放资源。 */
  dispose(): void;
}

/** 一台灯具在这一帧的样子。 */
export interface StageFixture {
  id: string;
  name: string;
  /** 舞台坐标（米） */
  x: number;
  y: number;
  /** 水平朝向（度） */
  rotation: number;
  /** 实际发出的颜色（sRGB，已含亮度） */
  rgb: Rgb;
  /** Pan / Tilt（0~1），没有时为 `null`（不画光束） */
  pan: number | null;
  tilt: number | null;
  /** Pan 总行程（度） */
  panRange: number;
  selected: boolean;
  /** 编程器里有值 */
  programmed: boolean;
  /** 有通道被锁定（Park） */
  parked: boolean;
  /** 倒装（吊挂）：光束的 Pan 方向反转 */
  hanging?: boolean;
}

/** 主题颜色（从 CSS 变量读取）。 */
export interface StageTheme {
  background: string;
  grid: string;
  outline: string;
  selection: string;
  programmed: string;
  text: string;
}

/** 一帧。 */
export interface StageFrame {
  stage: StageLayout;
  view: StageView;
  fixtures: readonly StageFixture[];
  theme: StageTheme;
  /** 悬停的灯具（画名字） */
  hover: string | null;
  /** 框选矩形（画布坐标） */
  lasso: { x0: number; y0: number; x1: number; y1: number } | null;
  /** 光晕强度（0 关闭） */
  bloom: number;
  /** 布置模式：画细网格（吸附步长）、物件可选中 */
  editing?: boolean;
  /** 选中的布景物件 */
  selectedObject?: string | null;
  /** 背景图（铺满舞台区域，已加载完成的图片） */
  background?: CanvasImageSource | null;
}

/** 灯具本体半径（像素）。 */
export const FIXTURE_RADIUS = 7;

/** 布置模式细网格的间距（米，与拖动吸附步长一致）。 */
const EDIT_GRID_M = 0.25;

/** 亮度（0~1，按 Rec.709 亮度）。 */
function luminance([r, g, b]: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Canvas2D 实现：暗场底 + 米格网格 + 布景物件，灯具画成“光晕（叠加混合，近似 bloom）+ 光束楔形 + 本体”，
 * 选中描边、编程器圆点、Park 角标、悬停名字、框选矩形。
 */
export class Canvas2DStageRenderer implements StageRenderer {
  #ctx: CanvasRenderingContext2D | null;
  #canvas: HTMLCanvasElement;
  #width = 0;
  #height = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d");
  }

  resize(width: number, height: number, dpr: number): void {
    this.#width = width;
    this.#height = height;
    this.#canvas.width = Math.max(1, Math.round(width * dpr));
    this.#canvas.height = Math.max(1, Math.round(height * dpr));
    this.#ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(frame: StageFrame): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const { view, stage, theme } = frame;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.#width, this.#height);

    // 舞台轮廓与每米网格
    const tl = toCanvas(view, -stage.width / 2, stage.depth);
    const br = toCanvas(view, stage.width / 2, 0);
    if (frame.background) {
      ctx.globalAlpha = 0.45;
      ctx.drawImage(frame.background, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    if (frame.editing && view.scale * EDIT_GRID_M >= 6) {
      // 布置模式：吸附步长的细网格
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      for (let x = -stage.width / 2; x <= stage.width / 2 + 1e-6; x += EDIT_GRID_M) {
        const p = toCanvas(view, x, 0);
        ctx.moveTo(p.x + 0.5, tl.y);
        ctx.lineTo(p.x + 0.5, br.y);
      }
      for (let y = 0; y <= stage.depth + 1e-6; y += EDIT_GRID_M) {
        const p = toCanvas(view, 0, y);
        ctx.moveTo(tl.x, p.y + 0.5);
        ctx.lineTo(br.x, p.y + 0.5);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    for (let x = Math.ceil(-stage.width / 2); x <= stage.width / 2; x += 1) {
      const p = toCanvas(view, x, 0);
      ctx.moveTo(p.x + 0.5, tl.y);
      ctx.lineTo(p.x + 0.5, br.y);
    }
    for (let y = 0; y <= stage.depth; y += 1) {
      const p = toCanvas(view, 0, y);
      ctx.moveTo(tl.x, p.y + 0.5);
      ctx.lineTo(br.x, p.y + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = theme.outline;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

    // 布景物件
    ctx.fillStyle = theme.text;
    ctx.font = "10px sans-serif";
    for (const o of stage.objects) {
      const c = toCanvas(view, o.x, o.y);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate((-o.rotation * Math.PI) / 180);
      const isSelected = frame.selectedObject === o.id;
      ctx.strokeStyle = isSelected ? theme.selection : theme.outline;
      ctx.lineWidth = isSelected ? 2 : 1;
      const w = o.w * view.scale;
      const h = o.h * view.scale;
      if (o.kind === "label") {
        ctx.fillStyle = theme.text;
        ctx.font = `${Math.max(10, Math.min(28, h * 0.8))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(o.label, 0, 0, Math.max(w, 10));
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
        ctx.font = "10px sans-serif";
        if (isSelected || frame.editing) {
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(-w / 2, -h / 2, w, h);
          ctx.setLineDash([]);
        }
        ctx.restore();
        continue;
      }
      if (o.kind === "circle") {
        ctx.beginPath();
        ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
        ctx.stroke();
      } else if (o.kind === "truss") {
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.beginPath();
        for (let x = -w / 2; x < w / 2; x += Math.max(6, h)) {
          ctx.moveTo(x, -h / 2);
          ctx.lineTo(x + Math.max(6, h), h / 2);
        }
        ctx.stroke();
      } else if (o.kind === "rect") {
        ctx.strokeRect(-w / 2, -h / 2, w, h);
      }
      if (o.label) ctx.fillText(o.label, -w / 2, -h / 2 - 3);
      ctx.restore();
    }

    // 光晕与光束：叠加混合，多台灯重叠处更亮
    ctx.globalCompositeOperation = "lighter";
    for (const f of frame.fixtures) {
      const lum = luminance(f.rgb);
      if (lum <= 0.004) continue;
      const c = toCanvas(view, f.x, f.y);
      const [r, g, b] = f.rgb;
      if (f.pan !== null && f.tilt !== null) {
        const { angle, reach } = beamOf(f.hanging ? 1 - f.pan : f.pan, f.tilt, f.panRange, f.rotation);
        const len = (0.6 + reach * 3) * view.scale;
        const spread = 0.16;
        const grad = ctx.createLinearGradient(c.x, c.y, c.x + Math.sin(angle) * len, c.y + Math.cos(angle) * len);
        grad.addColorStop(0, `rgb(${r} ${g} ${b} / ${0.55 * lum + 0.15})`);
        grad.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(c.x + Math.sin(angle - spread) * len, c.y + Math.cos(angle - spread) * len);
        ctx.lineTo(c.x + Math.sin(angle + spread) * len, c.y + Math.cos(angle + spread) * len);
        ctx.closePath();
        ctx.fill();
      }
      if (frame.bloom > 0) {
        const radius = (FIXTURE_RADIUS * 2 + 26 * lum) * frame.bloom;
        const glow = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, radius);
        glow.addColorStop(0, `rgb(${r} ${g} ${b} / 0.9)`);
        glow.addColorStop(0.35, `rgb(${r} ${g} ${b} / 0.35)`);
        glow.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 灯具本体与标记
    ctx.globalCompositeOperation = "source-over";
    for (const f of frame.fixtures) {
      const c = toCanvas(view, f.x, f.y);
      const [r, g, b] = f.rgb;
      ctx.fillStyle = `rgb(${r} ${g} ${b})`;
      ctx.strokeStyle = f.selected ? theme.selection : theme.outline;
      ctx.lineWidth = f.selected ? 2.5 : 1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, FIXTURE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (f.programmed) {
        ctx.fillStyle = theme.programmed;
        ctx.beginPath();
        ctx.arc(c.x + FIXTURE_RADIUS, c.y - FIXTURE_RADIUS, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (f.parked) {
        ctx.fillStyle = theme.text;
        ctx.font = "bold 9px sans-serif";
        ctx.fillText("P", c.x - FIXTURE_RADIUS - 7, c.y - FIXTURE_RADIUS + 2);
      }
      if (f.id === frame.hover || f.selected) {
        ctx.fillStyle = theme.text;
        ctx.font = "11px sans-serif";
        ctx.fillText(f.name, c.x + FIXTURE_RADIUS + 4, c.y + 4);
      }
    }

    if (frame.lasso) {
      const { x0, y0, x1, y1 } = frame.lasso;
      ctx.strokeStyle = theme.selection;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }
  }

  dispose(): void {
    this.#ctx = null;
  }
}
