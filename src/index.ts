import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { listSessionsTool, readSessionTool, sendSessionMessageTool } from './tools.ts'
import { createSessionTool } from './create-session.ts'

/** Cordis plugin name. */
export const name = 'dsh-cross-chat'
/** Required services: tool registry + live agent/session registries. */
export const inject = ['tools', 'agents', 'sessions']

/** Deployment configuration. */
export interface Config {
  /** 'prefix': 正文前加 `[跨会话消息 · 来自 <标签> (<id>)]`；'none': 不加。 */
  attribution: 'prefix' | 'none'
  /** 单条消息最大字符数，超长拒绝。 */
  maxMessageChars: number
  /** read_session 的 limit 参数上限。 */
  maxReadMessages: number
}

/** Schemastery configuration validated by the Loader. */
export const Config: z<Config> = z.object({
  attribution: z.union(['prefix', 'none']).default('prefix'),
  maxMessageChars: z.natural().default(4000),
  maxReadMessages: z.natural().default(50),
})

/**
 * Register the four cross-chat tools.
 * @param ctx - registrant context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(listSessionsTool(ctx))
  ctx.tools.register(sendSessionMessageTool(ctx, config))
  ctx.tools.register(readSessionTool(ctx, config))
  ctx.tools.register(createSessionTool(ctx, config))
}
