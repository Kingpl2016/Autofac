/** @file 自定义背景的数据模型与校验：渐变、图片、着色器、粒子、视频；背景数据不可信，一律经过这里清洗 */
import { z } from "zod";

/** 背景类型 */
export const BACKGROUND_TYPES = [
  "none",
  "gradient",
  "mesh",
  "image",
  "url",
  "shader",
  "particles",
  "video",
] as const;
/** 背景类型 */
export type BackgroundType = (typeof BACKGROUND_TYPES)[number];

/** 渐变色标数量范围 */
export const GRADIENT_STOPS = { min: 2, max: 4 } as const;
/** 网格渐变颜色数量范围 */
export const MESH_COLORS = { min: 3, max: 4 } as const;

/** 图片适配方式 */
export const BACKGROUND_FITS = ["cover", "contain"] as const;
/** 图片位置 */
export const BACKGROUND_POSITIONS = ["center", "top", "bottom", "left", "right"] as const;
/** 混合模式 */
export const BACKGROUND_BLENDS = ["normal", "multiply", "overlay", "soft-light"] as const;
/** 着色器预设 */
export const SHADER_PRESETS = ["mesh", "swirl", "warp"] as const;
/** 粒子预设 */
export const PARTICLE_PRESETS = ["links", "stars", "snow", "meteors"] as const;
/** 速度档位 */
export const BACKGROUND_MOTION_SPEEDS = ["slow", "normal", "fast"] as const;

/** 图片 / 视频文件的大小上限（字节）：压缩后的图片通常不到 1MB，视频限制在 20MB */
export const MEDIA_LIMITS = { imageBytes: 4 * 1024 * 1024, videoBytes: 20 * 1024 * 1024 } as const;

const hexColor = z.string().regex(/^#[\da-f]{6}$/i);

const gradientStop = z.object({
  color: hexColor,
  position: z.number().min(0).max(100),
});

/** 渐变默认值：主色系的蓝紫渐变，保证第一次打开就有可看的效果 */
const DEFAULT_GRADIENT = {
  stops: [
    { color: "#6366f1", position: 0 },
    { color: "#ec4899", position: 100 },
  ],
  angle: 135,
};

const gradientSchema = z.object({
  stops: z.array(gradientStop).min(GRADIENT_STOPS.min).max(GRADIENT_STOPS.max).catch(DEFAULT_GRADIENT.stops),
  angle: z.number().min(0).max(360).catch(DEFAULT_GRADIENT.angle),
});

const DEFAULT_MESH = ["#6366f1", "#ec4899", "#22d3ee", "#f59e0b"];

/** 上传的媒体文件的元数据（文件本身在 IndexedDB，不进设置） */
const mediaSchema = z.object({
  kind: z.enum(["image", "video"]),
  name: z.string().max(120),
  size: z.number().int().min(0).max(MEDIA_LIMITS.videoBytes),
  /** 平均亮度 0~1，用于计算保证正文对比度所需的遮罩；视频与未知为 null */
  luma: z.number().min(0).max(1).nullable(),
  /** 版本号（时间戳），换文件后变化，用来刷新对象 URL */
  version: z.number().int().min(0),
});

const overlaySchema = z.object({
  /** 变暗 / 变亮的遮罩强度（百分比），颜色取自当前主题的背景色 */
  dim: z.number().min(0).max(80).catch(0),
  /** 背景模糊半径（px） */
  blur: z.number().min(0).max(24).catch(0),
  blend: z.enum(BACKGROUND_BLENDS).catch("normal"),
  /** 对比度保护：按背景亮度自动补足遮罩，让正文达到 WCAG AA */
  guard: z.boolean().catch(true),
});

/**
 * 校验图片地址：只允许 https 与 http，拒绝 data:、javascript:、blob: 与带账号密码的地址。
 *
 * @param value - 待检查的地址
 * @returns 是否为允许的图片地址
 */
export function isAllowedImageUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2000) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** 背景设置的校验 schema，每个字段独立兜底 */
export const backgroundSchema = z.object({
  type: z.enum(BACKGROUND_TYPES).catch("none"),
  gradient: gradientSchema.catch(DEFAULT_GRADIENT),
  mesh: z.array(hexColor).min(MESH_COLORS.min).max(MESH_COLORS.max).catch(DEFAULT_MESH),
  media: mediaSchema.nullable().catch(null),
  url: z.string().refine(isAllowedImageUrl).nullable().catch(null),
  shader: z.enum(SHADER_PRESETS).catch("mesh"),
  particles: z.enum(PARTICLE_PRESETS).catch("links"),
  speed: z.enum(BACKGROUND_MOTION_SPEEDS).catch("normal"),
  fit: z.enum(BACKGROUND_FITS).catch("cover"),
  position: z.enum(BACKGROUND_POSITIONS).catch("center"),
  overlay: overlaySchema.catch({ dim: 0, blur: 0, blend: "normal", guard: true }),
});

/** 自定义背景设置 */
export type BackgroundSettings = z.infer<typeof backgroundSchema>;

/**
 * 获取默认的背景设置（不使用自定义背景）。
 *
 * @returns 全新的默认背景设置
 */
export function getDefaultBackground(): BackgroundSettings {
  return backgroundSchema.parse({});
}

