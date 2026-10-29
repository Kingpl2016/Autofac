import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, ClipboardPaste, Copy, Diamond, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { useEngine } from "../engine/useEngine";
import { announce } from "@/shared/stores/announcerStore";
import { flashRateHz, unsafeFlash } from "../lib/attrEffects";
import { setSpread, updateLooks } from "../lib/cueOps";
import { MAX_SAFE_STROBE_HZ } from "../lib/effects";
import { availableAttrsOf, colorModes, colorSupportCount, fixtureProfile, layerSupport, supportsColor } from "../lib/fixtureProfile";
import { parseRef } from "../lib/fixtureRef";
import { layerGroupsOf, mergeLayers, pickLayers, type LayerGroup } from "../lib/layers";
import {
  adjacentKey,
  hasKeyAt,
  heldValueAt,
  lookKeyTimes,
  segmentCurve,
  setSegmentCurve,
  setValueAt,
  toggleKeyAt,
} from "../lib/keyframes";
import { colorValueRgb, fixed, paramHead } from "../lib/looks";
import { trackFixtureIds } from "../lib/ops";
import { DEFAULT_STEPS, sanitizeCurve } from "../lib/curveTiming";
import type { ColorValue, Curve, Look, LookClip, Param, Rgb, ValueCurve, WaveShape } from "../lib/project";
import { clamp } from "@/shared/lib/math";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { AttributeLayers } from "./AttributeLayers";
import { ColorPicker } from "./ColorPicker";
import { CommitInput } from "./CommitInput";
import { CurveShapeFields } from "./CurveShapeFields";
import { CycleTimingFields } from "./CycleTimingFields";
import { InspectorSection } from "./InspectorSection";
import { SliderField } from "./SliderField";
import { SpreadPanel } from "./SpreadPanel";

/** 区段插值方式（下拉框顺序）。 */
const CURVES: readonly Curve[] = ["linear", "hold", "easeIn", "easeOut", "easeInOut", "sCurve"];
/** 数值曲线形状。 */
const SHAPES: readonly WaveShape[] = ["sine", "triangle", "saw", "square", "ramp", "random", "noise", "steps"];
/** 参数的编辑方式。 */
type ParamMode = "value" | "keys" | "curve";

interface KeyButtonProps {
  label: string;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}

/** ◆ 关键帧按钮：播放头处有关键帧时实心高亮。 */
function KeyButton({ label, active, disabled, onToggle }: KeyButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("size-6", active && "text-keyframe")}
      aria-pressed={active}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
    >
      <Diamond aria-hidden className={cn("size-3.5", active && "fill-current")} />
    </Button>
  );
}

/**
 * 外观片段的属性面板（剪映式关键帧）：强度、颜色各有 ◆ 按钮，在播放头处打 / 删关键帧；
 * 已有关键帧时改值会在播放头处自动打帧；可切换区段插值方式，强度还可以用数值曲线（正弦、方波…）。
 *
 * 显示的值是播放头处的值（由引擎按关键帧 / 曲线取值）。选中多个外观片段时一起改（各自按自己的起点换算时刻）。
 *
 * 输出 Cue 页的五个可折叠分区：强度、颜色、属性层、多灯分布、外观层复制粘贴（默认收起）；
 * 关键帧导航由 [`LookKeyNav`] 放在 Cue 页顶部的摘要里。
 *
 * @param props.cues 选中的外观片段（至少一个）。
 */
