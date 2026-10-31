import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { pickImageFile } from "@/shared/tauri/pickers";
import { assetErrorText } from "../../lib/errors";
import { inferShape } from "../../lib/shape";
import type { Appearance, AssetRef, FixtureModel } from "../../lib/types";
import { IMAGE_ASSET_EXTENSIONS, type AssetView } from "../../lib/assetsApi";
import { useFixtureAssetStore } from "../../stores/useFixtureAssetStore";
import { FixtureModelIcon } from "../FixtureModelIcon";
import { AssetChooser } from "./AssetChooser";

interface AppearanceAssetsProps {
  draft: FixtureModel;
  onChange: (changes: Partial<FixtureModel>) => void;
}

/** 资源 → 模型里的引用。 */
const refOf = (a: AssetView): AssetRef => ({ hash: a.hash, format: a.format, name: a.name });

/**
 * 外观里的资源：2D 图标（导入文件或从资源库选）与 3D 模型（从资源库选；导入见 3D 舞台）。
 * 资源文件存在 `data/fixture-assets`，模型里只记散列。
 */
export function AppearanceAssets({ draft, onChange }: AppearanceAssetsProps) {
  const { t } = useTranslation();
  const byHash = useFixtureAssetStore((s) => s.byHash);
  const ensure = useFixtureAssetStore((s) => s.ensure);
  const importIcon = useFixtureAssetStore((s) => s.importIcon);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void ensure();
  }, [ensure]);

  const assets = [...byHash.values()];
  const icons = assets.filter((a) => a.kind === "icon");
  const models = assets.filter((a) => a.kind === "model");
  const base: Appearance = draft.appearance ?? { shape: inferShape(draft), origin: "user" };
  const patch = (changes: Partial<Appearance>) => {
    const next = { ...base, ...changes };
    if (!next.icon) delete next.icon;
    if (!next.model3d) delete next.model3d;
    onChange({ appearance: next });
  };

  const onImport = async () => {
    const path = await pickImageFile(t("fixtures.assets.iconFileType"), IMAGE_ASSET_EXTENSIONS);
    if (!path) return;
    setBusy(true);
    try {
      patch({ icon: refOf(await importIcon(path)) });
    } catch (e) {
      toast.error(t("fixtures.assets.importFailed", { reason: assetErrorText(t, e) }));
    } finally {
      setBusy(false);
    }
  };

  const missing = (r: AssetRef | undefined) => r !== undefined && !byHash.has(r.hash);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="grid content-start gap-2">
        <span className="text-sm font-medium">{t("fixtures.assets.icon")}</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-10 items-center justify-center rounded-md border border-border bg-surface-1 text-primary">
            <FixtureModelIcon model={draft} className="size-6" />
          </span>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void onImport()}>
            <ImagePlus aria-hidden />
            {t("fixtures.assets.importIcon")}
          </Button>
          <AssetChooser label={t("fixtures.assets.chooseIcon")} assets={icons} current={base.icon?.hash} onPick={(a) => patch({ icon: refOf(a) })} />
          {base.icon && (
            <Button type="button" size="sm" variant="ghost" onClick={() => patch({ icon: undefined })}>
              <X aria-hidden />
              {t("fixtures.assets.removeIcon")}
            </Button>
          )}
        </div>
        {missing(base.icon) && <p className="text-xs text-warning">{t("fixtures.assets.missing")}</p>}
        <p className="text-xs text-muted-foreground">{t("fixtures.assets.iconHint")}</p>
      </div>
      <div className="grid content-start gap-2">
        <span className="text-sm font-medium">{t("fixtures.assets.model3d")}</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-sm text-muted-foreground">
            {base.model3d ? base.model3d.name || base.model3d.hash.slice(0, 12) : t("fixtures.assets.noModel")}
          </span>
          <AssetChooser
            label={t("fixtures.assets.chooseModel")}
            assets={models}
            current={base.model3d?.hash}
            onPick={(a) => patch({ model3d: refOf(a) })}
          />
          {base.model3d && (
            <Button type="button" size="sm" variant="ghost" onClick={() => patch({ model3d: undefined })}>
              <X aria-hidden />
              {t("fixtures.assets.removeModel")}
            </Button>
          )}
        </div>
        {missing(base.model3d) && <p className="text-xs text-warning">{t("fixtures.assets.missing")}</p>}
        <p className="text-xs text-muted-foreground">{t("fixtures.assets.modelHint")}</p>
      </div>
    </div>
  );
}