/**
 * 校验并清洗任意来源的背景设置。
 *
 * @param raw - 待清洗的数据
 * @returns 完整且安全的背景设置；数据不是对象时返回默认值
 */
export function sanitizeBackground(raw: unknown): BackgroundSettings {
  return backgroundSchema.parse(typeof raw === "object" && raw !== null ? raw : {});
}

/**
 * 把渐变设置折算为 CSS `linear-gradient(...)` 文本。
 *
 * @param gradient - 渐变设置（已经过校验）
 * @returns 可直接用作 background-image 的值
 */
export function toLinearGradient(gradient: BackgroundSettings["gradient"]): string {
  const stops = gradient.stops
    .toSorted((a, b) => a.position - b.position)
    .map((stop) => `${stop.color} ${stop.position}%`);
  return `linear-gradient(${gradient.angle}deg, ${stops.join(", ")})`;
}

/**
 * 把网格渐变折算为多层 `radial-gradient`，每个颜色占据画面的一角，叠在底色之上。
 *
 * @param colors - 3 到 4 个十六进制颜色
 * @returns 可直接用作 background-image 的值
 */
export function toMeshGradient(colors: readonly string[]): string {
  const anchors = ["12% 12%", "88% 18%", "24% 88%", "82% 86%"];
  return colors
    .map((color, index) => `radial-gradient(60% 60% at ${anchors[index]}, ${color}, transparent 70%)`)
    .join(", ");
}

/**
 * 计算像素数据的平均相对亮度（WCAG 相对亮度的近似，取 sRGB 线性化后的加权平均）。
 *
 * @param data - RGBA 像素数据（如 ImageData.data）
 * @returns 0（全黑）到 1（全白）；没有像素时返回 0.5
 */
export function meanLuminance(data: ArrayLike<number>): number {
  const toLinear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  let sum = 0;
  let count = 0;
  for (let index = 0; index + 3 < data.length; index += 4) {
    const alpha = (data[index + 3] ?? 255) / 255;
    if (alpha === 0) continue;
    const luminance =
      0.2126 * toLinear(data[index] ?? 0) +
      0.7152 * toLinear(data[index + 1] ?? 0) +
      0.0722 * toLinear(data[index + 2] ?? 0);
    sum += luminance;
    count += 1;
  }
  return count === 0 ? 0.5 : sum / count;
}

/**
 * 计算一组十六进制颜色的平均相对亮度，用于渐变与网格渐变的对比度保护。
 *
 * @param colors - `#rrggbb` 颜色列表
 * @returns 0~1 的平均相对亮度；列表为空时返回 0.5
 */
export function colorsLuminance(colors: readonly string[]): number {
  const data: number[] = [];
  for (const color of colors) {
    const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
    if (!match) continue;
    data.push(
      Number.parseInt(match[1] ?? "0", 16),
      Number.parseInt(match[2] ?? "0", 16),
      Number.parseInt(match[3] ?? "0", 16),
      255,
    );
  }
  return meanLuminance(data);
}

/** 正文文字在亮色 / 暗色模式下的相对亮度（接近 shadcn 默认的 foreground） */
const TEXT_LUMINANCE = { light: 0.02, dark: 0.9 } as const;
/** 页面底色（遮罩颜色）在亮色 / 暗色模式下的相对亮度 */
const PAGE_LUMINANCE = { light: 1, dark: 0.005 } as const;
/** WCAG AA 对正文的最低对比度，再留一点余量应对图片局部比平均值更亮或更暗 */
const AA_CONTRAST = 4.5 * 1.1;
/** 没有亮度信息（URL、视频）时的保守遮罩 */
export const UNKNOWN_LUMA_DIM = 45;

/**
 * 计算保证正文对比度所需的最小遮罩强度。
 *
 * @remarks
 * 遮罩用页面底色盖在背景上，混合后的亮度是线性插值：`(1 - d) * luma + d * page`。
 * 亮色模式要求混合后足够亮（深色文字读得清），暗色模式要求足够暗（浅色文字读得清），
 * 反推出需要的 d。用的是平均亮度，所以额外留了 10% 余量；对比度是估算，不是对每个像素的保证。
 *
 * @param luma - 背景的平均亮度（0~1）；null 表示未知
 * @param mode - 当前明暗模式
 * @returns 需要的最小遮罩百分比（0~80）
 */
export function requiredDim(luma: number | null, mode: "light" | "dark"): number {
  if (luma === null) return UNKNOWN_LUMA_DIM;
  const text = TEXT_LUMINANCE[mode];
  const page = PAGE_LUMINANCE[mode];
  // 亮色：要求 (blend + 0.05) / (text + 0.05) >= AA；暗色：要求 (text + 0.05) / (blend + 0.05) >= AA
  const target = mode === "light" ? AA_CONTRAST * (text + 0.05) - 0.05 : (text + 0.05) / AA_CONTRAST - 0.05;
  const satisfied = mode === "light" ? luma >= target : luma <= target;
  if (satisfied) return 0;
  // 解 (1 - d) * luma + d * page = target
  const dim = (target - luma) / (page - luma);
  return Math.min(80, Math.max(0, Math.ceil(dim * 100)));
}
