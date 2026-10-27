import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { RECORDINGS_QUERY_KEY } from "@/features/recording";
import { pickArtshowFile, pickArtshowSavePath } from "@/shared/tauri/pickers";
import { showSetDirty } from "../lib/playbackApi";
import { showAutosaveClear, showAutosaveRead, showAutosaveWrite, showErrorText, serializeProject } from "../lib/showFile";
import { selectDirty, useProjectStore } from "../stores/useProjectStore";
import {
  newProject,
  openFromFile,
  openFromLibrary,
  restoreFromAutosave,
  saveInPlace,
  saveToFile,
  saveToLibrary,
  type SaveLibraryOptions,
} from "./showFileActions";

/** 自动存档的间隔（毫秒）。 */
export const AUTOSAVE_INTERVAL_MS = 30_000;

/** 当前打开的对话框。 */
export type FileDialog = "save" | "open" | "unsaved" | "recover" | null;

/** 工程文件操作的状态与动作（工具条和各对话框共用）。 */
export interface ShowFileController {
  /** 有未保存的修改 */
  dirty: boolean;
  /** 当前打开的对话框 */
  dialog: FileDialog;
  /** “保存到节目库”对话框是否强制另存为新节目 */
  saveAsNew: boolean;
  /** Ctrl+S：保存到工程已有的位置；没保存过时弹出“保存到节目库”对话框 */
  save: () => void;
  /**
   * 弹出“保存到节目库”对话框。
   *
   * @param asNew 为 `true` 时即使工程已在库里也另存为新节目。
   */
  openSaveDialog: (asNew: boolean) => void;
  /** 选择位置，把工程导出为库外的 `.artshow` 文件。 */
  saveAsFile: () => void;
  /** 新建工程（有未保存修改时先确认）。 */
  requestNew: () => void;
  /** 从节目库选择并打开工程（有未保存修改时先确认）。 */
  requestOpenLibrary: () => void;
  /** 选择并打开库外的 `.artshow` 文件（有未保存修改时先确认）。 */
  requestOpenFile: () => void;
  /**
   * 直接打开节目库里的某个工程（从节目库页跳转而来；有未保存修改时先确认）。
   *
   * @param path 节目的 `.artrec` 路径。
   */
  requestOpenPath: (path: string) => void;
  /**
   * 提交“保存到节目库”对话框。
   *
   * @param options 名称、备注。
   */
  submitSave: (options: Pick<SaveLibraryOptions, "name" | "notes">) => Promise<void>;
  /**
   * 在“打开”对话框里选中一个节目。
   *
   * @param path 节目的 `.artrec` 路径。
   */
  chooseLibraryEntry: (path: string) => void;
  /**
   * 回答“有未保存的修改”确认。
   *
   * @param choice `save` 先保存再继续，`discard` 放弃修改继续，`cancel` 取消。
   */
  answerUnsaved: (choice: "save" | "discard" | "cancel") => void;
  /**
   * 回答“恢复上次未保存的工程”确认。
   *
   * @param restore `true` 恢复，`false` 放弃并删除存档。
   */
  answerRecover: (restore: boolean) => void;
  /** 关闭当前对话框（取消）。 */
  closeDialog: () => void;
}

/** 本次应用运行期间是否已经检查过自动存档（编辑器页面反复进出不重复询问）。 */
let recoveryChecked = false;

/**
 * 重置“已检查自动存档”标记（仅测试使用）。
 */
export function resetRecoveryCheck(): void {
  recoveryChecked = false;
}

/**
 * 工程文件操作：保存、另存为、打开、新建、自动存档与崩溃恢复。
 *
 * 会丢失未保存修改的操作（新建、打开）统一经过确认；所有失败都以 toast 报告，
 * 保存成功后刷新节目库列表。
 *
 * @returns 状态与动作。
 */
