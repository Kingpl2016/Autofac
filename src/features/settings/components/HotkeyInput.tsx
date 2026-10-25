import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

/** 纯修饰键，不能单独作为快捷键主键。 */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * 把键盘事件转为 Tauri 全局快捷键加速键字符串，如 `"CommandOrControl+Shift+R"`。
 *
 * # Arguments
 *
 * * `e` - 原生键盘事件。
 *
 * # Returns
 *
 * 加速键字符串；若按下的是纯修饰键则返回 `null`。
 */
function toAccelerator(e: globalThis.KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const main = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [...mods, main].join("+");
}

interface HotkeyInputProps {
  /** 当前加速键 */
  value: string;
  /** 捕获到新加速键时回调 */
  onChange: (accelerator: string) => void;
}

/**
 * 快捷键录入控件：点击进入捕获态，按下组合键后写回。
 */
export function HotkeyInput({ value, onChange }: HotkeyInputProps) {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState(false);

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    e.preventDefault();
    const acc = toAccelerator(e.nativeEvent);
    if (acc) {
      onChange(acc);
      setCapturing(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="tabular w-full justify-center"
      onClick={() => setCapturing(true)}
      onKeyDown={handleKeyDown}
      onBlur={() => setCapturing(false)}
    >
      {capturing ? t("settings.hotkeyCapture") : value}
    </Button>
  );
}
