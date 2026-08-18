/**
 * The three cross-chat model tools.
 *
 * @module dsh-cross-chat/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { RpcId, type ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type ImageBlock, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { Config } from './index.ts'
import { buildRelayMessage, firstTextBlock, isCrossRelay, sessionLabel } from './relay.ts'
import {
  MAX_FILES_PER_MESSAGE,
  MAX_IMAGES_PER_MESSAGE,
  acceptsImage,
  deliverFiles,
  mediaTypeForPath,
  readImageRequest,
  resolveImageLimits,
} from './attach.ts'

const LIST_TOOL_NAME = 'list_sessions'

/** 发送方会话标题缓存（sessionId → title，上限 200）。 */
const TITLE_CACHE = new Map<string, string>()
const TITLE_CACHE_MAX = 200

/**
 * Build the `list_sessions` tool: enumerate live sessions the caller may
 * message, each with an id the send tool accepts.
 */
export function listSessionsTool(ctx: Context) {
  return defineTool({
    name: LIST_TOOL_NAME,
    description:
      '列出当前可发消息的其他会话（除你所在的会话外）。返回每个会话的 session_id、'
      + '标签（最近一条消息的前 60 字符）、工作目录与是否正在运行；用返回的 '
      + 'session_id 配合 send_session_message 发消息。可选 filter 按 id 或标签模糊过滤。',
    parameters: {
      filter: {
        type: 'string',
        description: '可选：按 session_id 或标签不区分大小写模糊过滤。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                session_id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                cwd: { type: 'string', required: true },
                busy: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.sessions.length === 0) {
          return [{ type: 'text', text: '没有其他会话（可能还没有第二个对话，或全部被 filter 过滤）。' }]
        }
        const lines = value.sessions.map((s) =>
          `- ${s.label} — 会话 ${s.session_id}（cwd: ${s.cwd}，${s.busy ? '运行中' : '空闲'}）`)
        return [{ type: 'text', text: `可发消息的会话（${value.sessions.length} 个）：\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const self = exec.agent
      if (!self) throw new Error('list_sessions 需要调用方 agent（exec.agent 未定义）')
      const needle = args.filter?.trim().toLowerCase() ?? ''
      const candidates = ctx.agents.list()
        .filter((a) => a.id !== self.id)
        .map((a) => ({
          session_id: a.id,
          label: sessionLabel(a.session),
          cwd: a.session.header.cwd ?? '',
          busy: a.status === 'running',
        }))
        .filter((c) =>
          needle === ''
          || c.session_id.toLowerCase().includes(needle)
          || c.label.toLowerCase().includes(needle))
      return { sessions: candidates }
    },
  })
}

const SEND_TOOL_NAME = 'send_session_message'

/** How `image_paths` reach the target session. */
type ImageDelivery = 'none' | 'blocks' | 'files'

/**
 * Decide how `image_paths` should reach the target: native image content
 * blocks only when the target model declares image input; every other case
 * (text-only model, unknown capability, llm service unavailable) falls back
 * to workspace-file delivery so a text-only target can still see the picture
 * through vision tools instead of failing its next model call with
 * UNSUPPORTED_CONTENT (the DeepSeek chat-completions adapter is text-only).
 */
async function resolveImageDelivery(ctx: Context, target: Agent): Promise<ImageDelivery> {
  const provider = target.options?.provider
  const model = target.options?.model
  const llm = ctx.get?.('llm') as LlmRuntime | undefined
  if (llm === undefined || provider === undefined || provider === '' || model === undefined || model === '') return 'files'
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return acceptsImage(info.inputModalities) ? 'blocks' : 'files'
  } catch {
    return 'files'
  }
}

/**
 * Build the `send_session_message` tool: deliver one message to another live
 * session and wake its agent (`Agent.followup`). Failures are explicit tool
 * errors, never silent.
 */
export function sendSessionMessageTool(ctx: Context, config: Config) {
  return defineTool({
    name: SEND_TOOL_NAME,
    description:
      '给另一个会话发消息：消息会成为目标会话 agent 的下一轮输入并叫醒它'
      + '（目标正在运行时消息排队，等其当前轮结束）。目标须是 list_sessions '
      + '列出的活会话。本调用不返回对方的回复；想看结果用 read_session。',
    parameters: {
      session_id: {
        type: 'string',
        required: true,
        description: '目标会话 id（来自 list_sessions）。',
      },
      message: {
        type: 'string',
        required: true,
        description: `要发送的消息正文，不超过 ${config.maxMessageChars} 字符。`,
      },
      image_paths: {
        type: 'array',
        items: { type: 'string' },
        description: `可选：要随消息发送的图片路径（png/jpeg/webp/gif，最多 ${MAX_IMAGES_PER_MESSAGE} 张），相对发送方工作目录或绝对路径。目标模型支持图片时以图片内容投递；目标模型为纯文本时自动作为文件投递到对方工作区并附路径说明。`,
      },
      file_paths: {
        type: 'array',
        items: { type: 'string' },
        description: `可选：要投递到目标会话工作区的文件路径（最多 ${MAX_FILES_PER_MESSAGE} 个），消息会附带路径说明。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          session_id: { type: 'string', required: true },
          queued: { type: 'boolean', required: true },
          image_delivery: { type: 'string', required: true, enum: ['none', 'blocks', 'files'] },
        },
      },
      render: (_args, value) => {
        const imageNote = value.image_delivery === 'files'
          ? ' 图片已作为文件投递到对方工作区（目标模型不支持图片输入），对方可用视觉工具查看。'
          : value.image_delivery === 'blocks'
            ? ' 图片已以图片内容投递，对方可直接查看。'
            : ''
        return [{
          type: 'text',
          text: (value.queued
            ? `已把消息投递给会话 ${value.session_id}（对方正在运行，消息已排队，将在其当前轮结束后成为下一轮输入）。本次调用不返回对方的回复；想看结果用 read_session。`
            : `已把消息投递给会话 ${value.session_id}，对方将被叫醒开始新的一轮回复。本次调用不返回对方的回复；想看结果用 read_session。`) + imageNote,
        }]
      },
    },
    async execute(args, exec) {
      const self = exec.agent
      if (!self) throw new Error('send_session_message 需要调用方 agent（exec.agent 未定义）')
      const target = ctx.agents.get(SessionId(args.session_id))
      if (!target) {
        throw new Error(`SESSION_NOT_FOUND: 会话 ${args.session_id} 当前不在线。用 list_sessions 查看当前可发消息的会话。`)
      }
      if (target.id === self.id) {
        throw new Error('SELF_SEND_REJECTED: 不能给自己所在的会话发消息。')
      }
      if (args.message.length > config.maxMessageChars) {
        throw new Error(`MESSAGE_TOO_LONG: 消息共 ${args.message.length} 字符，超过上限 ${config.maxMessageChars}。`)
      }
      const queued = target.status === 'running'
      const senderTitle = await resolveSenderTitle(ctx, self.id)

      const images = args.image_paths ?? []
      if (images.length > MAX_IMAGES_PER_MESSAGE) {
        throw new Error(`IMAGE_TOO_MANY: 图片最多 ${MAX_IMAGES_PER_MESSAGE} 张。`)
      }
      const imageDelivery: ImageDelivery = images.length === 0 ? 'none' : await resolveImageDelivery(ctx, target)
      const imageBlocks: ImageBlock[] = []
      if (images.length > 0 && imageDelivery === 'blocks') {
        const api = ctx.get?.('attachments') as { saveImage: (input: SaveImageAttachment) => Promise<ImageAttachmentRef> } | undefined
        if (!api) throw new Error('ATTACHMENT_UNAVAILABLE: 当前 DSH 未启用附件服务，无法发送图片')
        const limits = await resolveImageLimits(ctx)
        for (const p of images) {
          const request = await readImageRequest(p, limits)
          imageBlocks.push({ type: 'image', attachment: await api.saveImage(request) })
        }
      }

      let text = args.message
      const files = args.file_paths ?? []
      if (files.length > MAX_FILES_PER_MESSAGE) {
        throw new Error(`FILE_TOO_MANY: 文件最多 ${MAX_FILES_PER_MESSAGE} 个。`)
      }
      if (files.length > 0) {
        const targetCwd = target.session.header.cwd
        if (targetCwd === undefined) throw new Error('FILE_TARGET_NO_CWD: 目标会话没有工作目录，无法投递文件')
        const lines = await deliverFiles(targetCwd, files, '文件', 'FILE')
        if (lines.length > 0) text = `${text}\n\n${lines.join('\n')}`
      }
      if (images.length > 0 && imageDelivery === 'files') {
        const targetCwd = target.session.header.cwd
        if (targetCwd === undefined) throw new Error('IMAGE_TARGET_NO_CWD: 目标会话没有工作目录，无法以文件方式投递图片')
        for (const p of images) {
          if (mediaTypeForPath(p) === null) throw new Error('IMAGE_INVALID: 仅支持 png/jpeg/webp/gif')
        }
        const lines = await deliverFiles(targetCwd, images, '图片', 'IMAGE')
        if (lines.length > 0) {
          text = `${text}\n\n${lines.join('\n')}\n（图片未作为图片内容投递：目标模型不支持图片输入，请用视觉工具或直接读取文件查看）`
        }
      }

      const msg = buildRelayMessage(self, text, config.attribution, senderTitle)
      if (imageBlocks.length > 0) {
        target.followup(createUserMessage({ content: [...msg.content, ...imageBlocks], source: msg.source }))
      } else {
        target.followup(msg)
      }
      return { delivered: true, session_id: target.id, queued, image_delivery: imageDelivery }
    },
  })
}

/**
 * Resolve the sender session's title through the API gateway, cached by
 * session id. Failures (absent apiProxy, rpc error, missing/blank title) are
 * never cached and fall back to the label.
 */
async function resolveSenderTitle(ctx: Context, senderId: string): Promise<string | undefined> {
  const cached = TITLE_CACHE.get(senderId)
  if (cached !== undefined) return cached
  try {
    const api = ctx.get?.('apiProxy') as ApiProxy | undefined
    if (!api) return undefined
    const res = await api.sessions.list({ rpcId: RpcId(randomUUID()), payload: {} })
    if (!res.result.ok) return undefined
    const item = res.result.value.items.find((it) => it.sessionId === senderId)
    const title = (item?.projections?.values as { title?: string | null } | undefined)?.title
    if (title === undefined || title === null || title.trim() === '') return undefined
    if (TITLE_CACHE.size >= TITLE_CACHE_MAX) TITLE_CACHE.clear()
    TITLE_CACHE.set(senderId, title.trim())
    return title.trim()
  } catch {
    return undefined
  }
}

const READ_TOOL_NAME = 'read_session'
/** 单条消息渲染时的展示截断长度。 */
const READ_ENTRY_RENDER_MAX = 2000

/** One presentable transcript entry. */
interface ReadEntry {
  role: 'user' | 'assistant'
  /** Relay 消息的发送方 session id，否则 null。 */
  from: string | null
  text: string
}

