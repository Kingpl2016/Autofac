import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  CircleAlert,
  Download,
  Loader2,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Update } from "@/shared/tauri/updater";
import { formatBytes, formatPublishDate } from "../lib/format";
import type { UpdateState } from "../lib/updateMachine";

interface UpdateSectionProps {
  /** 更新流程当前状态 */
  state: UpdateState;
  /** 检查更新 */
  onCheck: () => void;
  /** 下载并安装已发现的更新 */
  onInstall: (update: Update) => void;
}

type Tone = "success" | "primary" | "danger" | "muted";

/** 状态图标的文字色；类名必须是完整字面量，Tailwind 才能扫描到。 */
const TONE_CLASS: Record<Tone, string> = {
  success: "text-success",
  primary: "text-primary",
  danger: "text-destructive",
  muted: "text-muted-foreground",
};

interface StatusLine {
  icon?: LucideIcon;
  tone: Tone;
  spin?: boolean;
  title: string;
  hint?: string;
}

/**
 * 软件更新区（居中）：一行状态 + 一个按钮，需要时才在下方展开更新说明或下载进度。
 *
 * 状态行是 `role="status"` 的 live region，检查结果与进度变化会被读屏播报；
 * 状态用「图标 + 文字」表达，颜色只是辅助。
 */
export function UpdateSection({ state, onCheck, onInstall }: UpdateSectionProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.startsWith("zh") ? "zh-CN" : "en";

  const line = describe(state, t, locale);
  const Icon = line.icon;
  const action = renderAction(state, onCheck, onInstall, t);

  return (
    <div className="flex flex-col items-center gap-4 px-6 py-6 text-center">
      <div role="status" aria-live="polite" className="max-w-full">
        <p className="flex items-center justify-center gap-2 text-sm font-medium break-words">
          {Icon && (
            <Icon
              className={cn("size-4 shrink-0", TONE_CLASS[line.tone], line.spin && "animate-spin")}
              aria-hidden
            />
          )}
          {line.title}
        </p>
        {line.hint && (
          <p className="mt-1 text-xs text-muted-foreground break-words">{line.hint}</p>
        )}
      </div>

      {state.kind === "downloading" && (
        <DownloadProgress downloaded={state.downloaded} total={state.total} />
      )}
      {action}
      {state.kind === "available" && <ReleaseNotes body={state.update.body} />}
    </div>
  );
}

/** 把状态映射为状态行的图标、配色与文案；空闲时不显示图标，保持安静。 */
function describe(state: UpdateState, t: TFunction, locale: string): StatusLine {
  switch (state.kind) {
    case "idle":
      return { tone: "muted", title: t("about.updateTitle"), hint: t("about.updateIdle") };
    case "checking":
      return { icon: Loader2, tone: "muted", spin: true, title: t("about.checking") };
    case "upToDate":
      return { icon: CheckCircle2, tone: "success", title: t("about.upToDate") };
    case "available": {
      const published = formatPublishDate(state.update.date, locale);
      return {
        icon: Download,
        tone: "primary",
        title: t("about.available", { version: state.update.version }),
        hint: [
          t("about.availableHint", { current: state.update.currentVersion }),
          published && t("about.publishedAt", { date: published }),
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }
    case "downloading":
      return { icon: Download, tone: "primary", title: t("about.downloading") };
    case "installing":
      return { icon: Loader2, tone: "primary", spin: true, title: t("about.installing") };
    case "installed":
      return {
        icon: CheckCircle2,
        tone: "success",
        title: t("about.installed"),
        hint: t("about.installedHint"),
      };
    case "error":
      return { icon: CircleAlert, tone: "danger", title: t("about.failed"), hint: state.message };
  }
}

/** 主操作按钮：按状态切换为「检查 / 安装 / 重试 / 进行中」，安装完成后不再显示。 */
function renderAction(
  state: UpdateState,
  onCheck: () => void,
  onInstall: (update: Update) => void,
  t: TFunction,
) {
  switch (state.kind) {
    case "idle":
    case "upToDate":
      return (
        <Button variant={state.kind === "idle" ? "default" : "outline"} size="sm" onClick={onCheck}>
          <RefreshCw />
          {t("about.checkUpdate")}
        </Button>
      );
    case "available":
      return (
        <Button size="sm" onClick={() => onInstall(state.update)}>
          <Download />
          {t("about.install")}
        </Button>
      );
    case "error": {
      const update = state.update;
      return (
        <Button variant="outline" size="sm" onClick={() => (update ? onInstall(update) : onCheck())}>
          <RefreshCw />
          {t("about.retry")}
        </Button>
      );
    }
    case "checking":
    case "downloading":
    case "installing":
      return (
        <Button size="sm" disabled>
          <Loader2 className="animate-spin" />
          {state.kind === "checking" ? t("about.checking") : t("about.downloading")}
        </Button>
      );
    case "installed":
      return null;
  }
}

/** 更新说明：默认折叠的原生 `<details>`，纯文本展示（不解析 HTML / Markdown）。 */
function ReleaseNotes({ body }: { body: string | undefined }) {
  const { t } = useTranslation();
  const text = body?.trim();
  return (
    <details className="group w-full text-left">
      <summary className="flex cursor-pointer list-none items-center justify-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden>
          ›
        </span>
        {t("about.releaseNotes")}
      </summary>
      <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
        {text ? text : <span className="text-muted-foreground">{t("about.noNotes")}</span>}
      </div>
    </details>
  );
}

/**
 * 下载进度条。服务器给出体积时是确定进度（用 `scaleX` 做动画，不触发布局），
 * 否则退化为不确定的滑动条；两种情况下面都有文字说明已下载量。
 */
function DownloadProgress({ downloaded, total }: { downloaded: number; total: number | null }) {
  const { t } = useTranslation();
  const percent = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  return (
    <div className="w-full space-y-1.5">
      <div
        role="progressbar"
        aria-label={t("about.downloading")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-1 overflow-hidden rounded-full bg-primary/15"
      >
        {percent === null ? (
          <span className="animate-indeterminate block h-full w-1/3 rounded-full bg-primary" />
        ) : (
          <span
            className="block h-full w-full origin-left rounded-full bg-primary transition-transform duration-200 motion-reduce:transition-none"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        )}
      </div>
      <p className="tabular text-xs text-muted-foreground">
        {total
          ? t("about.downloadProgress", { done: formatBytes(downloaded), total: formatBytes(total) })
          : t("about.downloadedOnly", { done: formatBytes(downloaded) })}
      </p>
    </div>
  );
}

type TFunction = ReturnType<typeof useTranslation>["t"];
