/** @file “自定义背景”分区：渐变、网格渐变、本地图片、图片地址，以及遮罩与对比度保护 */
import { ImageIcon, PlusIcon, Trash2Icon, VideoIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  BACKGROUND_BLENDS,
  BACKGROUND_FITS,
  BACKGROUND_MOTION_SPEEDS,
  BACKGROUND_POSITIONS,
  MEDIA_LIMITS,
  PARTICLE_PRESETS,
  SHADER_PRESETS,
  GRADIENT_STOPS,
  MESH_COLORS,
  isAllowedImageUrl,
  toLinearGradient,
  toMeshGradient,
  type BackgroundSettings,
  type BackgroundType,
} from "@/shared/appearance/background";
import { cn } from "@/lib/utils";

import { useAppearanceStore } from "../stores/useAppearanceStore";
import { MediaImportError, importImage, importVideo } from "../background/mediaImport";
import { deleteMedia, saveMedia } from "../background/mediaStore";
import { ColorPicker } from "./ColorPicker";
import { focusRingClass, OptionTile, selectedClass } from "./OptionTile";
import { SettingSection } from "./SettingSection";
import { SwitchRow } from "./SwitchRow";

/** 当前可选的背景类型，顺序即展示顺序 */
const SOURCES: readonly BackgroundType[] = [
  "none",
  "gradient",
  "mesh",
  "shader",
  "particles",
  "image",
  "url",
  "video",
];

/** 各背景类型在选项卡里的示意背景 */
const SOURCE_PREVIEW: Record<string, string> = {
  none: "bg-muted/40",
  gradient: "bg-linear-to-br from-indigo-500 to-pink-500",
  mesh: "bg-[radial-gradient(60%_60%_at_15%_15%,#6366f1,transparent_70%),radial-gradient(60%_60%_at_85%_20%,#ec4899,transparent_70%),radial-gradient(60%_60%_at_30%_90%,#22d3ee,transparent_70%)] bg-muted/40",
  shader: "bg-[conic-gradient(from_200deg_at_50%_50%,#6366f1,#ec4899,#22d3ee,#6366f1)] opacity-80",
  particles: "bg-muted/40 bg-[radial-gradient(#6366f1_1.5px,transparent_1.5px)] bg-size-[10px_10px]",
  image: "bg-muted/40",
  url: "bg-muted/40",
  video: "bg-muted/40",
};

/** 十六进制颜色的选择按钮组：点击选中某个颜色，再在下方用取色器编辑 */
interface SwatchRowProps {
  /** 颜色列表 */
  colors: readonly string[];
  /** 选中的下标 */
  selected: number;
  /** 选中回调 */
  onSelect: (index: number) => void;
  /** 每个按钮的无障碍名称 */
  label: (index: number) => string;
}

/**
 * 色块按钮行。
 *
 * @param props - 组件属性
 * @returns 色块按钮节点
 */
