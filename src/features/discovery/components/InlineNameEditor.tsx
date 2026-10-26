import { useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface InlineNameEditorProps {
  /** 当前自定义名（没有则为空串）。 */
  initial: string;
  /** 输入为空时的占位提示（设备自己的名字）。 */
  placeholder: string;
  /** 提交：参数为去掉首尾空白后的名称，空串表示清除自定义名。 */
  onCommit: (name: string) => void;
  /** 取消编辑（Esc、点击取消、失去焦点）。 */
  onCancel: () => void;
}

/**
 * 表格行内改名：Enter 保存，Esc 取消，失去焦点视为取消。
 *
 * 保存 / 取消按钮在按下鼠标时阻止输入框失焦，否则“失焦即取消”会抢在按钮点击之前触发。
 * Esc 与点击不向外冒泡，避免连带关闭详情面板或切换选中行。
 */
export function InlineNameEditor({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: InlineNameEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  // 提交 / 取消只生效一次：提交后输入框被卸载时可能再触发一次失焦，不能当成“取消”
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(draft.trim());
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    } else {
      // 方向键、F2、C、F 等是表格的快捷键，输入时不应被它们截走
      e.stopPropagation();
    }
  };

  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <span className="flex min-w-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKey}
        onBlur={cancel}
        onFocus={(e) => e.currentTarget.select()}
        aria-label={t("discovery.customNamePlaceholder")}
        placeholder={placeholder || t("discovery.customNamePlaceholder")}
        className="h-8 min-w-0 flex-1"
      />
      <Button
        variant="ghost"
        size="icon"
        tabIndex={-1}
        className="size-7 shrink-0"
        aria-label={t("discovery.saveName")}
        title={t("discovery.saveName")}
        onMouseDown={keepFocus}
        onClick={commit}
      >
        <Check className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        tabIndex={-1}
        className="size-7 shrink-0"
        aria-label={t("discovery.cancelEdit")}
        title={t("discovery.cancelEdit")}
        onMouseDown={keepFocus}
        onClick={cancel}
      >
        <X className="size-3.5" />
      </Button>
    </span>
  );
}