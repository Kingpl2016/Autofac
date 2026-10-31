import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Eraser, FileJson, FileSpreadsheet, Library, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { PageHeader } from "@/shared/components/PageHeader";
import { pickJsonFile, pickXlsxFile } from "@/shared/tauri/pickers";
import { blankModel, cloneAsCustom, nextCustomId } from "../lib/draft";
import { formatBytesIec } from "@/shared/lib/format";
import { collectAssetReferences } from "../lib/assetRefs";
import { assetErrorText, fixtureErrorText } from "../lib/errors";
import { useFixtureAssetStore } from "../stores/useFixtureAssetStore";
import { addToShowHref } from "../lib/format";
import type { FixtureModel, ImportOutcome } from "../lib/types";
import { useFixtureStore } from "../stores/useFixtureStore";
import { FixtureDetail } from "./FixtureDetail";
import { FixtureEditorDialog } from "./FixtureEditorDialog";
import { FixtureList } from "./FixtureList";
import { ImportResultDialog } from "./ImportResultDialog";

/** OFL 整库浏览对话框按需加载（含虚拟列表），不进素材库页面的首屏代码。 */
const OflCatalogDialog = lazy(() => import("./OflCatalogDialog").then((m) => ({ default: m.OflCatalogDialog })));

/** 正在编辑的内容：新建 / 复制（编号可改）或编辑现有自定义模型（编号锁定）。 */
interface EditingState {
  model: FixtureModel;
  lockId: boolean;
}

/**
 * 灯具素材库页面：左侧模型列表，右侧通道布局与属性；
 * 支持导入物模型 Excel、新建 / 编辑 / 复制 / 删除自定义模型。
 */
export function FixtureLibraryView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const models = useFixtureStore((s) => s.models);
  const status = useFixtureStore((s) => s.status);
  const error = useFixtureStore((s) => s.error);
  const load = useFixtureStore((s) => s.load);
  const importXlsx = useFixtureStore((s) => s.importXlsx);
  const importOfl = useFixtureStore((s) => s.importOfl);
  const save = useFixtureStore((s) => s.save);
  const remove = useFixtureStore((s) => s.remove);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const cleanupAssets = useFixtureAssetStore((s) => s.cleanup);

  const onCleanup = async () => {
    try {
      const out = await cleanupAssets(collectAssetReferences());
      if (out.removed === 0) toast.info(t("fixtures.assets.cleanupNone"));
      else toast.success(t("fixtures.assets.cleanupDone", { count: out.removed, size: formatBytesIec(out.bytes) }));
    } catch (e) {
      toast.error(assetErrorText(t, e));
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  // 选中项被删除或尚未选择时，回落到第一项
  const selected = models.find((m) => m.id === selectedId) ?? models[0] ?? null;

  const onImport = async (kind: "xlsx" | "ofl") => {
    const path =
      kind === "xlsx"
        ? await pickXlsxFile(t("fixtures.import.fileType"))
        : await pickJsonFile(t("fixtures.import.oflFileType"));
    if (!path) return;
    setImporting(true);
    try {
      const result = kind === "xlsx" ? await importXlsx(path) : await importOfl(path);
      setOutcome(result);
      const first = result.added[0] ?? result.updated[0];
      if (first) setSelectedId(first);
    } catch (e) {
      toast.error(t("fixtures.import.failed", { reason: fixtureErrorText(t, e) }));
    } finally {
      setImporting(false);
    }
  };

  const onSave = async (model: FixtureModel) => {
    const saved = await save(model);
    setSelectedId(saved.id);
    toast.success(t("fixtures.editor.saved", { name: saved.name }));
  };

  const onDelete = async () => {
    if (!selected) return;
    try {
      await remove(selected.id);
      setSelectedId(null);
      toast.success(t("fixtures.detail.deleted", { name: selected.name }));
    } catch (e) {
      toast.error(fixtureErrorText(t, e));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("nav.thingModel")}
        subtitle={t("fixtures.subtitle")}
        actions={
          <>
            <Button type="button" variant="outline" onClick={() => void onImport("xlsx")} disabled={importing}>
              {importing ? <Loader2 className="animate-spin" aria-hidden /> : <FileSpreadsheet aria-hidden />}
              {t("fixtures.import.button")}
            </Button>
            <Button type="button" variant="outline" onClick={() => void onImport("ofl")} disabled={importing}>
              <FileJson aria-hidden />
              {t("fixtures.import.oflButton")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setCatalogOpen(true)} disabled={importing}>
              <Library aria-hidden />
              {t("fixtures.catalog.button")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmCleanup(true)} disabled={importing} title={t("fixtures.assets.cleanupHint")}>
              <Eraser aria-hidden />
              {t("fixtures.assets.cleanup")}
            </Button>
            <Button
              type="button"
              onClick={() => setEditing({ model: blankModel(nextCustomId(models)), lockId: false })}
            >
              <Plus aria-hidden />
              {t("fixtures.editor.create")}
            </Button>
          </>
        }
      />

      {status === "error" ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <span className="text-destructive">{t("fixtures.loadFailed", { reason: fixtureErrorText(t, error) })}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            {t("fixtures.retry")}
          </Button>
        </div>
      ) : (
        <div className="grid items-start gap-(--density-gap) lg:grid-cols-[20rem_minmax(0,1fr)]">
          <FixtureList
            models={models}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
            query={query}
            onQueryChange={setQuery}
          />
          {selected ? (
            <FixtureDetail
              model={selected}
              onEdit={() => setEditing({ model: structuredClone(selected), lockId: true })}
              onClone={() =>
                setEditing({
                  model: cloneAsCustom(selected, nextCustomId(models), t("fixtures.detail.copySuffix")),
                  lockId: false,
                })
              }
              onDelete={() => setConfirmDelete(true)}
              onAddToShow={() => navigate(addToShowHref(selected.id))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {status === "loading" ? t("common.loading") : t("fixtures.detail.none")}
            </p>
          )}
        </div>
      )}

      <FixtureEditorDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        initial={editing?.model ?? blankModel("")}
        lockId={editing?.lockId ?? false}
        takenIds={models.map((m) => m.id)}
        onSave={onSave}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("fixtures.detail.deleteTitle", { name: selected?.name ?? "" })}
        description={t("fixtures.detail.deleteDescription")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={() => void onDelete()}
      />
      <ImportResultDialog outcome={outcome} onClose={() => setOutcome(null)} />
      <ConfirmDialog
        open={confirmCleanup}
        onOpenChange={setConfirmCleanup}
        title={t("fixtures.assets.cleanupTitle")}
        description={t("fixtures.assets.cleanupDescription")}
        confirmLabel={t("fixtures.assets.cleanup")}
        onConfirm={() => void onCleanup()}
      />
      {catalogOpen && (
        <Suspense fallback={null}>
          <OflCatalogDialog
            open={catalogOpen}
            onOpenChange={setCatalogOpen}
            onImported={(result) => {
              setOutcome(result);
              const first = result.added[0] ?? result.updated[0];
              if (first) setSelectedId(first);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