export function useShowFile(): ShowFileController {
  const { t } = useTranslation();
  const client = useQueryClient();
  const dirty = useProjectStore(selectDirty);
  const [dialog, setDialog] = useState<FileDialog>(null);
  const [saveAsNew, setSaveAsNew] = useState(false);
  const [recoverText, setRecoverText] = useState<string | null>(null);
  /** 用户确认后要继续执行的动作（新建 / 打开 / 保存后继续）。 */
  const pending = useRef<(() => Promise<void> | void) | null>(null);

  const report = useCallback((error: unknown) => toast.error(showErrorText(t, error)), [t]);
  const refreshLibrary = useCallback(
    () => void client.invalidateQueries({ queryKey: RECORDINGS_QUERY_KEY }),
    [client],
  );

  /** 执行一个动作，错误以 toast 报告。 */
  const attempt = useCallback(
    async (action: () => Promise<void> | void) => {
      try {
        await action();
      } catch (e) {
        report(e);
      }
    },
    [report],
  );

  /** 动作会丢弃当前工程时，先问用户。 */
  const guard = useCallback(
    (action: () => Promise<void> | void) => {
      if (selectDirty(useProjectStore.getState())) {
        pending.current = action;
        setDialog("unsaved");
      } else {
        void attempt(action);
      }
    },
    [attempt],
  );

  const openSaveDialog = useCallback((asNew: boolean) => {
    setSaveAsNew(asNew);
    setDialog("save");
  }, []);

  const save = useCallback(() => {
    void attempt(async () => {
      const result = await saveInPlace();
      if (result === "needs-name") openSaveDialog(false);
      else {
        refreshLibrary();
        toast.success(t("editor.file.saved"));
      }
    });
  }, [attempt, openSaveDialog, refreshLibrary, t]);

  const submitSave = useCallback(
    async (options: Pick<SaveLibraryOptions, "name" | "notes">) => {
      try {
        await saveToLibrary({ ...options, asNew: saveAsNew });
      } catch (e) {
        report(e);
        return;
      }
      refreshLibrary();
      toast.success(t("editor.file.savedToLibrary", { name: options.name.trim() }));
      setDialog(null);
      const next = pending.current;
      pending.current = null;
      if (next) await attempt(next);
    },
    [attempt, refreshLibrary, report, saveAsNew, t],
  );

  const saveAsFile = useCallback(() => {
    void attempt(async () => {
      const { project } = useProjectStore.getState();
      const path = await pickArtshowSavePath(project.name || t("editor.untitled"), t("editor.file.fileType"));
      if (!path) return;
      await saveToFile(path);
      toast.success(t("editor.file.savedToFile", { path }));
    });
  }, [attempt, t]);

  const requestNew = useCallback(() => guard(() => newProject()), [guard]);
  const requestOpenLibrary = useCallback(() => guard(() => setDialog("open")), [guard]);
  const requestOpenFile = useCallback(
    () =>
      guard(async () => {
        const path = await pickArtshowFile(t("editor.file.fileType"));
        if (path) await openFromFile(path);
      }),
    [guard, t],
  );
  const requestOpenPath = useCallback(
    (path: string) => guard(() => openFromLibrary(path)),
    [guard],
  );

  const chooseLibraryEntry = useCallback(
    (path: string) => {
      setDialog(null);
      void attempt(() => openFromLibrary(path));
    },
    [attempt],
  );

  const answerUnsaved = useCallback(
    (choice: "save" | "discard" | "cancel") => {
      if (choice === "cancel") {
        pending.current = null;
        setDialog(null);
        return;
      }
      if (choice === "discard") {
        const next = pending.current;
        pending.current = null;
        setDialog(null);
        if (next) void attempt(next);
        return;
      }
      // 先保存再继续：没保存过的工程要先让用户起名，保存成功后由 submitSave 继续
      setDialog(null);
      void attempt(async () => {
        const result = await saveInPlace();
        if (result === "needs-name") {
          openSaveDialog(false);
          return;
        }
        refreshLibrary();
        const next = pending.current;
        pending.current = null;
        if (next) await next();
      });
    },
    [attempt, openSaveDialog, refreshLibrary],
  );

  const answerRecover = useCallback(
    (restore: boolean) => {
      setDialog(null);
      const text = recoverText;
      setRecoverText(null);
      if (restore && text) {
        try {
          restoreFromAutosave(text);
          toast.success(t("editor.file.recovered"));
        } catch (e) {
          report(e);
          void showAutosaveClear().catch(() => undefined);
        }
      } else {
        void showAutosaveClear().catch(() => undefined);
      }
    },
    [recoverText, report, t],
  );

  const closeDialog = useCallback(() => {
    pending.current = null;
    setDialog(null);
  }, []);

  // 首次进入编辑器：如果上次异常退出留下了自动存档，询问是否恢复
  useEffect(() => {
    if (recoveryChecked) return;
    recoveryChecked = true;
    void showAutosaveRead()
      .then((text) => {
        if (text && !selectDirty(useProjectStore.getState())) {
          setRecoverText(text);
          setDialog("recover");
        }
      })
      .catch(() => undefined);
  }, []);

  // 把“有未保存修改”同步给后端：关闭窗口时的退出守卫据此确认；离开编辑器后复位
  useEffect(() => {
    void showSetDirty(dirty).catch(() => undefined);
  }, [dirty]);
  useEffect(
    () => () => {
      void showSetDirty(false).catch(() => undefined);
    },
    [],
  );

  // 有未保存修改时，每 30 秒写一次自动存档
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setInterval(() => {
      const { project, baseline } = useProjectStore.getState();
      if (project === baseline) return;
      void showAutosaveWrite(serializeProject(project)).catch(() => undefined);
    }, AUTOSAVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [dirty]);

  return {
    dirty,
    dialog,
    saveAsNew,
    save,
    openSaveDialog,
    saveAsFile,
    requestNew,
    requestOpenLibrary,
    requestOpenFile,
    requestOpenPath,
    submitSave,
    chooseLibraryEntry,
    answerUnsaved,
    answerRecover,
    closeDialog,
  };
}
