/**
 * 文件类命令的 id、标题与默认快捷键：命令表（`useEditorCommands`）注册它们，文件菜单按同一份数据显示快捷键，
 * 用户在快捷键设置里改了键，两边一起变。
 */

/** 文件类命令。 */
export const FILE_COMMANDS = {
  "file.new": { titleKey: "editor.commands.fileNew", keys: ["mod+n"] },
  "file.openLibrary": { titleKey: "editor.commands.fileOpenLibrary", keys: ["mod+o"] },
  "file.openFile": { titleKey: "editor.commands.fileOpenFile", keys: ["mod+shift+o"] },
  "file.save": { titleKey: "editor.commands.save", keys: ["mod+s"] },
  "file.saveAsNew": { titleKey: "editor.commands.fileSaveAsNew", keys: ["mod+shift+s"] },
  "file.import": { titleKey: "editor.commands.fileImport", keys: ["mod+i"] },
  "file.exportArtrec": { titleKey: "editor.commands.fileExportArtrec", keys: ["mod+shift+e"] },
  "file.reload": { titleKey: "editor.commands.fileReload", keys: [] },
  "file.reveal": { titleKey: "editor.commands.fileReveal", keys: [] },
  "file.info": { titleKey: "editor.commands.fileInfo", keys: [] },
} as const satisfies Record<string, { titleKey: string; keys: readonly string[] }>;

/** 文件类命令的 id。 */
export type FileCommandId = keyof typeof FILE_COMMANDS;

/** 命令表执行文件命令时调用的动作（来自 `useShowFile`）。 */
export interface FileCommandHandlers {
  save: () => void;
  requestNew: () => void;
  requestOpenLibrary: () => void;
  requestOpenFile: () => void;
  openSaveDialog: (asNew: boolean) => void;
  requestImport: () => void;
  exportArtrec: () => void;
  requestReload: () => void;
  revealInFolder: () => void;
  openInfo: () => void;
}