export function LookInspector({ cues }: { cues: readonly LookClip[] }) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const project = useProjectStore((s) => s.project);
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const engine = useEngine();

  const first = cues[0];
  const length = first.endMs - first.startMs;
  const u = playheadMs - first.startMs;
  const inside = u >= 0 && u <= length;
  const uClamped = clamp(u, 0, length);
  const ids = cues.map((c) => c.id);
  const look = first.look;

  /** 对每个选中片段按它自己的片段内时刻执行修改。 */
  const edit = (recipe: (look: LookClip["look"], uMs: number) => void) =>
    update((d) => void updateLooks(d, ids, (l, cue) => recipe(l, clamp(playheadMs - cue.startMs, 0, cue.endMs - cue.startMs))));

  const intensityAt = (() => {
    const p = look.intensity;
    if (!p) return 0;
    if (engine) {
      const v = engine.sampleNum(p, uClamped, length);
      if (Number.isFinite(v)) return v;
    }
    return paramHead(p) ?? 0;
  })();
  const colorAt = heldValueAt(look.color, uClamped);
  const rgbAt: Rgb = colorAt ? colorValueRgb(colorAt, project.output.gamma) : [255, 255, 255];
  // 轨道上的全部灯具：属性层取并集（任一台有的功能都能编辑），并标出支持的台数
  const trackFixtures = useMemo(() => {
    const track = project.tracks.find((tr) => tr.id === first.trackId);
    return track ? trackFixtureIds(project, track) : [];
  }, [project, first.trackId]);
  const support = useMemo(() => layerSupport(project, trackFixtures), [project, trackFixtures]);
  // 颜色预览用第一台能表现颜色的灯（都不能时用第一台）
  const target = useMemo(() => {
    const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
    const list = trackFixtures.flatMap((ref) => {
      // 像素轨道 / 像素分组：按像素取发光体与实际输出
      const { fixtureId, head } = parseRef(ref);
      const f = project.fixtures.find((x) => x.id === fixtureId);
      const model = f ? models.get(f.modelId) : undefined;
      return f && model ? [{ model, modeId: f.modeId, head }] : [];
    });
    return list.find((x) => supportsColor({ any: fixtureProfile(x.model, x.modeId).caps })) ?? list[0] ?? null;
  }, [project, trackFixtures]);
  const modes = useMemo(() => colorModes(project, trackFixtures), [project, trackFixtures]);
  const gamma = project.output.gamma;
  const available = useMemo(() => availableAttrsOf(project, trackFixtures), [project, trackFixtures]);
  const members = trackFixtures.length;
  const colorCount = colorSupportCount(support.caps);
  // 没有一台灯能表现颜色：不显示色盘（已有颜色层时提示并可移除）
  const colorUsable = members === 0 || colorCount > 0;

  const mode: ParamMode = look.intensity?.kind === "keys" ? "keys" : look.intensity?.kind === "curve" ? "curve" : "value";
  const setMode = (next: ParamMode) =>
    edit((l, uMs) => {
      const current = Math.round(intensityAt);
      if (next === "value") l.intensity = fixed(current);
      else if (next === "keys") l.intensity = toggleKeyAt(undefined, uMs, current);
      else
        l.intensity = {
          kind: "curve",
          curve: { shape: "sine", from: 0, to: Math.max(1, current), cycles: 2, phase: 0 },
        };
    });
  const curve = look.intensity?.kind === "curve" ? look.intensity.curve : null;
  const setCurve = (patch: Partial<ValueCurve>) =>
    edit((l) => {
      if (l.intensity?.kind !== "curve") return;
      const c = { ...l.intensity.curve, ...patch };
      // 切到步进波形时给一组默认步进
      if (c.shape === "steps" && !c.steps?.length) c.steps = [...DEFAULT_STEPS];
      l.intensity = {
        kind: "curve",
        curve: sanitizeCurve({
          ...c,
          from: clamp(c.from, 0, 100),
          to: clamp(c.to, 0, 100),
          cycles: clamp(Math.round(c.cycles * 100) / 100, 1, 1000),
          phase: clamp(c.phase, 0, 1),
        }),
      };
    });

  const segmentSelect = (p: Param<number> | Param<ColorValue> | undefined, which: "intensity" | "color") => {
    const current = segmentCurve(p as Param<number> | undefined, uClamped);
    if (current === null || (p?.kind === "keys" && p.keys.length < 2)) return null;
    return (
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground">{t("editor.look.segment")}</Label>
        <Select
          value={current}
          onValueChange={(v) =>
            edit((l, uMs) => {
              const target = l[which];
              if (target) (l as Record<string, unknown>)[which] = setSegmentCurve(target as Param<number>, uMs, v as Curve);
            })
          }
        >
          <SelectTrigger className="h-7 w-32 text-xs" aria-label={t("editor.look.segmentOf", { name: t(`editor.look.${which}`) })}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CURVES.map((c) => (
              <SelectItem key={c} value={c}>
                {t(`editor.look.curves.${c}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  };

  const number = (label: string, value: number, onCommit: (n: number) => void, unit?: string) => (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <span className="flex items-center gap-1">
        <CommitInput
          className="num h-7 px-1.5 text-xs"
          inputMode="numeric"
          label={label}
          value={Number(value.toFixed(2))}
          onCommit={(text) => {
            const n = Number(text);
            if (Number.isFinite(n)) onCommit(n);
          }}
        />
        {unit && <span>{unit}</span>}
      </span>
    </label>
  );

  // 分区：强度、颜色、属性层、多灯分布、复制粘贴（关键帧导航在 Cue 页顶部的摘要里，见 `LookKeyNav`）
  return (
    <>
      <InspectorSection scope="cue" id="intensity" title={t("editor.look.intensity")}>
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <Segmented<ParamMode>
            ariaLabel={t("editor.look.intensityMode")}
            value={mode}
            options={(["value", "keys", "curve"] as const).map((m) => ({ value: m, label: t(`editor.look.modes.${m}`) }))}
            onChange={setMode}
          />
          <KeyButton
            label={t("editor.look.keyOf", { name: t("editor.look.intensity") })}
            active={hasKeyAt(look.intensity, u)}
            disabled={!inside || mode === "curve"}
            onToggle={() => edit((l, uMs) => void (l.intensity = toggleKeyAt(l.intensity, uMs, Math.round(intensityAt))))}
          />
        </div>
        {mode !== "curve" ? (
          <SliderField
            label={t("editor.look.intensity")}
            numberLabel={t("editor.look.intensityValue")}
            value={Math.round(intensityAt)}
            min={0}
            max={100}
            unit="%"
            onCommit={(v) => edit((l, uMs) => void (l.intensity = setValueAt(l.intensity, uMs, v)))}
          />
        ) : (
          curve && (
            <div className="grid gap-2 rounded-md border border-border p-2">
              <div className="flex items-center gap-2">
                <Label className="text-xs">{t("editor.look.shape")}</Label>
                <Select value={curve.shape} onValueChange={(v) => setCurve({ shape: v as WaveShape })}>
                  <SelectTrigger className="h-7 w-32 text-xs" aria-label={t("editor.look.shape")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SHAPES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(`editor.look.shapes.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="num ml-auto text-xs text-muted-foreground">
                  {t("editor.look.now", { value: Math.round(intensityAt) })}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {number(t("editor.look.from"), curve.from, (n) => setCurve({ from: n }), "%")}
                {number(t("editor.look.to"), curve.to, (n) => setCurve({ to: n }), "%")}
              </div>
              <CycleTimingFields
                timing={curve}
                onChange={(patch) => setCurve(patch)}
                lengthMs={length}
                tempo={project.tempo}
                name={t("editor.look.intensity")}
              />
              <CurveShapeFields curve={curve} onChange={setCurve} name={t("editor.look.intensity")} />
              {unsafeFlash(look, length, project.tempo) && (
                <p role="alert" className="flex items-start gap-1.5 text-xs text-warning">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {t("editor.look.unsafeFlash", { hz: flashRateHz(look, length, project.tempo).toFixed(1), max: MAX_SAFE_STROBE_HZ })}
                </p>
              )}
            </div>
          )
        )}
        {mode === "keys" && segmentSelect(look.intensity, "intensity")}
      </div>
      </InspectorSection>

      <InspectorSection
        scope="cue"
        id="color"
        title={t("editor.look.color")}
        aside={
          colorUsable && colorAt ? (
            <span aria-hidden className="size-3.5 rounded-sm border border-border" style={{ backgroundColor: `rgb(${rgbAt.join(",")})` }} />
          ) : null
        }
      >
      {!colorUsable ? (
        <div className="grid gap-1.5 rounded-md border border-dashed border-border p-2">
          <p className={cn("flex items-center gap-1.5 text-xs", look.color ? "text-warning" : "text-muted-foreground")}>
            {look.color && <TriangleAlert className="size-3.5 shrink-0" aria-hidden />}
            {t(look.color ? "editor.look.colorUnsupported" : "editor.look.noColor")}
          </p>
          {look.color && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 justify-self-start"
              onClick={() => edit((l) => void delete l.color)}
            >
              {t("editor.look.removeColor")}
            </Button>
          )}
        </div>
      ) : (
      <div className="grid gap-2">
        {colorCount > 0 && colorCount < members && (
          <p className="text-[11px] text-muted-foreground">
            {t("editor.look.colorPartial", { supported: colorCount, total: members })}
          </p>
        )}
        <div className="flex items-center justify-end">
          <KeyButton
            label={t("editor.look.keyOf", { name: t("editor.look.color") })}
            active={hasKeyAt(look.color, u)}
            disabled={!inside}
            onToggle={() =>
              edit((l, uMs) => void (l.color = toggleKeyAt(l.color, uMs, colorAt ?? { kind: "rgb", rgb: rgbAt })))
            }
          />
        </div>
        <ColorPicker
          key={`${ids.join(",")}:${Math.round(uClamped)}`}
          value={colorAt}
          target={target}
          gamma={gamma}
          modes={modes}
          onCommit={(color) => edit((l, uMs) => void (l.color = setValueAt(l.color, uMs, color)))}
        />
        {look.color?.kind === "keys" && segmentSelect(look.color, "color")}
      </div>
      )}
      </InspectorSection>

      <InspectorSection
        scope="cue"
        id="layers"
        title={t("editor.layers.title")}
        aside={<span className="num">{Object.keys(look.attrs ?? {}).length}</span>}
      >
        <AttributeLayers
          look={look}
          available={available}
          total={members > 1 ? members : undefined}
          uMs={uClamped}
          lengthMs={length}
          inside={inside}
          engine={engine}
          edit={edit}
        />
      </InspectorSection>

      <InspectorSection scope="cue" id="spread" title={t("editor.spread.title")}>
        <SpreadPanel
          look={look}
          spread={first.spread}
          members={members}
          onChange={(spread) => update((d) => void setSpread(d, ids, spread))}
        />
      </InspectorSection>

      <InspectorSection scope="cue" id="clipboard" title={t("editor.layers.clipboard")} defaultOpen={false}>
        <LayerClipboardBar look={look} onPaste={(source) => edit((l) => mergeLayers(l, source))} />
      </InspectorSection>
    </>
  );
}

