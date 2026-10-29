import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MEDIA_REDUCED_MOTION } from "@/shared/lib/breakpoints";
import { SettingsForm } from "./SettingsForm";
import { SettingsNav } from "./SettingsNav";
import { SettingsSearch } from "./SettingsSearch";
import { useActiveSection } from "../hooks/useActiveSection";
import { SettingsFilterContext, type SettingsFilter } from "../hooks/useSettingsFilter";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/sections";
import { matchSections, normalizeQuery } from "../lib/settingsSearch";
import type { AppSettings } from "../lib/types";

/** 当前构建里会渲染的分区（“开发者”只在开发构建里出现）。 */
const RENDERED_SECTIONS = SETTINGS_SECTIONS.filter((s) => s.id !== "developer" || import.meta.env.DEV);

/** 滚动到分区并把焦点交给其中第一个控件（减少动态效果时不做平滑滚动）。 */
function jumpTo(id: SettingsSectionId) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.(MEDIA_REDUCED_MOTION).matches === true;
  el.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
  el.querySelector<HTMLElement>("input, button, [role=switch], [role=combobox]")?.focus({ preventScroll: true });
}

interface SettingsBrowserProps {
  settings: AppSettings;
  update: (updater: (prev: AppSettings) => AppSettings) => void;
}

/**
 * 设置页主体：宽屏两栏（左侧吸顶的搜索 + 目录，右侧分区卡片），窄屏时搜索与目录
 * 横排吸顶在卡片上方。搜索按分区名 / 说明 / 行标签过滤，没有结果时给出空状态。
 */
export function SettingsBrowser({ settings, update }: SettingsBrowserProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  // 输入保持即时，过滤结果延后一拍，长表单里打字不卡
  const query = normalizeQuery(useDeferredValue(input));

  const filter = useMemo<SettingsFilter>(
    () => ({ query, matches: query === "" ? null : matchSections(RENDERED_SECTIONS, query, t) }),
    [query, t],
  );
  const shown = useMemo(
    () => (filter.matches === null ? RENDERED_SECTIONS : RENDERED_SECTIONS.filter((s) => filter.matches!.has(s.id))),
    [filter],
  );
  const ids = useMemo(() => shown.map((s) => s.id), [shown]);
  const [active, select] = useActiveSection(ids);

  return (
    <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
      <aside className="sticky top-0 z-10 -mx-2 grid gap-2 bg-background/95 px-2 py-2 backdrop-blur-sm lg:top-4 lg:mx-0 lg:gap-3 lg:self-start lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
        <SettingsSearch value={input} onChange={setInput} />
        <SettingsNav
          sections={shown}
          active={active}
          onSelect={(id) => {
            select(id);
            jumpTo(id);
          }}
        />
      </aside>

      <div className="min-w-0">
        {shown.length === 0 ? (
          <div
            role="status"
            className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-14 text-center"
          >
            <SearchX className="size-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">{t("settings.noMatch", { query: input.trim() })}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("settings.noMatchHint")}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setInput("")}>
              {t("settings.searchClear")}
            </Button>
          </div>
        ) : (
          <SettingsFilterContext value={filter}>
            <SettingsForm settings={settings} update={update} />
          </SettingsFilterContext>
        )}
      </div>
    </div>
  );
}
