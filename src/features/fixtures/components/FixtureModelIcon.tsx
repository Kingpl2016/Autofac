import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { modelType } from "../lib/profile";
import { modelShape } from "../lib/shape";
import type { FixtureModel } from "../lib/types";
import { assetUrl, useFixtureAssetStore } from "../stores/useFixtureAssetStore";
import { FixtureTypeIcon } from "./FixtureTypeIcon";

interface FixtureModelIconProps {
  model: FixtureModel;
  className?: string;
  /** 以 `role="img"` 读出外形名（默认 `true`） */
  labelled?: boolean;
}

/**
 * 灯具模型的图标：模型有自己的 2D 图标且文件在资源库里时显示图标文件，
 * 否则按外形模板（没有外观时按通道推断）显示内置图标。
 */
export function FixtureModelIcon({ model, className, labelled = true }: FixtureModelIconProps) {
  const { t } = useTranslation();
  const icon = model.appearance?.icon;
  const asset = useFixtureAssetStore((s) => (icon ? s.byHash.get(icon.hash) : undefined));
  const ensure = useFixtureAssetStore((s) => s.ensure);
  useEffect(() => {
    if (icon) void ensure();
  }, [icon, ensure]);
  const shape = modelShape(model);
  if (!asset) return <FixtureTypeIcon type={modelType(model)} shape={shape} className={className} labelled={labelled} />;
  const label = t(`fixtures.shape.${shape}`);
  return (
    <img
      src={assetUrl(asset.path)}
      alt={labelled ? label : ""}
      title={labelled ? label : undefined}
      aria-hidden={labelled ? undefined : true}
      draggable={false}
      decoding="async"
      className={cn("size-3.5 shrink-0 object-contain", className)}
    />
  );
}