/** Collect the most recent readable entries from a session log. */
function pickRecentEntries(session: Session, limit: number): { entries: ReadEntry[]; omitted: number } {
  const collected: ReadEntry[] = []
  for (const message of [...session.deriveMessages()].reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.role === 'user' && message.content.every((block) => block.type === 'tool-result')) continue
    const text = firstTextBlock(message)
    if (text === null) continue
    collected.unshift({
      role: message.role,
      from: message.role === 'user' && isCrossRelay(message.source) ? message.source.senderSessionId : null,
      text,
    })
  }
  const omitted = Math.max(0, collected.length - limit)
  return { entries: collected.slice(Math.max(0, collected.length - limit)), omitted }
}

/**
 * Build the `read_session` tool: read the most recent user/assistant messages
 * of another live session (folded surface, so compacted history stays hidden).
 */
export function readSessionTool(ctx: Context, config: Config) {
  return defineTool({
    name: READ_TOOL_NAME,
    description:
      '读取另一个会话最近的消息（默认 20 条，最多 '
      + `${config.maxReadMessages} 条），用于查看对方对你消息的回复。`
      + '返回角色标记的文本；跨会话消息会标注发送方 session id。',
    parameters: {
      session_id: {
        type: 'string',
        required: true,
        description: '目标会话 id（来自 list_sessions）。',
      },
      limit: {
        type: 'integer',
        description: `要读的最近消息条数，默认 20，上限 ${config.maxReadMessages}。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', required: true, enum: ['user', 'assistant'] },
                from: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          omitted: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        if (value.entries.length === 0) {
          return [{ type: 'text', text: `会话 ${value.session_id} 没有可读的 user/assistant 消息。` }]
        }
        const lines = value.entries.map((e) => {
          const shown = e.text.length > READ_ENTRY_RENDER_MAX ? e.text.slice(0, READ_ENTRY_RENDER_MAX - 1) + '…' : e.text
          const who = e.from !== null ? `来自 ${e.from}` : e.role
          return `[${who}] ${shown}`
        })
        const tail = value.omitted > 0 ? `\n（更早的 ${value.omitted} 条省略）` : ''
        return [{ type: 'text', text: `会话 ${value.session_id} 最近 ${value.entries.length} 条消息：\n${lines.join('\n')}${tail}` }]
      },
    },
    async execute(args, exec) {
      const target = ctx.agents.get(SessionId(args.session_id))
      if (!target) {
        throw new Error(`SESSION_NOT_FOUND: 会话 ${args.session_id} 当前不在线。用 list_sessions 查看当前可发消息的会话。`)
      }
      const limit = Math.min(Math.max(1, args.limit ?? 20), config.maxReadMessages)
      const picked = pickRecentEntries(target.session, limit)
      return { session_id: target.id, entries: picked.entries, omitted: picked.omitted }
    },
  })
}