/**
 * 外观片段的关键帧导航（放在 Cue 页顶部的摘要里）：跳到上一个 / 下一个关键帧、帧数；
 * 播放头在片段外时提示不能打关键帧。
 *
 * @param props.cues 选中的外观片段（至少一个；按第一个计算）。
 */
export function LookKeyNav({ cues }: { cues: readonly LookClip[] }) {
  const { t } = useTranslation();
  const playheadMs = useEditorUiStore((s) => s.playheadMs);
  const setPlayhead = useEditorUiStore((s) => s.setPlayhead);
  const first = cues[0];
  const u = playheadMs - first.startMs;
  const inside = u >= 0 && u <= first.endMs - first.startMs;
  const keyTimes = lookKeyTimes(first.look);
  const jump = (dir: 1 | -1) => {
    const k = adjacentKey(keyTimes, u, dir);
    if (k !== null) setPlayhead(first.startMs + k);
  };
  return (
    <div className="flex flex-col gap-0.5">
      <div role="group" aria-label={t("editor.look.keyNav")} className="flex items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={t("editor.look.prevKey")}
          title={t("editor.look.prevKey")}
          disabled={adjacentKey(keyTimes, u, -1) === null}
          onClick={() => jump(-1)}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <span className="num text-[11px] text-muted-foreground">{t("editor.look.keyCount", { count: keyTimes.length })}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={t("editor.look.nextKey")}
          title={t("editor.look.nextKey")}
          disabled={adjacentKey(keyTimes, u, 1) === null}
          onClick={() => jump(1)}
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>
      {!inside && <p className="text-xs text-muted-foreground">{t("editor.look.outside")}</p>}
    </div>
  );
}

