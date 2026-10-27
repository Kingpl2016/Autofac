import { create } from "zustand";

/** 当前工程的来源：决定“保存”写到哪里。 */
export type DocumentOrigin =
  | { kind: "none" }
  | { kind: "library"; path: string }
  | { kind: "external"; path: string };

interface DocumentState {
  origin: DocumentOrigin;
  /**
   * 设置工程来源。
   *
   * @param origin 新的来源。
   */
  setOrigin: (origin: DocumentOrigin) => void;
}

/**
 * 当前工程“存在哪里”：未保存过、节目库里的某个节目，或库外的 `.artshow` 文件。
 * 不进撤销历史，也不随工程保存。
 */
export const useDocumentStore = create<DocumentState>((set) => ({
  origin: { kind: "none" },
  setOrigin: (origin) => set({ origin }),
}));
