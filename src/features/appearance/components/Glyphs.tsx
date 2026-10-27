/** @file 选项卡片里用的小示意图：圆角、疏密、卡片样式、阴影与内边距（纯装饰，对读屏器隐藏） */
import { cn } from "@/lib/utils";

import type { CardPadding, CardShadow, CardStyle, Density } from "../lib/appearanceSettings";

/** 各密度对应的示意：条与条之间的间距 class */
const DENSITY_GAP: Record<Density, string> = {
  compact: "gap-0.5",
  default: "gap-1.5",
  comfortable: "gap-2.5",
};

/** 与 globals.css 里的阴影规则保持一致，用于阴影示意图 */
const SHADOW_PREVIEW: Record<CardShadow, string> = {
  none: "none",
  sm: "0 1px 2px 0 rgb(0 0 0 / 0.1)",
  md: "0 4px 12px -2px rgb(0 0 0 / 0.1), 0 2px 6px -2px rgb(0 0 0 / 0.08)",
  lg: "0 16px 36px -10px rgb(0 0 0 / 0.2), 0 6px 14px -6px rgb(0 0 0 / 0.12)",
};

/** 卡片内边距示意：卡片内部留白的 class */
const PADDING_PREVIEW: Record<CardPadding, string> = {
  compact: "p-1",
  default: "p-2",
  comfortable: "p-3.5",
};

/**
 * 圆角示意：一个只描出左上角的方框，圆角越大弧线越明显。
 *
 * @param props - 组件属性
 * @param props.rem - 圆角，单位 rem
 * @returns 示意节点
 */
export function RadiusGlyph({ rem }: { rem: number }) {
  return (
    <span className="flex h-12 items-center justify-center rounded-lg bg-muted/60">
      <span
        className="size-8 border-t-2 border-l-2 border-foreground/70"
        style={{ borderTopLeftRadius: `${Math.min(rem * 16, 16)}px` }}
      />
    </span>
  );
}

/**
 * 密度示意：几条横线，间距体现疏密。
 *
 * @param props - 组件属性
 * @param props.density - 密度
 * @returns 示意节点
 */
export function DensityGlyph({ density }: { density: Density }) {
  return (
    <span
      className={cn(
        "flex h-12 flex-col items-center justify-center rounded-lg bg-muted/60",
        DENSITY_GAP[density],
      )}
    >
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          className="h-1.5 rounded-full bg-foreground/60"
          style={{ width: index === 3 ? "1.25rem" : "2.25rem" }}
        />
      ))}
    </span>
  );
}

/**
 * 小卡片：卡片示意图的公共部分，几条文字线条放在一个带圆角的底板里。
 *
 * @param props - 组件属性
 * @param props.className - 底板的 class（决定描边、填充、内边距等）
 * @param props.style - 底板的内联样式（如阴影、圆角）
 * @returns 小卡片节点
 */
function MiniCard({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      className={cn("flex h-full w-full flex-col justify-between rounded-md p-2", className)}
      style={style}
    >
      <span className="h-1.5 w-1/2 rounded-full bg-foreground/50" />
      <span className="flex flex-col gap-1">
        <span className="h-1 w-full rounded-full bg-foreground/20" />
        <span className="h-1 w-3/4 rounded-full bg-foreground/20" />
      </span>
    </span>
  );
}

/**
 * 卡片样式示意：画在渐变底色上，毛玻璃的半透明才看得出来。
 *
 * @param props - 组件属性
 * @param props.cardStyle - 卡片样式
 * @returns 示意节点
 */
export function CardStyleGlyph({ cardStyle }: { cardStyle: CardStyle }) {
  const variants: Record<CardStyle, { className: string; style?: React.CSSProperties }> = {
    outline: { className: "border bg-card", style: { boxShadow: SHADOW_PREVIEW.sm } },
    elevated: { className: "bg-card", style: { boxShadow: SHADOW_PREVIEW.md } },
    flat: { className: "bg-muted" },
    glass: {
      className: "border border-white/50 bg-white/40 backdrop-blur-md dark:border-white/20 dark:bg-white/10",
      style: { boxShadow: SHADOW_PREVIEW.sm },
    },
    soft: { className: "bg-primary/10" },
    gradient: { className: "border border-primary/20 bg-linear-to-b from-card to-primary/25" },
  };
  const { className, style } = variants[cardStyle];
  return (
    <span className="block h-16 rounded-lg bg-linear-to-br from-primary/35 via-chart-2/25 to-chart-4/35 p-2.5">
      <MiniCard className={className} style={style} />
    </span>
  );
}

/**
 * 阴影示意：同一张卡片套上不同强度的阴影。
 *
 * @param props - 组件属性
 * @param props.shadow - 阴影强度
 * @returns 示意节点
 */
export function ShadowGlyph({ shadow }: { shadow: CardShadow }) {
  return (
    <span className="block h-16 rounded-lg bg-muted/50 p-3">
      <MiniCard className="border bg-card" style={{ boxShadow: SHADOW_PREVIEW[shadow] }} />
    </span>
  );
}

/**
 * 内边距示意：卡片内部留白越大，内容线条越短。
 *
 * @param props - 组件属性
 * @param props.padding - 内边距
 * @returns 示意节点
 */
export function PaddingGlyph({ padding }: { padding: CardPadding }) {
  return (
    <span className="block h-16 rounded-lg bg-muted/50 p-2">
      <span
        className={cn("flex h-full flex-col gap-1.5 rounded-md border bg-card", PADDING_PREVIEW[padding])}
      >
        <span className="h-1.5 w-1/2 rounded-full bg-foreground/50" />
        <span className="h-1 w-full rounded-full bg-foreground/20" />
        <span className="h-1 w-3/4 rounded-full bg-foreground/20" />
      </span>
    </span>
  );
}
