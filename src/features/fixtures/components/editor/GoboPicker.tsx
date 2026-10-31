import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pickImageFile } from "@/shared/tauri/pickers";
import { IMAGE_ASSET_EXTENSIONS } from "../../lib/assetsApi";
import { assetErrorText } from "../../lib/errors";
import { BUILTIN_GOBOS, builtinGoboRef, goboMask, parseGoboRef, type BuiltinGobo } from "../../lib/gobos";
import { assetUrl, useFixtureAssetStore } from "../../stores/useFixtureAssetStore";
import { AssetChooser } from "./AssetChooser";

/** 预览图边长（像素）。 */
const PREVIEW_SIZE = 64;
/** 内置图案的预览图（data URL，按需生成后缓存）。 */
const previews = new Map<BuiltinGobo, string>();

/**
 * 内置图案的预览图（白色图案、透明背景）。
 *
 * @param id 内置图案名。
 * @returns data URL；没有 canvas 时为空串。
 */
function previewOf(id: BuiltinGobo): string {
  const hit = previews.get(id);
  if (hit !== undefined) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PREVIEW_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const mask = goboMask(id, PREVIEW_SIZE);
  const img = ctx.createImageData(PREVIEW_SIZE, PREVIEW_SIZE);
  for (let i = 0; i < mask.length; i++) {
    img.data.set([255, 255, 255, mask[i]], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL("image/png");
  previews.set(id, url);
  return url;
}

/** 一个图案的小预览（内置图案或资源库图片）；`null` 为“自动”。 */
function GoboThumb({ pattern, className }: { pattern: string | null; className?: string }) {
  const byHash = useFixtureAssetStore((s) => s.byHash);
  const ref = pattern ? parseGoboRef(pattern) : null;
  const asset = ref && "hash" in ref ? byHash.get(ref.hash) : undefined;
  const src = !ref ? null : "builtin" in ref ? previewOf(ref.builtin) : asset ? assetUrl(asset.path) : null;
  return (
    <span aria-hidden className={cn("flex items-center justify-center overflow-hidden rounded-full bg-neutral-900", className)}>
      {src && <img src={src} alt="" draggable={false} className="size-full object-contain" />}
    </span>
  );
}

interface GoboPickerProps {
  /** 当前指定的图案（省略为自动匹配） */
  value: string | undefined;
  /** 自动匹配会得到的图案（显示用） */
  auto: string | null;
  onChange: (pattern: string | undefined) => void;
  /** 读屏标签 */
  label: string;
}

/**
 * 图案槽位的图案选择：自动（按槽位名匹配）、内置图案或资源库里的图案图片，也可以导入新图片。
 */
export function GoboPicker({ value, auto, onChange, label }: GoboPickerProps) {
  const { t } = useTranslation();
  const byHash = useFixtureAssetStore((s) => s.byHash);
  const ensure = useFixtureAssetStore((s) => s.ensure);
  const importGobo = useFixtureAssetStore((s) => s.importGobo);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void ensure();
  }, [ensure]);
  const gobos = [...byHash.values()].filter((a) => a.kind === "gobo");

  const onImport = async () => {
    const path = await pickImageFile(t("fixtures.gobos.fileType"), IMAGE_ASSET_EXTENSIONS);
    if (!path) return;
    setBusy(true);
    try {
      onChange((await importGobo(path)).hash);
    } catch (e) {
      toast.error(t("fixtures.assets.importFailed", { reason: assetErrorText(t, e) }));
    } finally {
      setBusy(false);
    }
  };

  const current = value ?? auto;
  return (
    <span className="flex items-center gap-1">
      <GoboThumb pattern={current} className="size-8 border border-border" />
      <AssetChooser
        compact
        label={value ? t("fixtures.gobos.change") : t("fixtures.gobos.auto")}
        assets={gobos}
        current={value}
        onPick={(a) => onChange(a.hash)}
      >
        <div role="group" aria-label={label} className="mb-2 grid grid-cols-6 gap-1">
          <button
            type="button"
            data-close-chooser
            aria-pressed={value === undefined}
            title={t("fixtures.gobos.auto")}
            onClick={() => onChange(undefined)}
            className={cn(
              "flex aspect-square items-center justify-center rounded-md border text-[10px]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              value === undefined ? "border-primary" : "border-border hover:border-primary/60",
            )}
          >
            {t("fixtures.gobos.autoShort")}
          </button>
          {BUILTIN_GOBOS.map((id) => {
            const ref = builtinGoboRef(id);
            const name = t(`fixtures.gobos.names.${id}`);
            return (
              <button
                key={id}
                type="button"
                data-close-chooser
                title={name}
                aria-label={name}
                aria-pressed={value === ref}
                onClick={() => onChange(ref)}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-md border p-0.5",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  value === ref ? "border-primary" : "border-border hover:border-primary/60",
                )}
              >
                <GoboThumb pattern={ref} className="size-full" />
              </button>
            );
          })}
        </div>
      </AssetChooser>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7"
        disabled={busy}
        aria-label={t("fixtures.gobos.import")}
        title={t("fixtures.gobos.import")}
        onClick={() => void onImport()}
      >
        <ImagePlus aria-hidden />
      </Button>
    </span>
  );
}
