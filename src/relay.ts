/**
 * Cross-chat relay core: the message source kind that triggers the GUI's
 * built-in relay card rendering, plus pure helpers for sender labels and
 * message construction.
 *
 * @module dsh-cross-chat/relay
 */

import { createUserMessage, type Message, type MessageSource, type MessageSourceMap, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** This plugin's loader id. */
export const PLUGIN_ID = 'dsh-cross-chat'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-cross-relay': {
      kind: 'dsh-cross-relay'
      plugin: typeof PLUGIN_ID
      form: 'relay'
      senderSessionId: string
      senderLabel: string
      senderTitle?: string
    }
  }
}

/** The durable source record carried by every delivered cross-chat message. */
export type CrossRelaySource = MessageSourceMap['dsh-cross-relay']

/** Narrow a message source to the cross-chat relay kind. */
export function isCrossRelay(source: MessageSource): source is CrossRelaySource {
  return source.kind === 'dsh-cross-relay'
}

/** The first text block of a message, or null. */
export function firstTextBlock(message: Message): string | null {
  for (const block of message.content) {
    if (block.type === 'text') return block.text
  }
  return null
}

/**
 * A human/model-facing label for a session: the last user/assistant text
 * message, whitespace-collapsed and truncated; falls back to the session id.
 */
export function sessionLabel(session: Session, maxChars = 60): string {
  for (const message of [...session.deriveMessages()].reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = firstTextBlock(message)
    if (text === null || text.trim() === '') continue
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > maxChars ? flat.slice(0, maxChars - 1) + '…' : flat
  }
  return session.id
}

/**
 * Build the identified user message delivered to the target session.
 * `attribution: 'prefix'` prepends one attribution line so the receiving
 * MODEL knows who sent it (the GUI card is for humans only). `senderTitle`
 * is the resolved session title and wins over the label when non-blank.
 */
export function buildRelayMessage(sender: Agent, text: string, attribution: 'prefix' | 'none', senderTitle?: string): UserMessage {
  const title = senderTitle !== undefined && senderTitle.trim() !== '' ? senderTitle.trim() : undefined
  const label = title ?? sessionLabel(sender.session)
  const body = attribution === 'prefix'
    ? `[跨会话消息 · 来自 ${label} (${sender.id})]\n\n${text}`
    : text
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source: {
      kind: 'dsh-cross-relay',
      plugin: PLUGIN_ID,
      form: 'relay',
      senderSessionId: sender.id,
      senderLabel: sessionLabel(sender.session),
      ...(title === undefined ? {} : { senderTitle: title }),
    },
  })
}
