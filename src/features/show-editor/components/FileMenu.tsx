import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, FilePlus2, FolderOpen, FolderSearch, Library, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ShowFileController } from "../hooks/useShowFile";

interface FileMenuProps {
  file: ShowFileController;
}

/** 菜单里的一项。 */
function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none [&_svg]:size-4 [&_svg]:shrink-0"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * 工具条上的文件操作：保存（Ctrl+S）和“文件”菜单（新建、打开、另存为新节目、导出副本）。
 */
export function FileMenu({ file }: FileMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  /** 菜单项被点击后先收起菜单，再执行动作（动作可能弹出对话框）。 */
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2"
        aria-keyshortcuts="Control+S"
        title={t("editor.file.saveHint")}
        onClick={file.save}
      >
        <Save aria-hidden />
        {t("common.save")}
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-8 px-2">
            {t("editor.file.menu")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="grid w-64 gap-0.5 p-1.5" aria-label={t("editor.file.menu")}>
          <MenuItem icon={<FilePlus2 aria-hidden />} label={t("editor.file.new")} onClick={run(file.requestNew)} />
          <MenuItem icon={<Library aria-hidden />} label={t("editor.file.openLibrary")} onClick={run(file.requestOpenLibrary)} />
          <MenuItem icon={<FolderSearch aria-hidden />} label={t("editor.file.openFile")} onClick={run(file.requestOpenFile)} />
          <div className="my-1 h-px bg-border" role="separator" />
          <MenuItem icon={<FolderOpen aria-hidden />} label={t("editor.file.saveAsNew")} onClick={run(() => file.openSaveDialog(true))} />
          <MenuItem icon={<FileDown aria-hidden />} label={t("editor.file.exportCopy")} onClick={run(file.saveAsFile)} />
        </PopoverContent>
      </Popover>
    </>
  );
}
