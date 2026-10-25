import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { SettingsSectionById } from "./SettingsSection";
import { SettingRow } from "./SettingRow";
import { HotkeyInput } from "./HotkeyInput";

/**
 * 快捷键设置分区：配置录制开始 / 停止的全局快捷键，可一键恢复默认。
 */
export function ShortcutsSection() {
  const { t } = useTranslation();
  const hotkeys = usePrefsStore((s) => s.recordHotkeys);
  const setHotkey = usePrefsStore((s) => s.setRecordHotkey);
  const reset = usePrefsStore((s) => s.resetRecordHotkeys);

  return (
    <SettingsSectionById id="shortcuts">
      <SettingRow
        label={t("settings.hotkeyStartRecord")}
        hint={t("settings.hotkeyHint")}
      >
        <HotkeyInput value={hotkeys.start} onChange={(a) => setHotkey("start", a)} />
      </SettingRow>
      <SettingRow label={t("settings.hotkeyStopRecord")}>
        <HotkeyInput value={hotkeys.stop} onChange={(a) => setHotkey("stop", a)} />
      </SettingRow>
      <SettingRow label={t("settings.hotkeyReset")}>
        <Button variant="outline" size="sm" onClick={reset}>
          {t("settings.hotkeyReset")}
        </Button>
      </SettingRow>
    </SettingsSectionById>
  );
}
