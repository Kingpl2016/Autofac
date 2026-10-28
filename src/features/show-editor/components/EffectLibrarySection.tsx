import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Aperture,
  Blend,
  ChevronDown,
  ChevronRight,
  Copy,
  Diamond,
  Fan,
  FileDown,
  FileUp,
  FolderOpen,
  Infinity as InfinityIcon,
  MoveHorizontal,
  MoveRight,
  MoveVertical,
  Orbit,
  Palette,
  Plus,
  Rainbow,
  RefreshCw,
  Repeat,
  RotateCcw,
  RotateCw,
  Shuffle,
  Sparkles,
  Square,
  Sunrise,
  Sunset,
  Trash2,
  TriangleAlert,
  Waves,
  Zap,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { Segmented } from "@/shared/components/Segmented";
import { announce } from "@/shared/stores/announcerStore";
import { pickJsonFile, pickSavePath } from "@/shared/tauri/pickers";
import { useCueActions } from "../hooks/useCueActions";
import { supportedTargets } from "../hooks/useTargetCapabilities";
import { applicability, type Applicability } from "../lib/cueDefaults";
import { addLookCue } from "../lib/cueOps";
import { templateErrorCode } from "../lib/cueTemplateApi";
import { exportEffectFile, importEffectFile, revealUserEffects } from "../lib/effectApi";
import {
  buildEffectLook,
  copyEffectToUser,
  defaultEffectParams,
  EFFECT_GROUPS,
  effectDefNeeds,
  effectName,
  groupEffects,
  importEffects,
  localizedText,
  MAX_WINGS,
  parseEffectText,
  removeEffect,
  serializeEffects,
  type EffectDef,
  type EffectIssue,
  type EffectParams,
} from "../lib/effectLibrary";
import { periodMs } from "../lib/effects";
import type { TrackCapabilities } from "../lib/fixtureProfile";
import { trackFixtureIds } from "../lib/ops";
import { allEffects, useEffectLibraryStore } from "../stores/useEffectLibraryStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { ApplyBadge } from "./ApplyBadge";
import { CommitInput } from "./CommitInput";

/** 特效定义里的图标名 → lucide 图标。 */
const ICONS: Record<string, LucideIcon> = {
  orbit: Orbit,
  infinity: InfinityIcon,
  diamond: Diamond,
  square: Square,
  moveHorizontal: MoveHorizontal,
  moveVertical: MoveVertical,
  fan: Fan,
  shuffle: Shuffle,
  waves: Waves,
  moveRight: MoveRight,
  activity: Activity,
  sparkles: Sparkles,
  sunrise: Sunrise,
  sunset: Sunset,
  zap: Zap,
  rainbow: Rainbow,
  repeat: Repeat,
  palette: Palette,
  blend: Blend,
  zoomIn: ZoomIn,
  aperture: Aperture,
  rotateCw: RotateCw,
};

/** 新建特效片段的默认长度（毫秒）。 */
const EFFECT_CLIP_MS = 8000;

/**
 * 在所选轨道（多选时每条支持的轨道）的播放头处插入一个特效片段，每条轨道按自己的成员数展开。
 *
 * @param def 特效。
 * @param params 参数。
 * @param actions 片段操作（一步撤销）。
 * @param t 翻译函数。
 * @param lang 界面语言。
 */