function SwatchRow({ colors, selected, onSelect, label }: SwatchRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {colors.map((color, index) => (
        <button
          key={index}
          type="button"
          aria-label={label(index)}
          aria-pressed={selected === index}
          onClick={() => onSelect(index)}
          className={cn(
            focusRingClass,
            "size-8 rounded-full border transition-shadow",
            selected === index && selectedClass,
          )}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}

/**
 * 把字节数格式化为可读的大小。
 *
 * @param bytes - 字节数
 * @returns 形如 `320 KB` 或 `1.4 MB` 的文本
 */
function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * “自定义背景”分区。
 *
 * @remarks
 * - 图片在浏览器端缩放并转 WebP 后存入 IndexedDB，设置里只保存文件名、大小与平均亮度
 * - 外部图片地址只允许 http(s)，加载时不带来源页面信息；会向该地址的服务器暴露你的 IP
 * - 对比度保护按背景平均亮度自动补足遮罩，让正文达到 WCAG AA（估算值）
 *
 * @returns 分区节点
 *
 * @example
 * ```tsx
 * <BackgroundSection />
 * ```
 */
export function BackgroundSection() {
  const { t } = useTranslation();
  const background = useAppearanceStore((state) => state.background);
  const update = useAppearanceStore((state) => state.update);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [stopIndex, setStopIndex] = useState(0);
  const [meshIndex, setMeshIndex] = useState(0);
  const [urlDraft, setUrlDraft] = useState(background.url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 合并更新背景设置。
   *
   * @param patch - 要修改的字段
   */
  const patch = (next: Partial<BackgroundSettings>) => {
    update({ background: { ...background, ...next } });
  };

  const stops = background.gradient.stops;
  const stop = stops[Math.min(stopIndex, stops.length - 1)];
  const meshColor = background.mesh[Math.min(meshIndex, background.mesh.length - 1)];
  const isImage = background.type === "image" || background.type === "url";
  const usesPalette =
    background.type === "mesh" || background.type === "shader" || background.type === "particles";
  const isMedia = isImage || background.type === "video";

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // 清空后同一个文件可以再次选择
    input.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await importImage(file);
      await saveMedia("image", imported.blob);
      patch({
        type: "image",
        media: {
          kind: "image",
          name: file.name.slice(0, 120),
          size: imported.size,
          luma: imported.luma,
          version: Date.now(),
        },
      });
      toast.success(t("appearance.background.imageSaved"));
    } catch (cause) {
      const code = cause instanceof MediaImportError ? cause.code : "storage";
      setError(t(`appearance.background.errors.${code}`));
    } finally {
      setBusy(false);
    }
  };

  const handleVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const imported = importVideo(file);
      await saveMedia("video", imported.blob);
      patch({
        type: "video",
        media: {
          kind: "video",
          name: file.name.slice(0, 120),
          size: imported.size,
          luma: null,
          version: Date.now(),
        },
      });
      toast.success(t("appearance.background.videoSaved"));
    } catch (cause) {
      const code = cause instanceof MediaImportError ? cause.code : "storage";
      setError(t(`appearance.background.errors.${code}`));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveVideo = () => {
    void deleteMedia("video");
    patch({ type: "none", media: null });
  };

  const handleRemoveImage = () => {
    void deleteMedia("image");
    patch({ type: "none", media: null });
  };

  const handleApplyUrl = () => {
    const value = urlDraft.trim();
    if (!isAllowedImageUrl(value)) {
      setError(t("appearance.background.errors.url"));
      return;
    }
    setError(null);
    patch({ type: "url", url: value });
  };

  return (
    <SettingSection title={t("appearance.background.title")} hint={t("appearance.background.hint")}>
      <div className="grid grid-cols-3 gap-3 min-[26rem]:grid-cols-5">
        {SOURCES.map((value) => (
          <OptionTile
            key={value}
            selected={background.type === value}
            onSelect={() => {
              setError(null);
              patch({ type: value });
            }}
            label={t(`appearance.background.types.${value}`)}
            preview={
              <span
                className={cn(
                  "flex h-12 items-center justify-center rounded-lg border text-muted-foreground",
                  SOURCE_PREVIEW[value],
                )}
              >
                {value === "image" || value === "url" ? <ImageIcon aria-hidden className="size-5" /> : null}
              </span>
            }
            className="p-1.5"
          />
        ))}
      </div>

      {background.type === "gradient" && stop ? (
        <div className="space-y-3 rounded-xl border bg-card p-3">
          <div
            aria-hidden
            className="h-10 rounded-lg border"
            style={{ backgroundImage: toLinearGradient(background.gradient) }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SwatchRow
              colors={stops.map((item) => item.color)}
              selected={Math.min(stopIndex, stops.length - 1)}
              onSelect={setStopIndex}
              label={(index) => t("appearance.background.stop", { index: index + 1 })}
            />
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="outline"
                className="size-8"
                aria-label={t("appearance.background.addStop")}
                disabled={stops.length >= GRADIENT_STOPS.max}
                onClick={() => {
                  const next = [...stops, { color: stop.color, position: 100 }];
                  patch({ gradient: { ...background.gradient, stops: next } });
                  setStopIndex(next.length - 1);
                }}
              >
                <PlusIcon aria-hidden />
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="size-8"
                aria-label={t("appearance.background.removeStop")}
                disabled={stops.length <= GRADIENT_STOPS.min}
                onClick={() => {
                  const next = stops.filter((_, index) => index !== stopIndex);
                  patch({ gradient: { ...background.gradient, stops: next } });
                  setStopIndex(0);
                }}
              >
                <Trash2Icon aria-hidden />
              </Button>
            </div>
          </div>
          <ColorPicker
            value={stop.color}
            onChange={(color) =>
              patch({
                gradient: {
                  ...background.gradient,
                  stops: stops.map((item, index) => (index === stopIndex ? { ...item, color } : item)),
                },
              })
            }
          />
          <SliderRow
            label={t("appearance.background.stopPosition")}
            value={stop.position}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={(position) =>
              patch({
                gradient: {
                  ...background.gradient,
                  stops: stops.map((item, index) => (index === stopIndex ? { ...item, position } : item)),
                },
              })
            }
          />
          <SliderRow
            label={t("appearance.background.angle")}
            value={background.gradient.angle}
            min={0}
            max={360}
            step={5}
            unit="°"
            onChange={(angle) => patch({ gradient: { ...background.gradient, angle } })}
          />
        </div>
      ) : null}

      {usesPalette && meshColor ? (
        <div className="space-y-3 rounded-xl border bg-card p-3">
          <div
            aria-hidden
            className="h-16 rounded-lg border bg-background"
            style={{ backgroundImage: toMeshGradient(background.mesh) }}
          />
          {background.type === "shader" ? (
            <ChoiceRow
              label={t("appearance.background.shaderPreset")}
              values={SHADER_PRESETS}
              current={background.shader}
              text={(value) => t(`appearance.background.shaderOptions.${value}`)}
              onSelect={(shader) => patch({ shader })}
            />
          ) : null}
          {background.type === "particles" ? (
            <ChoiceRow
              label={t("appearance.background.particlesPreset")}
              values={PARTICLE_PRESETS}
              current={background.particles}
              text={(value) => t(`appearance.background.particlesOptions.${value}`)}
              onSelect={(particles) => patch({ particles })}
            />
          ) : null}
          {background.type === "shader" || background.type === "particles" ? (
            <ChoiceRow
              label={t("appearance.background.speed")}
              values={BACKGROUND_MOTION_SPEEDS}
              current={background.speed}
              text={(value) => t(`appearance.background.speedOptions.${value}`)}
              onSelect={(speed) => patch({ speed })}
            />
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SwatchRow
              colors={background.mesh}
              selected={Math.min(meshIndex, background.mesh.length - 1)}
              onSelect={setMeshIndex}
              label={(index) => t("appearance.background.meshColor", { index: index + 1 })}
            />
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="outline"
                className="size-8"
                aria-label={t("appearance.background.addStop")}
                disabled={background.mesh.length >= MESH_COLORS.max}
                onClick={() => {
                  patch({ mesh: [...background.mesh, meshColor] });
                  setMeshIndex(background.mesh.length);
                }}
              >
                <PlusIcon aria-hidden />
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="size-8"
                aria-label={t("appearance.background.removeStop")}
                disabled={background.mesh.length <= MESH_COLORS.min}
                onClick={() => {
                  patch({ mesh: background.mesh.filter((_, index) => index !== meshIndex) });
                  setMeshIndex(0);
                }}
              >
                <Trash2Icon aria-hidden />
              </Button>
            </div>
          </div>
          <ColorPicker
            value={meshColor}
            onChange={(color) =>
              patch({
                mesh: background.mesh.map((item, index) => (index === meshIndex ? color : item)),
              })
            }
          />
        </div>
      ) : null}

      {background.type === "image" ? (
        <div className="space-y-3 rounded-xl border bg-card p-3">
          <p className="text-xs text-muted-foreground">{t("appearance.background.imageHint")}</p>
          {background.media?.kind === "image" ? (
            <p className="text-sm">
              {background.media.name}{" "}
              <span className="text-muted-foreground">({formatSize(background.media.size)})</span>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => fileInputRef.current?.click()}>
              <ImageIcon aria-hidden />
              {background.media
                ? t("appearance.background.replaceImage")
                : t("appearance.background.chooseImage")}
            </Button>
            {background.media?.kind === "image" ? (
              <Button variant="ghost" onClick={handleRemoveImage}>
                <Trash2Icon aria-hidden />
                {t("appearance.background.removeImage")}
              </Button>
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
              aria-label={t("appearance.background.chooseImage")}
              tabIndex={-1}
              className="sr-only"
              onChange={(event) => void handleFile(event)}
            />
          </div>
        </div>
      ) : null}

      {background.type === "url" ? (
        <div className="space-y-2 rounded-xl border bg-card p-3">
          <p className="text-xs text-muted-foreground">{t("appearance.background.urlHint")}</p>
          <div className="flex gap-2">
            <Input
              value={urlDraft}
              inputMode="url"
              spellCheck={false}
              placeholder="https://example.com/wallpaper.jpg"
              aria-label={t("appearance.background.urlLabel")}
              onChange={(event) => {
                setUrlDraft(event.target.value);
                setError(null);
              }}
            />
            <Button onClick={handleApplyUrl} disabled={urlDraft.trim() === ""}>
              {t("appearance.background.applyUrl")}
            </Button>
          </div>
        </div>
      ) : null}

      {background.type === "video" ? (
        <div className="space-y-3 rounded-xl border bg-card p-3">
          <p className="text-xs text-muted-foreground">
            {t("appearance.background.videoHint", {
              size: Math.round(MEDIA_LIMITS.videoBytes / 1024 / 1024),
            })}
          </p>
          {background.media?.kind === "video" ? (
            <p className="text-sm">
              {background.media.name}{" "}
              <span className="text-muted-foreground">({formatSize(background.media.size)})</span>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => videoInputRef.current?.click()}>
              <VideoIcon aria-hidden />
              {background.media?.kind === "video"
                ? t("appearance.background.replaceVideo")
                : t("appearance.background.chooseVideo")}
            </Button>
            {background.media?.kind === "video" ? (
              <Button variant="ghost" onClick={handleRemoveVideo}>
                <Trash2Icon aria-hidden />
                {t("appearance.background.removeVideo")}
              </Button>
            ) : null}
            <input
              ref={videoInputRef}
              type="file"
              accept="video/mp4,video/webm"
              aria-label={t("appearance.background.chooseVideo")}
              tabIndex={-1}
              className="sr-only"
              onChange={(event) => void handleVideo(event)}
            />
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {background.type !== "none" ? (
        <div className="space-y-3 rounded-xl border bg-card p-3">
          <SliderRow
            label={t("appearance.background.dim")}
            value={background.overlay.dim}
            min={0}
            max={80}
            step={5}
            unit="%"
            onChange={(dim) => patch({ overlay: { ...background.overlay, dim } })}
          />
          <SliderRow
            label={t("appearance.background.blur")}
            value={background.overlay.blur}
            min={0}
            max={24}
            step={1}
            unit="px"
            onChange={(blur) => patch({ overlay: { ...background.overlay, blur } })}
          />
          {isMedia ? (
            <>
              <ChoiceRow
                label={t("appearance.background.fit")}
                values={BACKGROUND_FITS}
                current={background.fit}
                text={(value) => t(`appearance.background.fitOptions.${value}`)}
                onSelect={(fit) => patch({ fit })}
              />
              <ChoiceRow
                label={t("appearance.background.position")}
                values={BACKGROUND_POSITIONS}
                current={background.position}
                text={(value) => t(`appearance.background.positionOptions.${value}`)}
                onSelect={(position) => patch({ position })}
              />
              <ChoiceRow
                label={t("appearance.background.blend")}
                values={BACKGROUND_BLENDS}
                current={background.overlay.blend}
                text={(value) => t(`appearance.background.blendOptions.${value}`)}
                onSelect={(blend) => patch({ overlay: { ...background.overlay, blend } })}
              />
            </>
          ) : null}
          <div className="-mx-3 -mb-3 border-t">
            <SwitchRow
              label={t("appearance.background.guard")}
              hint={t("appearance.background.guardHint")}
              checked={background.overlay.guard}
              onCheckedChange={(guard) => patch({ overlay: { ...background.overlay, guard } })}
            />
          </div>
        </div>
      ) : null}
    </SettingSection>
  );
}

/** SliderRow 的属性 */
interface SliderRowProps {
  /** 名称，同时是滑块的无障碍名称 */
  label: string;
  /** 当前值 */
  value: number;
  /** 最小值 */
  min: number;
  /** 最大值 */
  max: number;
  /** 步长 */
  step: number;
  /** 数值后的单位 */
  unit: string;
  /** 修改回调 */
  onChange: (value: number) => void;
}

/**
 * 带数值显示的滑块行。
 *
 * @param props - 组件属性
 * @returns 滑块行节点
 */
function SliderRow({ label, value, min, max, step, unit, onChange }: SliderRowProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <output aria-hidden className="text-muted-foreground tabular-nums">
          {value}
          {unit}
        </output>
      </div>
      <Slider
        thumbLabel={label}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => {
          if (next !== undefined) onChange(next);
        }}
      />
    </div>
  );
}

/** ChoiceRow 的属性 */
interface ChoiceRowProps<T extends string> {
  /** 名称 */
  label: string;
  /** 可选值 */
  values: readonly T[];
  /** 当前值 */
  current: T;
  /** 取值的展示文本 */
  text: (value: T) => string;
  /** 选择回调 */
  onSelect: (value: T) => void;
}

/**
 * 一行分段选择：语义为一组带 aria-pressed 的按钮。
 *
 * @param props - 组件属性
 * @returns 分段选择节点
 */
function ChoiceRow<T extends string>({ label, values, current, text, onSelect }: ChoiceRowProps<T>) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={current === value}
            onClick={() => onSelect(value)}
            className={cn(
              focusRingClass,
              "rounded-lg border bg-background px-2.5 py-1 text-xs transition-colors hover:bg-accent",
              current === value && selectedClass,
            )}
          >
            {text(value)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
