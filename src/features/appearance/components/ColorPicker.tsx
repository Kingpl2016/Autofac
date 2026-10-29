import { Pipette } from "lucide-react";
import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from "@/shared/appearance/hsv";
import { canPickScreenColor, pickScreenColor } from "@/shared/lib/eyeDropper";
import { clamp01 } from "@/shared/lib/math";

/** 色相条的渐变背景。 */
const HUE_GRADIENT = "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)";

/** 键盘调节的步长，按住 Shift 时使用大步长。 */
const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.1;

interface ColorPickerProps {
  /** 当前颜色（十六进制 `#rrggbb`）。 */
  value: string;
  /** 颜色变化回调，参数为小写的 `#rrggbb`。 */
  onChange: (hex: string) => void;
}

/**
 * 颜色选择器：饱和度 / 明度面板 + 色相条 + 十六进制输入 + 屏幕取色。
 *
 * - 内部用 HSV 保存状态：灰色或纯黑时色相不会丢失，拖动体验才连贯。
 * - 饱和度 / 明度面板支持指针拖动与键盘方向键（Shift 大步长）；色相条是原生 range，天然可访问。
 * - 外部 `value` 变化（如点了预设色）时同步内部状态。
 */
export function ColorPicker({ value, onChange }: ColorPickerProps) {
  const { t } = useTranslation();
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? { h: 240, s: 0.6, v: 0.9 });
  const [seenValue, setSeenValue] = useState(value);
  const [draft, setDraft] = useState<string | null>(null);
  const hex = hsvToHex(hsv);

  // 由 props 派生状态：外部颜色变了，而且不是我们自己刚发出去的那个，才重新解析
  if (value !== seenValue) {
    setSeenValue(value);
    if (value !== hex) setHsv(hexToHsv(value) ?? hsv);
  }

  const commit = (next: Hsv) => {
    setHsv(next);
    const nextHex = hsvToHex(next);
    setSeenValue(nextHex);
    setDraft(null);
    onChange(nextHex);
  };

  const moveFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    commit({
      h: hsv.h,
      s: clamp01((event.clientX - rect.left) / rect.width),
      v: 1 - clamp01((event.clientY - rect.top) / rect.height),
    });
  };

  const handleAreaKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    commit({ h: hsv.h, s: clamp01(hsv.s + delta[0]), v: clamp01(hsv.v + delta[1]) });
  };

  const pickFromScreen = async () => {
    // 用户按 Esc 取消时为 null：不需要处理
    const hex = await pickScreenColor();
    const picked = hex ? hexToHsv(hex) : null;
    if (picked) commit(picked);
  };

  const saturation = Math.round(hsv.s * 100);
  const brightness = Math.round(hsv.v * 100);

  return (
    <div className="space-y-3">
      {/* 二维的饱和度 / 明度面板没有对应的原生控件，因此用 slider 角色并提供键盘操作 */}
      <div
        role="slider"
        tabIndex={0}
        aria-label={t("appearance.colors.pickerArea")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={saturation}
        aria-valuetext={t("appearance.colors.pickerAreaValue", { s: saturation, v: brightness })}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          moveFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) moveFromPointer(event);
        }}
        onKeyDown={handleAreaKeyDown}
        className="relative h-36 w-full cursor-crosshair touch-none rounded-xl shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${Math.round(hsv.h)} 100% 50%))`,
        }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.35)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
        />
      </div>

      <input
        type="range"
        min={0}
        max={360}
        step={1}
        value={Math.round(hsv.h)}
        aria-label={t("appearance.colors.pickerHue")}
        onChange={(event) => commit({ ...hsv, h: Number(event.target.value) })}
        style={{ background: HUE_GRADIENT }}
        className="block h-3 w-full cursor-pointer appearance-none rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-transparent [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-transparent [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.35)]"
      />

      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-9 shrink-0 rounded-lg shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]"
          style={{ background: hex }}
        />
        <Input
          value={draft ?? hex}
          aria-label={t("appearance.colors.pickerHex")}
          spellCheck={false}
          maxLength={7}
          className="h-9 w-28 font-mono text-sm uppercase"
          onChange={(event) => {
            setDraft(event.target.value);
            const normalized = normalizeHex(event.target.value);
            const parsed = normalized ? hexToHsv(normalized) : null;
            // 输入到一个合法颜色（3 位或 6 位）时立即生效；输入过程中保留用户正在敲的文本
            if (normalized && parsed) {
              setHsv(parsed);
              setSeenValue(normalized);
              onChange(normalized);
            }
          }}
          onBlur={() => setDraft(null)}
        />
        {canPickScreenColor() ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-9"
            aria-label={t("appearance.colors.pickerEyedropper")}
            title={t("appearance.colors.pickerEyedropper")}
            onClick={() => void pickFromScreen()}
          >
            <Pipette aria-hidden />
          </Button>
        ) : null}
      </div>
    </div>
  );
}