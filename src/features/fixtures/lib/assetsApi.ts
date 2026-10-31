import { invoke, invokeBinary } from "@/shared/tauri/invoke";

import type { AssetCleanupOutcome } from "@/bindings/AssetCleanupOutcome";
import type { AssetKind } from "@/bindings/AssetKind";
import type { AssetView } from "@/bindings/AssetView";
import type { ModelStats } from "@/bindings/ModelStats";
import type { AssetFormat } from "./types";

export type { AssetCleanupOutcome, AssetKind, AssetView, ModelStats };

/** 允许导入的 2D 图片（图标、图案）扩展名。 */
export const IMAGE_ASSET_EXTENSIONS = ["svg", "png", "webp"] as const;

/** 存入资源时的元数据。 */
export interface AssetPutMeta {
  format: AssetFormat;
  /** 种类（省略时按格式：图片为图标、GLB 为灯具模型） */
  kind?: AssetKind;
  name?: string;
  stats?: ModelStats;
}

/** 列出资源库（`data/fixture-assets`）。 */
export function fixtureAssetList(): Promise<AssetView[]> {
  return invoke<AssetView[]>("fixture_asset_list");
}

/**
 * 从文件导入一张 2D 图片（SVG / PNG / WebP）作为图标或图案；同样的内容只存一份。
 *
 * @param path 用户选择的图片文件。
 * @param kind `icon`（默认）或 `gobo`。
 */
export function fixtureAssetImportFile(path: string, kind: "icon" | "gobo" = "icon"): Promise<AssetView> {
  return invoke<AssetView>("fixture_asset_import_file", { path, kind });
}

/**
 * 存入一个资源（前端规整好的 GLB 等），经原始二进制 IPC 传给后端。
 *
 * @param bytes 文件内容。
 * @param meta 格式、种类、原始文件名与 3D 模型信息。
 */
export function fixtureAssetPut(bytes: Uint8Array, meta: AssetPutMeta): Promise<AssetView> {
  const headers: Record<string, string> = { "x-asset-format": meta.format };
  if (meta.kind) headers["x-asset-kind"] = meta.kind;
  if (meta.name) headers["x-asset-name"] = encodeURIComponent(meta.name);
  if (meta.stats) headers["x-asset-stats"] = encodeURIComponent(JSON.stringify(meta.stats));
  return invokeBinary<AssetView>("fixture_asset_put", bytes, headers);
}

/**
 * 保存 3D 模型的缩略图（WebP）。
 *
 * @param hash 模型散列。
 * @param bytes WebP 内容。
 */
export function fixtureAssetPutThumb(hash: string, bytes: Uint8Array): Promise<AssetView> {
  return invokeBinary<AssetView>("fixture_asset_put_thumb", bytes, { "x-asset-hash": hash });
}

/**
 * 放行 asset 协议对一个 3D 源文件（GLB / glTF / OBJ，glTF 连同所在目录）的访问，供前端读取并规整。
 *
 * @param path 用户选择的文件。
 */
export function fixtureAssetSourceAuthorize(path: string): Promise<void> {
  return invoke<void>("fixture_asset_source_authorize", { path });
}

/** 放行 asset 协议对资源库目录的访问（之后才能用 `convertFileSrc` 加载）。 */
export function fixtureAssetsAuthorize(): Promise<void> {
  return invoke<void>("fixture_assets_authorize");
}

/**
 * 把灯具库与打开的工程都没有引用的资源挪进回收站。
 *
 * @param referenced 打开的工程里灯具模型快照引用的散列（灯具库里的由后端自己统计）。
 */
export function fixtureAssetCleanup(referenced: readonly string[]): Promise<AssetCleanupOutcome> {
  return invoke<AssetCleanupOutcome>("fixture_asset_cleanup", { referenced });
}
