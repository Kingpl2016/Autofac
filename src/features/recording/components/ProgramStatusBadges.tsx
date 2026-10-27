import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { ProgramHeaderTags } from "./ProgramHeaderTags";
import type { LibraryEntry } from "../lib/types";

interface ProgramStatusBadgesProps {
  entry: LibraryEntry;
  /** 连播时的下一个节目 */
  isNext?: boolean;
  /** 刚结束的录制产生的节目 */
  isFresh?: boolean;
}

/**
 * 节目状态徽章（文字 + 颜色，不只靠颜色区分）。只渲染徽章本身，外层布局由调用方决定。
 */
export function ProgramStatusBadges({ entry, isNext = false, isFresh = false }: ProgramStatusBadgesProps) {
  const { t } = useTranslation();
  return (
    <>
      {isNext && <Badge variant="outline">{t("recording.libNext")}</Badge>}
      {isFresh && <Badge>{t("recording.libNew")}</Badge>}
      {entry.editable && <Badge variant="outline">{t("recording.libEditable")}</Badge>}
      {entry.editable && !entry.exported && <Badge variant="warning">{t("recording.libNotExported")}</Badge>}
      {!entry.valid && entry.exported !== false && (
        <Badge variant="destructive">{t("recording.libInvalid")}</Badge>
      )}
      {entry.recovered && <Badge variant="warning">{t("recording.libRecovered")}</Badge>}
      {entry.valid && <ProgramHeaderTags header={entry.header} warningsOnly />}
    </>
  );
}
