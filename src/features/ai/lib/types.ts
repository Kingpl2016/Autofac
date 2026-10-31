/**
 * AI 模块与后端（`ai-gateway`）对应的类型，均由 Rust DTO 生成（见 `src/bindings`）。
 */
export type { Profile as AiProfile } from "@/bindings/Profile";
export type { ProfileInput as AiProfileInput } from "@/bindings/ProfileInput";
export type { ProfileView as AiProfileView } from "@/bindings/ProfileView";
export type { ProviderKind as AiProviderKind } from "@/bindings/ProviderKind";
export type { Modality as AiModality } from "@/bindings/Modality";
export type { ModelInfo as AiModelInfo } from "@/bindings/ModelInfo";
export type { ModelListInput as AiModelListInput } from "@/bindings/ModelListInput";
export type { ProxyEvent } from "@/bindings/ProxyEvent";
export type { ProxyRequest } from "@/bindings/ProxyRequest";
