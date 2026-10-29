import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ListOrdered, Pipette, Plus, Search, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { canPickScreenColor, pickScreenColor } from "@/shared/lib/eyeDropper";
import { hexToRgb, rgbToHex } from "../lib/colorMath";
import type { ColorMode } from "../lib/fixtureProfile";
import { GELS, gelLabel, groupGels, searchGels, type GelBrand } from "../lib/gels";
import { colorValueRgb } from "../lib/looks";
import type { ColorValue, Rgb } from "../lib/project";
import { useRecentColorsStore } from "../stores/useRecentColorsStore";
import { MAX_USER_SWATCHES, useUserSwatchesStore } from "../stores/useUserSwatchesStore";
import { CommitInput } from "./CommitInput";

/** 常用色（剧场色纸的近似 + 常用白光）。 */
const PALETTE: { id: string; color: ColorValue }[] = [
  { id: "red", color: { kind: "rgb", rgb: [255, 0, 0] } },
  { id: "orange", color: { kind: "rgb", rgb: [255, 96, 0] } },
  { id: "amber", color: { kind: "rgb", rgb: [255, 170, 0] } },
  { id: "yellow", color: { kind: "rgb", rgb: [255, 230, 0] } },
  { id: "lime", color: { kind: "rgb", rgb: [160, 255, 0] } },
  { id: "green", color: { kind: "rgb", rgb: [0, 255, 40] } },
  { id: "cyan", color: { kind: "rgb", rgb: [0, 255, 220] } },
  { id: "sky", color: { kind: "rgb", rgb: [60, 160, 255] } },
  { id: "blue", color: { kind: "rgb", rgb: [0, 30, 255] } },
  { id: "congo", color: { kind: "rgb", rgb: [90, 0, 255] } },
  { id: "magenta", color: { kind: "rgb", rgb: [255, 0, 200] } },
  { id: "pink", color: { kind: "rgb", rgb: [255, 110, 160] } },
  { id: "warm", color: { kind: "kelvin", kelvin: 3200 } },
  { id: "neutral", color: { kind: "kelvin", kelvin: 4300 } },
  { id: "daylight", color: { kind: "kelvin", kelvin: 5600 } },
  { id: "white", color: { kind: "rgb", rgb: [255, 255, 255] } },
];

/** 色板的分页：常用色、色纸、我的色板。 */
type SwatchTab = "common" | "gels" | "mine";

/** 色纸品牌筛选。 */
type BrandFilter = "all" | GelBrand;

const css = ([r, g, b]: Rgb) => `rgb(${r} ${g} ${b})`;
const same = (a: ColorValue, b: ColorValue) => JSON.stringify(a) === JSON.stringify(b);

interface ColorSwatchLibraryProps {
  /** 当前显示的颜色（标出“已选中”的色块） */
  shown: ColorValue;
  gamma: number;
  /** 目标灯具支持的颜色方式：只列出能用的颜色 */
  modes: readonly ColorMode[];
  /**
   * 点一个色块（提交一次）。
   *
   * @param color 颜色。
   */
  onPick: (color: ColorValue) => void;
}

/**
 * 色盘下方的色板：三页——常用色（含最近使用与屏幕取色）、色纸（LEE / Rosco，可搜索，按色系分组）、
 * 我的色板（跨工程保存，可加入当前颜色、改名、排序、删除）。
 */
export function ColorSwatchLibrary({ shown, gamma, modes, onPick }: ColorSwatchLibraryProps) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<SwatchTab>("common");
  const recent = useRecentColorsStore((s) => s.colors);
  const rgbOk = modes.includes("rgb");

  const swatch = (id: string, color: ColorValue, label: string, size = "size-6") => (
    <button
      key={id}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={same(color, shown)}
      onClick={() => onPick(color)}
      className={cn(
        size,
        "cursor-pointer rounded-sm border border-border bg-(--sw) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        same(color, shown) && "ring-2 ring-primary",
      )}
      style={{ "--sw": css(colorValueRgb(color, gamma)) } as CSSProperties}
    />
  );

  const recentShown = recent.map((c, i) => ({ c, i })).filter(({ c }) => modes.includes(c.kind));

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Segmented<SwatchTab>
          size="xs"
          ariaLabel={t("editor.color.swatchTabs")}
          value={tab}
          options={[
            { value: "common", label: t("editor.color.palette") },
            ...(rgbOk ? [{ value: "gels" as const, label: t("editor.color.gels") }] : []),
            { value: "mine", label: t("editor.color.mine") },
          ]}
          onChange={setTab}
        />
        {canPickScreenColor() && rgbOk && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("editor.color.eyedropper")}
            title={t("editor.color.eyedropper")}
            onClick={() => {
              void pickScreenColor().then((hex) => {
                const parsed = hex ? hexToRgb(hex) : null;
                if (parsed) onPick({ kind: "rgb", rgb: parsed });
              });
            }}
          >
            <Pipette aria-hidden />
          </Button>
        )}
      </div>

      {tab === "common" && (
        <>
          {/* 常用色与最近使用只列出目标灯具支持的方式（例如只有色温通道的灯不列彩色） */}
          <div className="flex flex-wrap gap-1">
            {PALETTE.filter((p) => modes.includes(p.color.kind)).map((p) => swatch(p.id, p.color, t(`editor.color.swatches.${p.id}`)))}
          </div>
          {recentShown.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[11px] text-muted-foreground">{t("editor.color.recent")}</span>
              {recentShown.map(({ c, i }) => swatch(`recent-${i}`, c, t("editor.color.recentItem", { hex: rgbToHex(colorValueRgb(c)) })))}
            </div>
          )}
        </>
      )}

      {tab === "gels" && rgbOk && <GelBrowser lang={i18n.language} swatch={swatch} />}

      {tab === "mine" && <MySwatches shown={shown} gamma={gamma} modes={modes} swatch={swatch} />}
    </div>
  );
}

