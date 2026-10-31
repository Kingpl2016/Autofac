import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AssetView } from "../../lib/assetsApi";
import { assetUrl } from "../../stores/useFixtureAssetStore";

interface AssetChooserProps {
  /** 按钮文字与列表的无障碍名称 */
  label: string;
  assets: readonly AssetView[];
  /** 当前选中的散列 */
  current: string | undefined;
  onPick: (a: AssetView) => void;
  /** 列表前面的额外内容（例如内置图案） */
  children?: ReactNode;
  /** 按钮尺寸更紧凑（表格里用） */
  compact?: boolean;
}

/** 资源的预览图：图片类资源用原图，3D 文件用缩略图。 */
function previewOf(a: AssetView): string | undefined {
  return a.kind === "icon" || a.kind === "gobo" ? a.path : a.thumbPath;
}

/**
 * 从资源库挑一个资源（图片显示原图，3D 模型显示缩略图或文件名）。
 */
export function AssetChooser({ label, assets, current, onPick, children, compact }: AssetChooserProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" className={compact ? "h-7 px-2 text-xs" : undefined} disabled={assets.length === 0 && !children}>
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" onClick={(e) => {
        // 额外内容里的按钮选中后也关闭弹层
        if ((e.target as HTMLElement).closest("[data-close-chooser]")) setOpen(false);
      }}>
        {children}
        {assets.length > 0 && (
          <ul className="grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto" aria-label={label}>
            {assets.map((a) => {
              const preview = previewOf(a);
              const name = a.name || a.hash.slice(0, 12);
              return (
                <li key={a.hash}>
                  <button
                    type="button"
                    title={name}
                    aria-pressed={a.hash === current}
                    aria-label={t("fixtures.assets.pick", { name })}
                    onClick={() => {
                      onPick(a);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border bg-surface-1 p-1 text-[10px] text-muted-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      a.hash === current ? "border-primary" : "border-border hover:border-primary/60",
                    )}
                  >
                    {preview ? (
                      <img src={assetUrl(preview)} alt="" draggable={false} decoding="async" loading="lazy" className="size-full object-contain" />
                    ) : (
                      <span className="line-clamp-3 break-all">{name}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
