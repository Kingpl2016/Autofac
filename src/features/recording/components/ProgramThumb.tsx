import { useEffect, useRef, useState } from "react";

import { useAppearanceRevision } from "@/features/appearance";
import { useOverview } from "../hooks/useOverview";
import { drawHeatmap, heatmapCells } from "../lib/heatmap";
import { themeColor } from "../lib/themeColor";

/** 缩略图内部分辨率（像素列数）；CSS 负责拉伸到卡片宽度。 */
const THUMB_COLUMNS = 240;
/** 目标行高总和（像素）；行数更多时每行 1px，由 CSS 压缩显示。 */
const THUMB_TARGET_HEIGHT = 48;
const HEAT_VARS = ["--heat-0", "--heat-1", "--heat-2", "--heat-3", "--heat-4"] as const;

interface ProgramThumbProps {
  /** 节目路径 */
  path: string;
  /** 文件头不可解析时不请求概览 */
  valid: boolean;
  /** 叠在缩略图上的内容（如时长角标） */
  children?: React.ReactNode;
}

/**
 * 节目卡片上的迷你热力图缩略图。
 *
 * 只有卡片进入可视区后才请求概览（后端按文件缓存到 sidecar），避免节目很多时一次性扫描全部文件。
 * 缩略图本身是装饰（对读屏隐藏）；`children` 作为叠加角标，不受影响。
 */
export function ProgramThumb({ path, valid, children }: ProgramThumbProps) {
  const appearanceRevision = useAppearanceRevision();
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || visible || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  const overview = useOverview(visible && valid ? path : "");
  const data = overview.data;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.universes.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // 测试环境（jsdom）没有 2D 上下文
    const rows = data.universes.length;
    const rowHeight = Math.max(1, Math.floor(THUMB_TARGET_HEIGHT / rows));
    canvas.width = THUMB_COLUMNS;
    canvas.height = rows * rowHeight;
    drawHeatmap(
      ctx,
      heatmapCells(data, THUMB_COLUMNS),
      rowHeight,
      THUMB_COLUMNS,
      HEAT_VARS.map((v) => themeColor(canvas, v, "currentColor")),
      themeColor(canvas, "--surface-1", "transparent"),
    );
    // appearanceRevision 只用于触发重绘：颜色变量变化后重新取色
  }, [data, appearanceRevision]);

  return (
    <div className="relative h-16 overflow-hidden rounded-lg bg-surface-1">
      <div ref={boxRef} className="size-full" aria-hidden data-testid="program-thumb">
        {data && data.universes.length > 0 && (
          <canvas ref={canvasRef} className="block size-full" />
        )}
      </div>
      {children}
    </div>
  );
}
