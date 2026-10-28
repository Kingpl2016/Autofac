import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleCheck, Minus, Plus, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FixtureModel } from "@/features/fixtures";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { addModelToShow } from "../hooks/fixtureAddActions";
import { MAX_ADD_COUNT, MAX_ADD_GAP, NAME_PLACEHOLDER, planAddFixtures, type AddPlan } from "../lib/addPlan";
import { footprintOf, spansByUniverse } from "../lib/patch";
import { DMX_CHANNELS, MAX_UNIVERSE, type ShowProject } from "../lib/project";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useProjectStore } from "../stores/useProjectStore";

/** 数量的快捷选项。 */
const QUICK_COUNTS = [1, 4, 8, 12, 16] as const;

/** 默认模式在下拉框里的值（Radix Select 不接受空串）。 */
const DEFAULT_MODE = "__default__";

/** 预览最多画几个 Universe 的占用条。 */
const MAX_PREVIEW_BARS = 2;

/**
 * 把输入框文字解析成整数并夹取。
 *
 * @param text 输入。
 * @param min 下限。
 * @param max 上限。
 * @param fallback 非数字时的值。
 * @returns 整数。
 */
function toInt(text: string, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(text));
  return Number.isFinite(n) && text.trim() !== "" ? Math.min(max, Math.max(min, n)) : fallback;
}

interface FixtureAddPanelProps {
  id: string;
  model: FixtureModel;
}

/**
 * 批量添加面板（展开在模型卡片下方）：数量、模式、起始地址、间隔、名称模板、加完编组，
 * 下方实时预览将占用的地址与能否放下。上次的数量 / 间隔 / 起点 / 编组会被记住。
 */