/**
 * 外观层的选择性复制粘贴：复制当前片段的外观，粘贴时勾选要哪些层组（强度、颜色、位置、光束…）。
 *
 * @param props.look 当前（第一个选中片段的）外观。
 * @param props.onPaste 粘贴挑出来的层。
 */
function LayerClipboardBar({ look, onPaste }: { look: Look; onPaste: (source: Look) => void }) {
  const { t } = useTranslation();
  const clipboard = useEditorUiStore((s) => s.lookClipboard);
  const setClipboard = useEditorUiStore((s) => s.setLookClipboard);
  const groups = clipboard ? layerGroupsOf(clipboard) : [];
  const [picked, setPicked] = useState<ReadonlySet<LayerGroup> | null>(null);
  const chosen = picked ?? new Set(groups);

  // 外层的分区（“外观层复制粘贴”）提供标题
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            setClipboard(pickLayers(look, new Set(layerGroupsOf(look))));
            setPicked(null);
            announce(t("editor.layers.copied"));
          }}
        >
          <Copy aria-hidden />
          {t("editor.layers.copy")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          disabled={!clipboard || chosen.size === 0}
          onClick={() => {
            if (!clipboard) return;
            onPaste(pickLayers(clipboard, chosen));
            announce(t("editor.layers.pasted", { count: chosen.size }));
          }}
        >
          <ClipboardPaste aria-hidden />
          {t("editor.layers.paste")}
        </Button>
      </div>
      {clipboard && groups.length > 0 && (
        <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <legend className="sr-only">{t("editor.layers.pasteWhich")}</legend>
          {groups.map((g) => (
            <label key={g} className="flex items-center gap-1">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={chosen.has(g)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(g);
                  else next.delete(g);
                  setPicked(next);
                }}
              />
              {t(`fixtures.groups.${g}`)}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