type SwatchRenderer = (id: string, color: ColorValue, label: string, size?: string) => ReactNode;

/** 色纸页：搜索、品牌筛选、按色系分组的色块。 */
function GelBrowser({ lang, swatch }: { lang: string; swatch: SwatchRenderer }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState<BrandFilter>("all");
  const groups = useMemo(() => groupGels(searchGels(GELS, query, brand === "all" ? null : brand)), [query, brand]);

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label={t("editor.color.gelSearch")}
            placeholder={t("editor.color.gelSearch")}
            className="h-7 pl-6 text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Segmented<BrandFilter>
          size="xs"
          ariaLabel={t("editor.color.gelBrand")}
          value={brand}
          options={[
            { value: "all", label: t("editor.color.gelAll") },
            { value: "LEE", label: "LEE" },
            { value: "Rosco", label: "Rosco" },
          ]}
          onChange={setBrand}
        />
      </div>
      <div className="grid max-h-52 gap-1.5 overflow-auto pr-1" role="group" aria-label={t("editor.color.gels")}>
        {groups.length === 0 && <p className="py-2 text-center text-[11px] text-muted-foreground">{t("editor.color.gelNone")}</p>}
        {groups.map((g) => (
          <div key={g.family} className="grid gap-1">
            <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {t(`editor.color.gelFamilies.${g.family}`)}
              <span className="num ml-1 font-normal">{g.gels.length}</span>
            </p>
            <div className="flex flex-wrap gap-1">
              {g.gels.map((gel) => swatch(gel.id, { kind: "rgb", rgb: gel.rgb }, gelLabel(gel, lang)))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground">{t("editor.color.gelNote")}</p>
    </div>
  );
}

/** 我的色板：加入当前颜色；整理模式下可改名、排序、删除。 */
function MySwatches({
  shown,
  gamma,
  modes,
  swatch,
}: {
  shown: ColorValue;
  gamma: number;
  modes: readonly ColorMode[];
  swatch: SwatchRenderer;
}) {
  const { t } = useTranslation();
  const swatches = useUserSwatchesStore((s) => s.swatches);
  const { add, rename, remove, move } = useUserSwatchesStore.getState();
  const [editing, setEditing] = useState(false);
  const full = swatches.length >= MAX_USER_SWATCHES;
  const has = swatches.some((s) => same(s.color, shown));
  const nameOf = (s: (typeof swatches)[number]) => s.name || rgbToHex(colorValueRgb(s.color, gamma));

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={full || has}
          title={full ? t("editor.color.mineFull", { count: MAX_USER_SWATCHES }) : undefined}
          onClick={() => void add(shown)}
        >
          <Plus aria-hidden />
          {has ? t("editor.color.mineHas") : t("editor.color.mineAdd")}
        </Button>
        {swatches.length > 0 && (
          <Button
            type="button"
            variant={editing ? "secondary" : "ghost"}
            size="sm"
            className="ml-auto h-7 px-2 text-xs"
            aria-pressed={editing}
            onClick={() => setEditing(!editing)}
          >
            <ListOrdered aria-hidden />
            {t("editor.color.mineEdit")}
          </Button>
        )}
      </div>
      {swatches.length === 0 && <p className="text-[11px] text-muted-foreground">{t("editor.color.mineEmpty")}</p>}
      {editing ? (
        <ul className="grid gap-1" aria-label={t("editor.color.mine")}>
          {swatches.map((s, i) => (
            <li key={s.id} className="flex items-center gap-1">
              {swatch(s.id, s.color, nameOf(s), "size-5 shrink-0")}
              <CommitInput
                className="h-6 min-w-0 flex-1 px-1.5 text-xs"
                label={t("editor.color.mineName", { name: nameOf(s) })}
                value={s.name}
                placeholder={rgbToHex(colorValueRgb(s.color, gamma))}
                onCommit={(text) => void rename(s.id, text)}
              />
              <Button type="button" variant="ghost" size="icon" className="size-6" disabled={i === 0} aria-label={t("editor.color.mineUp", { name: nameOf(s) })} onClick={() => void move(s.id, -1)}>
                <ArrowUp aria-hidden />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-6" disabled={i === swatches.length - 1} aria-label={t("editor.color.mineDown", { name: nameOf(s) })} onClick={() => void move(s.id, 1)}>
                <ArrowDown aria-hidden />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" aria-label={t("editor.color.mineRemove", { name: nameOf(s) })} onClick={() => void remove(s.id)}>
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("editor.color.mine")}>
          {swatches.filter((s) => modes.includes(s.color.kind)).map((s) => swatch(s.id, s.color, nameOf(s)))}
        </div>
      )}
    </div>
  );
}
