import { useTranslation } from "react-i18next";

import { usePrefsStore } from "@/shared/stores/prefsStore";
import {
  CONTENT_WIDTHS,
  SIDEBAR_COLLAPSIBLES,
  SIDEBAR_STYLES,
  type SidebarCollapsible,
} from "../lib/appearanceSettings";
import { useAppearanceStore } from "../stores/useAppearanceStore";
import { Segmented } from "@/shared/components/Segmented";
import { ContentWidthGlyph, SidebarStyleGlyph } from "./LayoutGlyphs";
import { OptionTile } from "./OptionTile";
import { SettingSection } from "./SettingSection";
import { SwitchRow } from "./SwitchRow";

/**
 * “布局”标签页：侧栏样式与折叠方式、内容宽度、底部状态条、页面切换动画。
 * 只改变现有布局元素的摆放与外观，不增删功能。
 */
export function LayoutTab() {
  const { t } = useTranslation();
  const sidebarStyle = useAppearanceStore((s) => s.sidebarStyle);
  const sidebarCollapsible = useAppearanceStore((s) => s.sidebarCollapsible);
  const statusBar = useAppearanceStore((s) => s.statusBar);
  const contentWidth = useAppearanceStore((s) => s.contentWidth);
  const update = useAppearanceStore((s) => s.update);

  const setCollapsible = (value: SidebarCollapsible) => {
    update({ sidebarCollapsible: value });
    // 固定展开：同时把侧栏展开，否则折叠把手被隐藏后就再也展开不了
    if (value === "none") usePrefsStore.getState().setSidebarCollapsed(false);
  };

  return (
    <div className="space-y-8">
      <SettingSection title={t("appearance.layout.sidebar")} hint={t("appearance.layout.sidebarHint")}>
        <div className="grid grid-cols-3 gap-3">
          {SIDEBAR_STYLES.map((value) => (
            <OptionTile
              key={value}
              selected={sidebarStyle === value}
              onSelect={() => update({ sidebarStyle: value })}
              label={t(`appearance.layout.sidebarOptions.${value}`)}
              preview={<SidebarStyleGlyph style={value} />}
            />
          ))}
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.layout.collapsible")} hint={t("appearance.layout.collapsibleHint")}>
        <Segmented<SidebarCollapsible>
          ariaLabel={t("appearance.layout.collapsible")}
          value={sidebarCollapsible}
          onChange={setCollapsible}
          options={SIDEBAR_COLLAPSIBLES.map((value) => ({
            value,
            label: t(`appearance.layout.collapsibleOptions.${value}`),
          }))}
        />
      </SettingSection>

      <SettingSection title={t("appearance.layout.contentWidth")} hint={t("appearance.layout.contentWidthHint")}>
        <div className="grid grid-cols-3 gap-3">
          {CONTENT_WIDTHS.map((value) => (
            <OptionTile
              key={value}
              selected={contentWidth === value}
              onSelect={() => update({ contentWidth: value })}
              label={t(`appearance.layout.contentWidthOptions.${value}`)}
              preview={<ContentWidthGlyph width={value} />}
            />
          ))}
        </div>
      </SettingSection>

      <SettingSection title={t("appearance.layout.elements")}>
        <div className="divide-y rounded-xl border border-border bg-card">
          <SwitchRow
            label={t("appearance.layout.statusBar")}
            hint={t("appearance.layout.statusBarHint")}
            checked={statusBar}
            onCheckedChange={(checked) => update({ statusBar: checked })}
          />
        </div>
      </SettingSection>    </div>
  );
}