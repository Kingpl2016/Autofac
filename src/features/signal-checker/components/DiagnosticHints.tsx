import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";

import { useCheckerContext } from "../hooks/useCheckerContext";
import { draftToConfig } from "../lib/draft";
import { diagnosticHints, type Hint } from "../lib/guard";
import { useCheckerFormStore } from "../stores/useCheckerFormStore";

/**
 * 自测提示：当目标是本机时，说明"为什么可能收不到 / 信号会连带发到哪里"。
 *
 * 只是说明，不阻止发送。依据的是当前**草稿**里的目标，所以改了 IP 马上就能看到对应的提示。
 */
export function DiagnosticHints() {
  const { t } = useTranslation();
  const draft = useCheckerFormStore((s) => s.draft);
  const { data: context } = useCheckerContext();
  const config = draftToConfig(draft);
  const hints = config ? diagnosticHints(config, context) : [];
  if (hints.length === 0) return null;

  return (
    <ul aria-label={t("signalChecker.hintsLabel")} className="grid gap-2">
      {hints.map((hint) => (
        <li
          key={hint.kind}
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{describeHint(hint, t)}</span>
        </li>
      ))}
    </ul>
  );
}

/** 把一条提示说成一句话。 */
function describeHint(hint: Hint, t: TFunction): string {
  switch (hint.kind) {
    case "playerMode":
      return t("signalChecker.hintPlayerMode");
    case "receiverBinding":
      return hint.ip
        ? t("signalChecker.hintReceiverBinding", { ip: hint.ip })
        : t("signalChecker.hintReceiverBindingMulti");
    case "forwarding":
      return t("signalChecker.hintForwarding", { count: hint.count });
  }
}
