import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Switch } from "@/components/ui/switch";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import { devtoolsSet, devtoolsState, type DevtoolsState } from "../lib/devtoolsApi";
import { SettingRow } from "./SettingRow";
import { SettingsSectionById } from "./SettingsSection";

/**
 * 设置页的“开发者”分区（只在开发构建里显示）：开关开发者工具、临时保留浏览器默认右键菜单。
 *
 * 开发者工具也可以用 Ctrl+Shift+I 打开；窗口重新获得焦点时重读状态，保持开关与实际一致。
 */
export function DeveloperSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<DevtoolsState | null>(null);
  const [error, setError] = useState(false);
  const nativeMenu = usePrefsStore((s) => s.nativeContextMenu);
  const setNativeMenu = usePrefsStore((s) => s.setNativeContextMenu);

  const refresh = useCallback(() => {
    devtoolsState()
      .then((s) => {
        setState(s);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const toggle = (open: boolean) => {
    devtoolsSet(open)
      .then(setState)
      .catch(() => setError(true));
  };

  return (
    <SettingsSectionById id="developer">
      <SettingRow label={t("settings.devtools")} hint={t("settings.devtoolsHint")}>
        <Switch
          aria-label={t("settings.devtools")}
          checked={state?.open ?? false}
          disabled={!state?.available}
          onCheckedChange={toggle}
        />
      </SettingRow>
      {error && (
        <p role="alert" className="px-4 pb-3 text-xs text-destructive">
          {t("settings.devtoolsFailed")}
        </p>
      )}
      <SettingRow label={t("settings.nativeContextMenu")} hint={t("settings.nativeContextMenuHint")}>
        <Switch aria-label={t("settings.nativeContextMenu")} checked={nativeMenu} onCheckedChange={setNativeMenu} />
      </SettingRow>
    </SettingsSectionById>
  );
}
