import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";

import {
  fixtureAssetCleanup,
  fixtureAssetImportFile,
  fixtureAssetList,
  fixtureAssetPut,
  fixtureAssetsAuthorize,
  fixtureAssetPutThumb,
  type AssetCleanupOutcome,
  type AssetPutMeta,
  type AssetView,
} from "../lib/assetsApi";

/** 资源库的前端状态。 */
interface FixtureAssetState {
  /** 散列 → 资源 */
  byHash: ReadonlyMap<string, AssetView>;
  status: "idle" | "loading" | "ready" | "error";
  /** 第一次用到时放行目录并读取列表（之后直接返回）。 */
  ensure: () => Promise<void>;
  /** 重新读取列表。 */
  reload: () => Promise<void>;
  /** 从文件导入一个图标。 */
  importIcon: (path: string) => Promise<AssetView>;
  /** 从文件导入一张图案（gobo）图片。 */
  importGobo: (path: string) => Promise<AssetView>;
  /** 存入前端生成的资源（GLB 等）。 */
  put: (bytes: Uint8Array, meta: AssetPutMeta) => Promise<AssetView>;
  /** 保存 3D 模型的缩略图。 */
  putThumb: (hash: string, bytes: Uint8Array) => Promise<AssetView>;
  /** 清理未引用的资源（进回收站）。 */
  cleanup: (referenced: readonly string[]) => Promise<AssetCleanupOutcome>;
}

let pending: Promise<void> | null = null;

const withAsset = (map: ReadonlyMap<string, AssetView>, a: AssetView) => new Map(map).set(a.hash, a);

/**
 * 灯具资源库（2D 图标、3D 模型、图案图片、场馆模型）：后端是唯一数据源，列表只存元数据，文件经 asset 协议按需加载。
 */
export const useFixtureAssetStore = create<FixtureAssetState>((set, get) => ({
  byHash: new Map(),
  status: "idle",

  ensure: () => {
    if (get().status === "ready") return Promise.resolve();
    pending ??= (async () => {
      set({ status: "loading" });
      try {
        await fixtureAssetsAuthorize();
        const list = await fixtureAssetList();
        set({ byHash: new Map(list.map((a) => [a.hash, a])), status: "ready" });
      } catch {
        set({ status: "error" });
      } finally {
        pending = null;
      }
    })();
    return pending;
  },

  reload: async () => {
    const list = await fixtureAssetList();
    set({ byHash: new Map(list.map((a) => [a.hash, a])) });
  },

  importIcon: async (path) => {
    await get().ensure();
    const a = await fixtureAssetImportFile(path);
    set((s) => ({ byHash: withAsset(s.byHash, a) }));
    return a;
  },

  importGobo: async (path) => {
    await get().ensure();
    const a = await fixtureAssetImportFile(path, "gobo");
    set((s) => ({ byHash: withAsset(s.byHash, a) }));
    return a;
  },

  put: async (bytes, meta) => {
    await get().ensure();
    const a = await fixtureAssetPut(bytes, meta);
    set((s) => ({ byHash: withAsset(s.byHash, a) }));
    return a;
  },

  putThumb: async (hash, bytes) => {
    const a = await fixtureAssetPutThumb(hash, bytes);
    set((s) => ({ byHash: withAsset(s.byHash, a) }));
    return a;
  },

  cleanup: async (referenced) => {
    const out = await fixtureAssetCleanup(referenced);
    await get().reload();
    return out;
  },
}));

/**
 * 资源文件的 webview 地址（asset 协议）。
 *
 * @param path 文件的绝对路径。
 * @returns 可交给 `<img>` / 加载器的地址。
 */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}