function insertEffect(
  def: EffectDef,
  params: EffectParams,
  actions: ReturnType<typeof useCueActions>,
  t: (key: string, opts?: Record<string, unknown>) => string,
  lang: string,
) {
  const project = useProjectStore.getState().project;
  const { playheadMs } = useEditorUiStore.getState();
  const needs = effectDefNeeds(def);
  const { all, supported: trackIds } = supportedTargets(project, useEditorUiStore.getState(), needs);
  if (all.length === 0) {
    announce(t("editor.templates.noTrack"));
    return;
  }
  if (trackIds.length === 0) {
    announce(t("editor.apply.rejected", { reason: t(`editor.apply.needs.${needs}`) }));
    return;
  }
  const created = actions.insertOnTracks(trackIds, (d, trackId) => {
    const track = d.tracks.find((tr) => tr.id === trackId);
    if (!track) return null;
    const { look, spread } = buildEffectLook(def, params, {
      lengthMs: EFFECT_CLIP_MS,
      members: trackFixtureIds(d, track).length,
      tempo: project.tempo,
    });
    return addLookCue(d, trackId, playheadMs, look, EFFECT_CLIP_MS, spread);
  });
  if (created.length > 0) useEditorUiStore.getState().setInspectorTab("cue");
  if (trackIds.length === 1) {
    announce(created.length > 0 ? t("editor.attrEffects.added", { name: effectName(def, lang) }) : t("editor.templates.noRoom"));
  }
}

/**
 * 素材库“特效”标签里的属性特效库：按分组列出配置文件里的特效（内置 + 用户），
 * 点一下选中并打开参数面板（速度、大小、相位扩散、分翼、方向、顺序），“插入”加到所选轨道；双击直接按当前参数插入。
 * 右键：内置特效“复制为我的特效”，用户特效可复制、删除。工具条可导入 / 导出 / 打开所在文件夹 / 重新加载。
 */
export function EffectLibrarySection({ caps }: { caps: TrackCapabilities[] }) {
  const { t, i18n } = useTranslation();
  const actions = useCueActions();
  const user = useEffectLibraryStore((s) => s.user);
  const status = useEffectLibraryStore((s) => s.status);
  const error = useEffectLibraryStore((s) => s.error);
  const issues = useEffectLibraryStore((s) => s.issues);
  const load = useEffectLibraryStore((s) => s.load);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paramsById, setParamsById] = useState<ReadonlyMap<string, EffectParams>>(new Map());

  useEffect(() => {
    if (useEffectLibraryStore.getState().status === "idle") void load();
  }, [load]);

  const effects = useMemo(() => allEffects({ user }), [user]);
  const grouped = useMemo(() => groupEffects(effects), [effects]);
  const selected = effects.find((e) => e.id === selectedId) ?? null;
  const paramsOf = (def: EffectDef) => paramsById.get(def.id) ?? defaultEffectParams(def);
  const setParams = (def: EffectDef, patch: Partial<EffectParams> | null) =>
    setParamsById((prev) => {
      const next = new Map(prev);
      if (patch === null) next.delete(def.id);
      else next.set(def.id, { ...(prev.get(def.id) ?? defaultEffectParams(def)), ...patch });
      return next;
    });
  const groupLabel = (g: string) => ((EFFECT_GROUPS as readonly string[]).includes(g) ? t(`editor.effectLib.groups.${g}`) : g);

  const store = useEffectLibraryStore.getState;
  const fail = (e: unknown) => toast.error(t(`editor.templates.errors.${templateErrorCode(e)}`));
  const save = async (next: EffectDef[]) => {
    const ok = await store().saveUser(next);
    if (!ok) fail(store().error);
    return ok;
  };
  const copy = async (def: EffectDef) => {
    const { next, created } = copyEffectToUser(store().user, allEffects(store()), def, t("editor.templates.copySuffix"));
    if (await save(next)) {
      announce(t("editor.effectLib.copied", { name: effectName(created, i18n.language) }));
      setSelectedId(created.id);
    }
  };
  const remove = async (def: EffectDef) => {
    const prev = store().user;
    if (!(await save(removeEffect(prev, def.id)))) return;
    const text = t("editor.effectLib.deleted", { name: effectName(def, i18n.language) });
    announce(text);
    toast(text, { action: { label: t("editor.undoAction"), onClick: () => void save(prev) } });
  };
  const onImport = async () => {
    const path = await pickJsonFile(t("editor.effectLib.fileType"));
    if (!path) return;
    try {
      const parsed = parseEffectText(await importEffectFile(path));
      if (parsed.effects.length === 0) {
        toast.error(t("editor.effectLib.importEmpty"));
        return;
      }
      const { next, added, replaced } = importEffects(store().user, parsed.effects);
      if (!(await save(next))) return;
      const text = t("editor.effectLib.imported", { added, replaced, skipped: parsed.issues.filter((x) => x.index !== null).length });
      announce(text);
      toast.success(text);
    } catch (e) {
      fail(e);
    }
  };
  const onExport = async () => {
    const path = await pickSavePath("effects.json", ["json"]);
    if (!path) return;
    try {
      await exportEffectFile(path.toLowerCase().endsWith(".json") ? path : `${path}.json`, serializeEffects(effects));
      toast.success(t("editor.effectLib.exported", { count: effects.length }));
    } catch (e) {
      fail(e);
    }
  };
  const onReveal = async () => {
    try {
      await revealUserEffects();
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const onReload = async () => {
    await load();
    const s = store();
    announce(s.status === "ready" ? t("editor.effectLib.reloaded", { count: s.user.length }) : t(`editor.templates.errors.${s.error ?? "io"}`));
  };
  const tool = (label: string, icon: ReactNode, onClick: () => void) => (
    <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={label} title={label} onClick={onClick}>
      {icon}
    </Button>
  );

  return (
    <section data-tour="effects" aria-label={t("editor.attrEffects.title")} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{t("editor.attrEffects.title")}</h3>
        <div role="toolbar" aria-label={t("editor.effectLib.tools")} className="flex shrink-0 items-center">
          {tool(t("editor.effectLib.import"), <FileUp aria-hidden />, () => void onImport())}
          {tool(t("editor.effectLib.export"), <FileDown aria-hidden />, () => void onExport())}
          {tool(t("editor.effectLib.reveal"), <FolderOpen aria-hidden />, () => void onReveal())}
          {tool(t("editor.effectLib.reload"), <RefreshCw aria-hidden className={cn(status === "loading" && "animate-spin motion-reduce:animate-none")} />, () => void onReload())}
        </div>
      </div>
      <p className="px-1 text-xs text-muted-foreground">{t("editor.effectLib.hint")}</p>
      {status === "error" && (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          {t("editor.effectLib.loadFailed", { reason: t(`editor.templates.errors.${error ?? "io"}`) })}
        </p>
      )}
      <Issues issues={issues} />
      {grouped.map(({ group, effects: list }) => {
        const open = !collapsed.has(group);
        const label = groupLabel(group);
        return (
          <div key={group} className="grid gap-1.5">
            <button
              type="button"
              aria-expanded={open}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(group)) next.delete(group);
                  else next.add(group);
                  return next;
                })
              }
              className="flex items-center gap-1 rounded-sm px-1 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="num">{list.length}</span>
            </button>
            {open && (
              <ul aria-label={t("editor.effectLib.groupList", { name: label })} className="grid grid-cols-2 gap-1.5">
                {list.map((def) => (
                  <li key={def.id}>
                    <EffectItem
                      def={def}
                      app={caps.length > 0 ? applicability(caps, effectDefNeeds(def)) : null}
                      selected={def.id === selectedId}
                      onSelect={() => setSelectedId(def.id === selectedId ? null : def.id)}
                      onInsert={() => insertEffect(def, paramsOf(def), actions, t, i18n.language)}
                      onCopy={() => void copy(def)}
                      onDelete={() => void remove(def)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {open && selected && selected.group === group && (
              <EffectParamsPanel
                def={selected}
                params={paramsOf(selected)}
                onChange={(patch) => setParams(selected, patch)}
                onReset={() => setParams(selected, null)}
                onInsert={() => insertEffect(selected, paramsOf(selected), actions, t, i18n.language)}
              />
            )}
          </div>
        );
      })}
      <p className="px-1 text-[11px] text-muted-foreground">{t("editor.effectLib.fileHint")}</p>
    </section>
  );
}

/** 一个特效卡片（点击选中、双击插入、右键复制 / 删除）。 */
function EffectItem({
  def,
  app,
  selected,
  onSelect,
  onInsert,
  onCopy,
  onDelete,
}: {
  def: EffectDef;
  app: Applicability | null;
  selected: boolean;
  onSelect: () => void;
  onInsert: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const name = effectName(def, i18n.language);
  const Icon = ICONS[def.icon ?? ""] ?? Sparkles;
  const badgeId = `effect-badge-${def.id}`;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          aria-pressed={selected}
          aria-label={name}
          aria-describedby={app && app.level !== "full" ? badgeId : undefined}
          title={localizedText(def.hint, i18n.language) || name}
          data-effect-id={def.id}
          onClick={onSelect}
          onDoubleClick={onInsert}
          className={cn(
            "flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-left text-sm hover:bg-surface-3",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected ? "border-primary bg-primary/10" : "border-border",
            app?.level === "none" && "opacity-50",
          )}
        >
          <Icon className="size-4 shrink-0 text-clip-light" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <ApplyBadge app={app} id={badgeId} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={t("editor.effectLib.menu", { name })}>
        <ContextMenuItem onSelect={onInsert}>
          <Plus aria-hidden />
          {t("editor.effectLib.insert")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCopy}>
          <Copy aria-hidden />
          {def.builtin ? t("editor.effectLib.copyToMine") : t("editor.effectLib.duplicate")}
        </ContextMenuItem>
        {!def.builtin && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 aria-hidden />
              {t("editor.effectLib.delete")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * 插入前的参数面板：速度（拍 / 毫秒）、大小、相位扩散、分翼、方向、顺序。
 * 参数只影响接下来插入的片段；插入后可以在属性面板里继续改曲线和分布。
 */
function EffectParamsPanel({
  def,
  params,
  onChange,
  onReset,
  onInsert,
}: {
  def: EffectDef;
  params: EffectParams;
  onChange: (patch: Partial<EffectParams>) => void;
  onReset: () => void;
  onInsert: () => void;
}) {
  const { t, i18n } = useTranslation();
  const tempo = useProjectStore((s) => s.project.tempo);
  const name = effectName(def, i18n.language);
  const beats = params.period.kind === "beats";
  const periodValue = params.period.kind === "beats" ? params.period.beats : params.period.ms;
  // 大小统一按 0~100% 显示：幅度类 0.5 为满行程
  const sizePct = def.scale === "fraction" ? Math.round(params.size * 200) : Math.round(params.size);
  const num = (text: string) => {
    const v = Number(text);
    return Number.isFinite(v) ? v : null;
  };
  const switchUnit = (unit: "beats" | "ms") => {
    if (unit === params.period.kind) return;
    const ms = periodMs(params.period, tempo);
    const beatMs = periodMs({ kind: "beats", beats: 1 }, tempo);
    onChange({
      period: unit === "ms" ? { kind: "ms", ms: Math.round(ms) } : { kind: "beats", beats: Math.max(0.25, Math.round((ms / beatMs) * 4) / 4) },
    });
  };
  const row = "flex items-center gap-1.5";
  const label = "w-14 shrink-0 text-xs text-muted-foreground";
  const field = "num h-7 w-16 px-2 text-xs";

  return (
    <div role="group" aria-label={t("editor.effectLib.params", { name })} className="grid gap-2 rounded-md border border-primary/40 bg-surface-1 p-2">
      <p className="text-xs text-muted-foreground">{localizedText(def.hint, i18n.language)}</p>
      <div className={row}>
        <span className={label}>{t("editor.effectLib.speed")}</span>
        <CommitInput
          className={field}
          inputMode="numeric"
          label={t("editor.effectLib.speedValue")}
          value={periodValue}
          onCommit={(v) => {
            const n = num(v);
            if (n === null || n <= 0) return;
            onChange({ period: beats ? { kind: "beats", beats: Math.min(64, Math.max(0.125, n)) } : { kind: "ms", ms: Math.min(600_000, Math.max(33, Math.round(n))) } });
          }}
        />
        <Segmented
          size="xs"
          ariaLabel={t("editor.effectLib.speedUnit")}
          value={params.period.kind}
          onChange={switchUnit}
          options={[
            { value: "beats", label: t("editor.effectLib.beats") },
            { value: "ms", label: t("editor.effectLib.ms") },
          ]}
        />
      </div>
      <div className={row}>
        <span className={label}>{t("editor.effectLib.size")}</span>
        <CommitInput
          className={field}
          inputMode="numeric"
          label={t("editor.effectLib.sizeValue")}
          value={sizePct}
          onCommit={(v) => {
            const n = num(v);
            if (n === null) return;
            const pct = Math.min(100, Math.max(0, n));
            onChange({ size: def.scale === "fraction" ? pct / 200 : pct });
          }}
        />
        <span className="text-xs text-muted-foreground">%</span>
      </div>
      <div className={row}>
        <span className={label}>{t("editor.effectLib.spread")}</span>
        <CommitInput
          className={field}
          inputMode="numeric"
          label={t("editor.effectLib.spreadValue")}
          value={Math.round(params.spread * 100)}
          onCommit={(v) => {
            const n = num(v);
            if (n !== null) onChange({ spread: Math.min(400, Math.max(0, n)) / 100 });
          }}
        />
        <span className="text-xs text-muted-foreground">%</span>
      </div>
      <div className={row}>
        <span className={label}>{t("editor.effectLib.wings")}</span>
        <Segmented
          size="xs"
          ariaLabel={t("editor.effectLib.wings")}
          value={String(params.wings)}
          onChange={(v) => onChange({ wings: Number(v) })}
          options={Array.from({ length: MAX_WINGS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
        />
      </div>
      <div className={row}>
        <span className={label}>{t("editor.effectLib.direction")}</span>
        <Segmented
          size="xs"
          ariaLabel={t("editor.effectLib.direction")}
          value={params.direction > 0 ? "forward" : "reverse"}
          onChange={(v) => onChange({ direction: v === "forward" ? 1 : -1 })}
          options={[
            { value: "forward", label: t("editor.effectLib.forward") },
            { value: "reverse", label: t("editor.effectLib.reverse") },
          ]}
        />
      </div>
      <div className={row}>
        <span className={label}>{t("editor.effectLib.order")}</span>
        <Segmented
          size="xs"
          ariaLabel={t("editor.effectLib.order")}
          value={params.order}
          onChange={(v) => onChange({ order: v })}
          options={[
            { value: "members", label: t("editor.effectLib.orders.members") },
            { value: "stageX", label: t("editor.effectLib.orders.stageX") },
            { value: "stageY", label: t("editor.effectLib.orders.stageY") },
          ]}
        />
      </div>
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onReset}>
          <RotateCcw aria-hidden />
          {t("editor.effectLib.reset")}
        </Button>
        <Button type="button" size="sm" className="h-7 gap-1 px-3 text-xs" onClick={onInsert}>
          <Plus aria-hidden />
          {t("editor.effectLib.insertSelected")}
        </Button>
      </div>
    </div>
  );
}

/** 用户特效文件里被跳过的条目。 */
function Issues({ issues }: { issues: readonly EffectIssue[] }) {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  return (
    <div role="alert" className="grid gap-1 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
      <p className="flex items-center gap-1 font-medium">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {t("editor.effectLib.issuesTitle", { count: issues.length })}
      </p>
      <ul className="grid gap-0.5">
        {issues.slice(0, 5).map((it, i) => (
          <li key={i} className="num truncate">
            {it.index === null ? t("editor.templates.issueFile", { message: it.message }) : t("editor.templates.issueItem", { index: it.index, message: it.message })}
          </li>
        ))}
      </ul>
    </div>
  );
}
