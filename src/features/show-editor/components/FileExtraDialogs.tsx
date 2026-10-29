import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Clapperboard, Copy, FolderOpen, FolderSearch, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RECORDINGS_QUERY_KEY, recordingsList } from "@/features/recording";
import { Segmented } from "@/shared/components/Segmented";
import { formatBytes } from "@/shared/lib/format";
import { announce } from "@/shared/stores/announcerStore";
import { pickArtshowFile } from "@/shared/tauri/pickers";
import type { ShowFileController } from "../hooks/useShowFile";
import { importShow, readShow } from "../hooks/showFileActions";
import { projectEndMs, summarizeProject, type MergeOptions } from "../lib/mergeProject";
import { usedUniverses } from "../lib/patch";
import type { ShowProject } from "../lib/project";
import { showErrorText, showFileInfo, type ShowFileKind } from "../lib/showFile";
import { formatTimecode } from "../lib/time";
import { useDocumentStore } from "../stores/useDocumentStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { fileStem } from "../stores/useRecentFilesStore";

/** 导入的起点：节目开头、播放头处，或接在当前最后一个片段之后。 */
type ImportAt = "start" | "playhead" | "end";

/** 选好的导入来源。 */
interface ImportSource {
  kind: ShowFileKind;
  path: string;
  name: string;
  project: ShowProject;
}

/**
 * 导入节目：选一个节目库里的节目或 `.artshow` 文件，合并进当前工程（一步撤销）。
 *
 * 灯具（连同模型与分组）总是导入；时间线、全部预设、标记与段落可选；可以重新配接到空闲地址，
 * 时间线可以从开头、播放头或当前节目末尾开始。
 */
