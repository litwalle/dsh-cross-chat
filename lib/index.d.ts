import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "dsh-cross-chat";
/** Required services: tool registry + live agent/session registries. */
declare const inject: string[];
/** Deployment configuration. */
interface Config {
  /** 'prefix': 正文前加 `[跨会话消息 · 来自 <标签> (<id>)]`；'none': 不加。 */
  attribution: 'prefix' | 'none';
  /** 单条消息最大字符数，超长拒绝。 */
  maxMessageChars: number;
  /** read_session 的 limit 参数上限。 */
  maxReadMessages: number;
}
/** Schemastery configuration validated by the Loader. */
declare const Config: z<Config>;
/**
 * Register the four cross-chat tools.
 * @param ctx - registrant context.
 * @param config - validated deployment configuration.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };