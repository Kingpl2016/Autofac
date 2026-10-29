import gelFile from "./gels.json";
import { rgbToHsv } from "./colorMath";
import type { Rgb } from "./project";

/**
 * 色纸库：常用 LEE 与 Rosco（Roscolux）色纸的编号、名称与近似 RGB（色盘“色纸”页用）。
 *
 * LED 混不出色纸的光谱，这里的 RGB 只是让灯“看起来接近”的参考值。
 */

/** 品牌。 */
export const GEL_BRANDS = ["LEE", "Rosco"] as const;

/** 品牌。 */
export type GelBrand = (typeof GEL_BRANDS)[number];

/** 按色相分的色系（显示顺序）；`tint` 为低饱和的淡色 / 色温校正纸。 */
export const GEL_FAMILIES = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "tint"] as const;

/** 色系。 */
export type GelFamily = (typeof GEL_FAMILIES)[number];

/** 一张色纸。 */
export interface Gel {
  /** 唯一标识，例如 `lee-106`、`rosco-26` */
  id: string;
  brand: GelBrand;
  /** 编号（不含品牌前缀） */
  code: string;
  name: { zh: string; en: string };
  rgb: Rgb;
  family: GelFamily;
}

/** 饱和度低于它算淡色。 */
const TINT_SATURATION = 0.3;

/**
 * 按色相（HSV）把颜色归到色系。
 *
 * @param rgb 颜色。
 * @returns 色系；饱和度很低时为 `tint`。
 */
export function gelFamily(rgb: Rgb): GelFamily {
  const { h, s } = rgbToHsv(rgb);
  if (s < TINT_SATURATION) return "tint";
  if (h < 15 || h >= 345) return "red";
  if (h < 40) return "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "cyan";
  if (h < 255) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

type GelRow = [string, string, string, string, number[]];

/** 全部色纸（文件顺序：品牌内按编号）。 */
export const GELS: readonly Gel[] = (gelFile.gels as GelRow[]).map(([brand, code, zh, en, [r, g, b]]) => {
  const rgb: Rgb = [r, g, b];
  return { id: `${brand.toLowerCase()}-${code}`, brand: brand as GelBrand, code, name: { zh, en }, rgb, family: gelFamily(rgb) };
});

/**
 * 色纸的显示名：品牌 + 编号（Rosco 编号前加 `R`）+ 当前语言的名称。
 *
 * @param gel 色纸。
 * @param lang 界面语言（`zh` 开头用中文，其它用英文）。
 * @returns 例如 `LEE 106 原红`、`Rosco R26 Light Red`。
 */
export function gelLabel(gel: Gel, lang: string): string {
  const code = gel.brand === "Rosco" ? `R${gel.code}` : gel.code;
  return `${gel.brand} ${code} ${lang.startsWith("zh") ? gel.name.zh : gel.name.en}`;
}

/**
 * 搜索色纸：按空白分词，每个词都要出现在品牌、编号（含 `R` 前缀）或中英文名称里（不区分大小写）。
 *
 * @param gels 色纸。
 * @param query 搜索词。
 * @param brand 只看某个品牌；`null` 为全部。
 * @returns 匹配的色纸（保持原顺序）。
 */
export function searchGels(gels: readonly Gel[], query: string, brand: GelBrand | null = null): Gel[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return gels.filter((g) => {
    if (brand && g.brand !== brand) return false;
    if (words.length === 0) return true;
    const hay = [g.brand, g.code, `r${g.code}`, `${g.brand} ${g.code}`, g.name.zh, g.name.en].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * 按色系分组。
 *
 * @param gels 色纸。
 * @returns 非空的色系与组内色纸（按 {@link GEL_FAMILIES} 的顺序）。
 */
export function groupGels(gels: readonly Gel[]): { family: GelFamily; gels: Gel[] }[] {
  return GEL_FAMILIES.map((family) => ({ family, gels: gels.filter((g) => g.family === family) })).filter((x) => x.gels.length > 0);
}