export function ImportShowDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<ImportSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<Omit<MergeOptions, "offsetMs">>({ timeline: true, presets: true, markers: false, repatch: true });
  const [at, setAt] = useState<ImportAt>("start");
  const library = useQuery({ queryKey: RECORDINGS_QUERY_KEY, queryFn: recordingsList, enabled: source === null });
  const editable = (library.data ?? []).filter((e) => e.editable);

  const load = async (kind: ShowFileKind, path: string, name: string) => {
    setLoading(true);
    try {
      const project = await readShow(kind, path);
      setSource({ kind, path, name: project.name.trim() || name, project });
    } catch (e) {
      toast.error(showErrorText(t, e));
    } finally {
      setLoading(false);
    }
  };
  const pickFile = async () => {
    const path = await pickArtshowFile(t("editor.file.fileType"));
    if (path) await load("external", path, fileStem(path));
  };

  const offsetOf = (where: ImportAt) =>
    where === "playhead"
      ? useEditorUiStore.getState().playheadMs
      : where === "end"
        ? projectEndMs(useProjectStore.getState().project)
        : 0;
  const submit = () => {
    if (!source) return;
    try {
      const report = importShow(source.project, { ...options, offsetMs: offsetOf(at) });
      const text = t("editor.importShow.done", {
        name: source.name,
        fixtures: report.fixtures,
        tracks: report.tracks,
        cues: report.cues,
        presets: report.presets,
      });
      toast.success(text, report.unpatched > 0 ? { description: t("editor.importShow.unpatched", { count: report.unpatched }) } : undefined);
      announce(text);
      onClose();
    } catch (e) {
      toast.error(showErrorText(t, e));
    }
  };

  const summary = source ? summarizeProject(source.project) : null;
  const check = (key: keyof typeof options, label: string, hint?: string) => (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <Checkbox
        className="mt-0.5"
        aria-label={label}
        checked={options[key]}
        onCheckedChange={(v) => setOptions((o) => ({ ...o, [key]: v === true }))}
      />
      <span className="grid gap-0.5">
        {label}
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && !loading && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("editor.importShow.title")}</DialogTitle>
          <DialogDescription>{t("editor.importShow.description")}</DialogDescription>
        </DialogHeader>

        {!source ? (
          <div className="grid gap-3">
            <Button type="button" variant="outline" className="justify-start gap-2" disabled={loading} onClick={() => void pickFile()}>
              <FolderSearch aria-hidden />
              {t("editor.importShow.pickFile")}
            </Button>
            <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{t("editor.importShow.fromLibrary")}</p>
            {library.isLoading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
            {library.isError && <p role="alert" className="text-sm text-destructive">{t("editor.file.openFailed")}</p>}
            {!library.isLoading && !library.isError && editable.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("editor.file.openEmpty")}</p>
            )}
            <ul aria-label={t("editor.importShow.fromLibrary")} className="grid gap-1.5">
              {editable.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void load("library", e.path, e.name)}
                    className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <Clapperboard className="size-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{e.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{new Date(e.modifiedUnixMs).toLocaleString()}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {loading && (
              <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                {t("common.loading")}
              </p>
            )}
          </div>
        ) : (
          summary && (
            <div className="grid gap-4">
              <section aria-label={t("editor.importShow.summaryTitle")} className="grid gap-1 rounded-md bg-surface-1 p-3 text-sm">
                <p className="font-medium">{source.name}</p>
                <p className="text-muted-foreground">
                  {t("editor.importShow.summary", {
                    fixtures: summary.fixtures,
                    groups: summary.groups,
                    tracks: summary.tracks,
                    cues: summary.cues,
                    presets: summary.presets,
                    markers: summary.markers,
                  })}
                </p>
              </section>
              <div className="grid gap-2.5">
                <p className="text-sm text-muted-foreground">{t("editor.importShow.fixturesAlways")}</p>
                {check("repatch", t("editor.importShow.repatch"), t("editor.importShow.repatchHint"))}
                {check("timeline", t("editor.importShow.timeline"))}
                {check("presets", t("editor.importShow.presets"), t("editor.importShow.presetsHint"))}
                {check("markers", t("editor.importShow.markers"))}
              </div>
              {(options.timeline || options.markers) && (
                <div className="grid gap-1.5">
                  <span className="text-sm">{t("editor.importShow.at")}</span>
                  <Segmented
                    size="xs"
                    ariaLabel={t("editor.importShow.at")}
                    value={at}
                    onChange={setAt}
                    options={(["start", "playhead", "end"] as const).map((v) => ({
                      value: v,
                      label: t(`editor.importShow.atModes.${v}`, { time: formatTimecode(offsetOf(v)) }),
                    }))}
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground">{t("editor.importShow.notImported")}</p>
            </div>
          )
        )}

        <DialogFooter>
          {source && (
            <Button type="button" variant="ghost" className="mr-auto" onClick={() => setSource(null)}>
              {t("editor.importShow.back")}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
            {t("common.cancel")}
          </Button>
          {source && (
            <Button type="button" onClick={submit}>
              {t("editor.importShow.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一行“名称：值”。 */
function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "num break-all" : "break-words"}>{value}</dd>
    </div>
  );
}

/**
 * 节目信息：名称、位置、文件大小与修改时间（节目库条目还有回放文件），以及灯具、轨道、片段等统计。
 */
export function ShowInfoDialog({ file }: { file: ShowFileController }) {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const origin = useDocumentStore((s) => s.origin);
  const info = useQuery({
    queryKey: ["show-file-info", origin.kind, origin.kind === "none" ? "" : origin.path],
    queryFn: () => (origin.kind === "none" ? null : showFileInfo(origin.kind, origin.path)),
    enabled: origin.kind !== "none",
  });
  const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : t("editor.showInfo.unknown"));
  const s = summarizeProject(project);
  const where =
    origin.kind === "none" ? t("editor.showInfo.unsaved") : origin.kind === "library" ? t("editor.showInfo.library") : t("editor.showInfo.external");

  return (
    <Dialog open onOpenChange={(o) => !o && file.closeDialog()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("editor.showInfo.title")}</DialogTitle>
          <DialogDescription>{project.name.trim() || t("editor.untitled")}</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-1.5">
          <InfoRow label={t("editor.showInfo.where")} value={where} />
          {origin.kind !== "none" && <InfoRow label={t("editor.showInfo.path")} value={origin.path} mono />}
          {info.data && (
            <>
              <InfoRow
                label={t("editor.showInfo.projectFile")}
                value={info.data.exists ? `${formatBytes(info.data.bytes)} · ${when(info.data.modifiedUnixMs)}` : t("editor.showInfo.missing")}
              />
              {info.data.artrecPath !== null && (
                <InfoRow
                  label={t("editor.showInfo.artrec")}
                  value={info.data.artrecBytes !== null ? `${formatBytes(info.data.artrecBytes)} · ${when(info.data.artrecModifiedUnixMs)}` : t("editor.showInfo.notBaked")}
                />
              )}
            </>
          )}
          {info.isError && <InfoRow label={t("editor.showInfo.projectFile")} value={showErrorText(t, info.error)} />}
          <InfoRow label={t("editor.showInfo.status")} value={file.dirty ? t("editor.showInfo.dirty") : t("editor.showInfo.clean")} />
          <InfoRow label={t("editor.showInfo.duration")} value={formatTimecode(project.durationMs)} mono />
          <InfoRow
            label={t("editor.showInfo.content")}
            value={t("editor.importShow.summary", {
              fixtures: s.fixtures,
              groups: s.groups,
              tracks: s.tracks,
              cues: s.cues,
              presets: s.presets,
              markers: s.markers,
            })}
          />
          <InfoRow label={t("editor.showInfo.universes")} value={usedUniverses(project.fixtures).join(", ") || "—"} mono />
          {project.notes.trim() && <InfoRow label={t("editor.file.notes")} value={project.notes} />}
        </dl>
        <DialogFooter>
          {origin.kind !== "none" && (
            <>
              <Button type="button" variant="ghost" className="mr-auto gap-1.5" onClick={file.copyPath}>
                <Copy aria-hidden />
                {t("editor.file.copyPath")}
              </Button>
              <Button type="button" variant="outline" className="gap-1.5" onClick={file.revealInFolder}>
                <FolderOpen aria-hidden />
                {t("editor.file.reveal")}
              </Button>
            </>
          )}
          <Button type="button" onClick={file.closeDialog}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
