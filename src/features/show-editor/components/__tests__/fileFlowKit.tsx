import { afterEach, beforeAll, beforeEach, vi, type Mock } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { produce } from "immer";

import i18n from "@/shared/i18n";
import * as pickerModule from "@/shared/tauri/pickers";
import { invoke as invokeFn } from "@/shared/tauri/invoke";
import { toast as toastApi } from "sonner";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { resetRecoveryCheck } from "../../hooks/useShowFile";
import { useDocumentStore } from "../../stores/useDocumentStore";
import { useRecentFilesStore } from "../../stores/useRecentFilesStore";
import { selectDirty, useProjectStore } from "../../stores/useProjectStore";
import { HINTS } from "../../onboarding/guideContent";
import { TOUR_VERSION, useOnboardingStore } from "../../stores/useOnboardingStore";
import { ShowEditorView } from "../ShowEditorView";

/**
 * 编辑器“文件”流程测试的公共部分（FileFlow*.test.tsx 共用）。
 *
 * 按主题拆成几个测试文件，好让测试并行跑（整个编辑器渲染很重，放在一个文件里会拖长整轮测试）。
 * 每个测试文件自己声明下面三个模块的 mock（`vi.mock` 只对声明它的文件生效），这里拿到的就是 mock：
 * `@/shared/tauri/invoke`、`sonner`、`@/shared/tauri/pickers`。
 */

/** 后端命令（mock）。 */
export const invoke = invokeFn as unknown as Mock;
/** 提示（mock）。 */
export const toast = toastApi as unknown as { success: Mock; error: Mock; loading: Mock; dismiss: Mock };
/** 文件选择（mock）。 */
export const pickers = pickerModule as unknown as { pickArtshowFile: Mock; pickArtshowSavePath: Mock; pickArtrecSavePath: Mock };

export const project = () => useProjectStore.getState().project;
export const dirty = () => selectDirty(useProjectStore.getState());
export const origin = () => useDocumentStore.getState().origin;
export const callsOf = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

/** 节目库里的两条记录：一个可编辑（只有工程），一个录制得到的。 */
export const LIBRARY = [
  { path: "D:/rec/开场.artrec", fileName: "开场.artrec", name: "开场", notes: "", bytes: 1, modifiedUnixMs: 1_700_000_000_000, durationUs: 0, frames: 0, universes: [], sources: [], recovered: false, valid: false, editable: true, exported: false },
  { path: "D:/rec/录制.artrec", fileName: "录制.artrec", name: "录制来的", notes: "", bytes: 1, modifiedUnixMs: 1_700_000_100_000, durationUs: 1, frames: 1, universes: [0], sources: [], recovered: false, valid: true, editable: false, exported: true },
];

export function sample(name = "演出"): ShowProject {
  return produce(createEmptyProject(name), (d) => void addFixtures(d, RGBW, 2));
}

/** 模拟后端：命令按名称分发，保存的工程按路径记在内存里。 */
export function installBackend(opts: { autosave?: string | null } = {}) {
  const store = new Map<string, string>([["D:/rec/开场.artrec", JSON.stringify(sample("开场"))]]);
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "recordings_list":
        return structuredClone(LIBRARY);
      case "show_project_save": {
        const a = args?.args as { path?: string; fileStem?: string; name: string; json: string };
        const path = a.path ?? `D:/rec/${a.fileStem ?? a.name}.artrec`;
        store.set(path, a.json);
        return path;
      }
      case "show_project_open": {
        const text = store.get(args?.path as string);
        if (!text) throw "not_found";
        return text;
      }
      case "show_external_save":
        store.set(args?.path as string, args?.json as string);
        return undefined;
      case "show_external_read": {
        const text = store.get(args?.path as string);
        if (!text) throw "not_found";
        return text;
      }
      case "show_autosave_read":
        return opts.autosave ?? null;
      case "show_reveal":
        return undefined;
      case "show_export_artrec":
        return { frames: 12, bytes: 4096 };
      case "show_file_info": {
        const path = args?.path as string;
        const exists = !path.includes("丢了");
        const library = args?.kind === "library";
        return {
          exists,
          projectPath: library ? `${path}.show` : path,
          bytes: exists ? 2048 : 0,
          modifiedUnixMs: exists ? 1_700_000_000_000 : null,
          artrecPath: library ? path : null,
          artrecBytes: null,
          artrecModifiedUnixMs: null,
        };
      }
      case "show_autosave_write":
      case "show_autosave_clear":
        return undefined;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return store;
}

/** 当前渲染用的查询客户端（`renderEditor` 每次新建）。 */
export let client: QueryClient;

export function renderEditor(url = "/editor") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(client, "invalidateQueries");
  return render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <ShowEditorView />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

export const toolbar = () => screen.getByRole("toolbar", { name: "编辑工具条" });
/** 打开工具条上的“文件”菜单（Radix 菜单在 jsdom 里用键盘打开最稳）。 */
export const openFileMenu = () => {
  const trigger = within(toolbar()).getByRole("button", { name: "文件" });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.keyDown(trigger, { key: "Enter" });
};
/** 打开文件菜单里的“最近打开”子菜单。 */
export async function openRecent() {
  openFileMenu();
  const sub = await screen.findByRole("menuitem", { name: "最近文件" });
  if (sub.getAttribute("aria-expanded") !== "true") fireEvent.keyDown(sub, { key: "ArrowRight" });
  await screen.findByRole("menu", { name: "最近文件" });
}
/** 文件菜单里的一项（名称后面带着快捷键，按前缀匹配）。 */
export const fileItem = (name: string) => screen.findByRole("menuitem", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });

export const makeDirty = () => act(() => useProjectStore.getState().update((d) => void addFixtures(d, RGBW, 1)));

/** 注册公共的前后置：每个用例从空工程、没有来源、最近文件为空开始。 */
export function setupFileFlow(): void {
  // 每个文件的第一个用例要冷启动整个编辑器，机器忙时放宽查找元素的等待
  configure({ asyncUtilTimeout: 5000 });
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  beforeEach(async () => {
    await i18n.changeLanguage("zh");
    // 这里测编辑器本身：引导视为已看过，局部提示全部关闭
    useOnboardingStore.setState({ tourVersion: TOUR_VERSION, dismissedHints: HINTS.map((h) => h.id) });
    invoke.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
    pickers.pickArtshowFile.mockReset();
    pickers.pickArtshowSavePath.mockReset();
    pickers.pickArtrecSavePath.mockReset();
    resetRecoveryCheck();
    useProjectStore.getState().load(createEmptyProject(""));
    useDocumentStore.getState().setOrigin({ kind: "none" });
    await act(async () => {
      await useRecentFilesStore.setState({ items: [] });
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
}
