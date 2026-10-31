import type { FixtureModel } from "./types";

/**
 * 资源引用的登记表：清理未引用资源时，除了灯具库（后端自己统计），还要保留其它地方仍在用的资源，
 * 例如打开的节目里模型快照引用的图标与 3D 模型。用到资源的功能在挂载时登记一个提供者，卸载时注销。
 */

type Provider = () => readonly string[];

const providers = new Set<Provider>();

/**
 * 登记一个引用提供者。
 *
 * @param provider 返回仍在使用的资源散列。
 * @returns 注销函数。
 */
export function registerAssetReferences(provider: Provider): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

/**
 * 全部提供者给出的资源散列（去重）。
 *
 * @returns 散列。
 */
export function collectAssetReferences(): string[] {
  const out = new Set<string>();
  for (const p of providers) for (const h of p()) out.add(h);
  return [...out];
}

/**
 * 一组模型引用的资源散列。
 *
 * @param models 模型。
 * @returns 散列。
 */
export function modelAssetHashes(models: readonly FixtureModel[]): string[] {
  return models.flatMap((m) => {
    const out = [m.appearance?.icon?.hash, m.appearance?.model3d?.hash].filter((h): h is string => !!h);
    // 图案槽位引用的图案图片（内置图案 `builtin:` 不是资源）
    for (const p of m.properties) for (const c of p.capabilities ?? []) if (c.pattern && !c.pattern.startsWith("builtin:")) out.push(c.pattern);
    return out;
  });
}