export function FixtureAddPanel({ id, model }: FixtureAddPanelProps) {
  const { t } = useTranslation();
  const uid = useId();
  const project = useProjectStore((s) => s.project);
  const prefs = useEditorPrefsStore((s) => s.fixtureAdd);
  const setPrefs = useEditorPrefsStore((s) => s.setFixtureAdd);

  const [count, setCount] = useState(String(prefs.count));
  const [modeId, setModeId] = useState<string>(DEFAULT_MODE);
  const [autoStart, setAutoStart] = useState(prefs.autoStart);
  const [universe, setUniverse] = useState(String(prefs.universe));
  const [address, setAddress] = useState(String(prefs.address));
  const [gap, setGap] = useState(String(prefs.gap));
  const [nameTemplate, setNameTemplate] = useState("");
  const [group, setGroup] = useState(prefs.group);

  const n = toInt(count, 1, MAX_ADD_COUNT, 1);
  const options = {
    count: n,
    modeId: modeId === DEFAULT_MODE ? undefined : modeId,
    start: autoStart
      ? ("auto" as const)
      : { universe: toInt(universe, 0, MAX_UNIVERSE, 0), address: toInt(address, 1, DMX_CHANNELS, 1) },
    gap: toInt(gap, 0, MAX_ADD_GAP, 0),
    nameTemplate: nameTemplate.trim() || undefined,
    group,
  };
  // 计划很轻（只遍历一次灯具），每次渲染直接算，输入即预览
  const plan = planAddFixtures(project, model, options);

  const submit = () => {
    const result = addModelToShow(model, options);
    if (result.ids.length === 0) return;
    setPrefs({
      count: n,
      gap: options.gap,
      autoStart,
      universe: options.start === "auto" ? prefs.universe : options.start.universe,
      address: options.start === "auto" ? prefs.address : options.start.address,
      group,
    });
  };

  const modes = model.modes ?? [];
  const numberClass = "num h-7 px-2 text-xs";

  return (
    <div id={id} role="group" aria-label={t("editor.fixtureAdd.panel", { name: model.name })} className="flex flex-col gap-2.5 border-t border-border px-2.5 pt-2 pb-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Label htmlFor={`${uid}-count`} className="w-12 shrink-0 text-xs text-muted-foreground">
          {t("editor.library.quantity")}
        </Label>
        <div className="flex items-center">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7 rounded-r-none"
            aria-label={t("editor.fixtureAdd.less")}
            disabled={n <= 1}
            onClick={() => setCount(String(n - 1))}
          >
            <Minus aria-hidden />
          </Button>
          <Input
            id={`${uid}-count`}
            className={cn(numberClass, "w-12 rounded-none border-x-0 text-center")}
            inputMode="numeric"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            onBlur={() => setCount(String(n))}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7 rounded-l-none"
            aria-label={t("editor.fixtureAdd.more")}
            disabled={n >= MAX_ADD_COUNT}
            onClick={() => setCount(String(n + 1))}
          >
            <Plus aria-hidden />
          </Button>
        </div>
        <div className="flex gap-0.5" role="group" aria-label={t("editor.fixtureAdd.quickCounts")}>
          {QUICK_COUNTS.map((q) => (
            <button
              key={q}
              type="button"
              aria-pressed={n === q}
              onClick={() => setCount(String(q))}
              className={cn(
                "num h-6 min-w-6 rounded-md px-1.5 text-[11px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                n === q ? "bg-primary text-primary-foreground" : "bg-surface-1 text-muted-foreground hover:text-foreground",
              )}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {modes.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span id={`${uid}-mode`} className="w-12 shrink-0 text-xs text-muted-foreground">
            {t("editor.fixtureAdd.mode")}
          </span>
          <Select value={modeId} onValueChange={setModeId}>
            <SelectTrigger className="h-7 min-w-0 flex-1 text-xs" aria-labelledby={`${uid}-mode`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODE}>
                {t("editor.patch.modeOption", { name: model.defaultModeName || t("editor.patch.defaultMode"), count: footprintOf(model) })}
              </SelectItem>
              {modes.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {t("editor.patch.modeOption", { name: m.name, count: footprintOf(model, m.id) })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-12 shrink-0 text-xs text-muted-foreground">{t("editor.fixtureAdd.start")}</span>
        <Segmented
          size="xs"
          ariaLabel={t("editor.fixtureAdd.start")}
          value={autoStart ? "auto" : "manual"}
          onChange={(v) => setAutoStart(v === "auto")}
          options={[
            { value: "auto", label: t("editor.fixtureAdd.auto") },
            { value: "manual", label: t("editor.fixtureAdd.manual") },
          ]}
        />
        {!autoStart && (
          <span className="flex items-center gap-1">
            <Label htmlFor={`${uid}-u`} className="text-xs text-muted-foreground">
              U
            </Label>
            <Input
              id={`${uid}-u`}
              aria-label={t("editor.fixtureAdd.universe")}
              className={cn(numberClass, "w-12")}
              inputMode="numeric"
              value={universe}
              onChange={(e) => setUniverse(e.target.value)}
            />
            <Input
              aria-label={t("editor.fixtureAdd.address")}
              className={cn(numberClass, "w-14")}
              inputMode="numeric"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <Label htmlFor={`${uid}-gap`} className="w-12 shrink-0 text-xs text-muted-foreground">
          {t("editor.fixtureAdd.gap")}
        </Label>
        <Input
          id={`${uid}-gap`}
          className={cn(numberClass, "w-14")}
          inputMode="numeric"
          value={gap}
          onChange={(e) => setGap(e.target.value)}
          onBlur={() => setGap(String(options.gap))}
        />
        <span className="text-[11px] text-muted-foreground">{t("editor.fixtureAdd.gapUnit")}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <Label htmlFor={`${uid}-name`} className="w-12 shrink-0 text-xs text-muted-foreground">
          {t("editor.fixtureAdd.name")}
        </Label>
        <Input
          id={`${uid}-name`}
          className="h-7 min-w-0 flex-1 px-2 text-xs"
          placeholder={`${model.name} ${NAME_PLACEHOLDER}`}
          aria-describedby={`${uid}-name-hint`}
          value={nameTemplate}
          onChange={(e) => setNameTemplate(e.target.value)}
        />
      </div>
      <p id={`${uid}-name-hint`} className="-mt-1.5 pl-[3.375rem] text-[11px] text-muted-foreground">
        {t("editor.fixtureAdd.nameHint", { first: plan.items[0]?.name ?? "—" })}
      </p>

      <label className="flex items-center gap-2 text-xs">
        <Checkbox checked={group} onCheckedChange={(v) => setGroup(v === true)} className="size-4" />
        {t("editor.fixtureAdd.group")}
      </label>

      <AddPreview project={project} plan={plan} />

      <Button
        type="button"
        size="sm"
        className="h-8 gap-1.5"
        disabled={plan.items.length === 0}
        aria-label={t("editor.fixtureAdd.submitAria", { name: model.name, count: n })}
        onClick={submit}
      >
        <Plus aria-hidden />
        {t("editor.fixtureAdd.submit", { count: n })}
      </Button>
    </div>
  );
}

/**
 * 预览：每个涉及的 Universe 一条迷你占用条（已有占用为灰、将占用为主色），下方一句摘要。
 */
function AddPreview({ project, plan }: { project: Pick<ShowProject, "fixtures" | "fixtureModels">; plan: AddPlan }) {
  const { t } = useTranslation();
  const spans = useMemo(() => spansByUniverse(project), [project]);
  const universes = [...new Set(plan.ranges.map((r) => r.universe))].slice(0, MAX_PREVIEW_BARS);
  const ranges = plan.ranges.map((r) => t("editor.fixtureAdd.range", { universe: r.universe, start: r.start, end: r.end })).join(t("editor.fixtureAdd.listSep"));
  const ok = plan.items.length === plan.requested;
  const pct = (ch: number) => `${((ch - 1) / DMX_CHANNELS) * 100}%`;
  const width = (start: number, end: number) => `${((end - start + 1) / DMX_CHANNELS) * 100}%`;

  return (
    <div className="flex flex-col gap-1 rounded-md bg-surface-1 px-2 py-1.5" aria-live="polite">
      {universes.map((u) => (
        <div key={u} className="flex items-center gap-1.5">
          <span className="num w-7 shrink-0 text-[10px] text-muted-foreground">U{u}</span>
          <div data-bar className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            {(spans.get(u) ?? []).map((s, i) => (
              <span
                key={i}
                className="absolute inset-y-0 bg-muted-foreground/45"
                style={{ left: pct(s.range.start), width: width(s.range.start, Math.min(s.range.end, DMX_CHANNELS)) }}
              />
            ))}
            {plan.ranges
              .filter((r) => r.universe === u)
              .map((r, i) => (
                <span key={`p${i}`} data-planned className="absolute inset-y-0 bg-primary" style={{ left: pct(r.start), width: width(r.start, r.end) }} />
              ))}
          </div>
        </div>
      ))}
      <p className={cn("flex items-start gap-1 text-[11px]", ok ? "text-muted-foreground" : "text-warning")}>
        {ok ? <CircleCheck aria-hidden className="mt-px size-3 shrink-0 text-success" /> : <TriangleAlert aria-hidden className="mt-px size-3 shrink-0" />}
        <span className="num">
          {plan.items.length === 0
            ? t("editor.fixtureAdd.previewNone")
            : t("editor.fixtureAdd.preview", { ranges })}
          {plan.items.length > 0 && t("editor.fixtureAdd.sep")}
          {plan.items.length > 0 && (ok ? t("editor.fixtureAdd.noConflict") : t("editor.fixtureAdd.partial", { count: plan.requested - plan.items.length }))}
          {plan.shifted && plan.items[0] && `${t("editor.fixtureAdd.sep")}${t("editor.fixtureAdd.shifted", { universe: plan.items[0].universe, address: plan.items[0].address })}`}
        </span>
      </p>
    </div>
  );
}
