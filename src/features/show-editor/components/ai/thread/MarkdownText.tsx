import "@assistant-ui/react-markdown/styles/dot.css";

import { memo, useState, type FC } from "react";
import { useTranslation } from "react-i18next";
import {
  MarkdownTextPrimitive,
  memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
  type CodeHeaderProps,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { TooltipIconButton } from "./TooltipIconButton";

/** 代码块标题：语言 + 复制按钮。 */
const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!code || copied) return;
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="mt-3 flex items-center justify-between rounded-t-lg border border-b-0 border-border bg-muted/50 px-3 py-1 text-xs">
      <span className="font-medium lowercase text-muted-foreground">{language}</span>
      <TooltipIconButton tooltip={t("editor.ai.copy")} onClick={copy}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </TooltipIconButton>
    </div>
  );
};

/** Markdown 各元素的样式（适配编辑器的紧凑字号）。 */
const components = memoizeMarkdownComponents({
  h1: ({ className, ...p }) => <h1 className={cn("mt-4 mb-2 text-base font-semibold first:mt-0", className)} {...p} />,
  h2: ({ className, ...p }) => <h2 className={cn("mt-4 mb-2 text-sm font-semibold first:mt-0", className)} {...p} />,
  h3: ({ className, ...p }) => <h3 className={cn("mt-3 mb-1.5 text-sm font-semibold first:mt-0", className)} {...p} />,
  p: ({ className, ...p }) => <p className={cn("my-2 leading-relaxed first:mt-0 last:mb-0", className)} {...p} />,
  a: ({ className, ...p }) => <a className={cn("text-primary underline underline-offset-2 hover:text-primary/80", className)} target="_blank" rel="noreferrer" {...p} />,
  ul: ({ className, ...p }) => <ul className={cn("my-2 ms-5 list-disc marker:text-muted-foreground [&>li]:mt-0.5", className)} {...p} />,
  ol: ({ className, ...p }) => <ol className={cn("my-2 ms-5 list-decimal marker:text-muted-foreground [&>li]:mt-0.5", className)} {...p} />,
  li: ({ className, ...p }) => <li className={cn("leading-relaxed", className)} {...p} />,
  blockquote: ({ className, ...p }) => <blockquote className={cn("my-2 border-s-2 border-muted-foreground/30 ps-3 text-muted-foreground", className)} {...p} />,
  hr: ({ className, ...p }) => <hr className={cn("my-3 border-muted-foreground/20", className)} {...p} />,
  strong: ({ className, ...p }) => <strong className={cn("font-semibold", className)} {...p} />,
  table: ({ className, ...p }) => (
    <div className="my-2 overflow-x-auto">
      <table className={cn("w-full border-separate border-spacing-0 text-xs", className)} {...p} />
    </div>
  ),
  th: ({ className, ...p }) => <th className={cn("bg-muted px-2 py-1 text-start font-medium", className)} {...p} />,
  td: ({ className, ...p }) => <td className={cn("border-b border-muted-foreground/20 px-2 py-1 text-start", className)} {...p} />,
  pre: ({ className, ...p }) => (
    <pre className={cn("overflow-x-auto rounded-b-lg border border-t-0 border-border bg-muted/30 p-3 text-xs leading-relaxed", className)} {...p} />
  ),
  code: function Code({ className, ...p }) {
    const block = useIsMarkdownCodeBlock();
    return <code className={cn(!block && "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]", className)} {...p} />;
  },
  CodeHeader,
});

/**
 * 助手消息里的 Markdown 文本（assistant-ui 的 `MarkdownText`）：流式输出时也能正确显示未闭合的结构，
 * 支持 GFM（表格、删除线、任务列表）。
 */
export const MarkdownText = memo(function MarkdownText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="aui-md text-sm" components={components} defer />;
});
