import { describe, expect, it } from 'vitest'
import type { Message, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { buildRelayMessage, firstTextBlock, isCrossRelay, sessionLabel } from '../src/relay.ts'

function textMsg(role: 'user' | 'assistant', text: string, source: MessageSource = { kind: 'user' }): Message {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role, content: [{ type: 'text', text }], source } as Message
}

function sessionWith(msgs: Message[], id = 'session-src'): Session {
  return {
    id: SessionId(id),
    deriveMessages: () => msgs,
  } as unknown as Session
}

function agentWith(msgs: Message[], id = 'session-src'): Agent {
  return { id: SessionId(id), session: sessionWith(msgs, id) } as unknown as Agent
}

describe('sessionLabel', () => {
  it('takes the last user/assistant text, collapsing whitespace', () => {
    const s = sessionWith([
      textMsg('user', '第一句话'),
      textMsg('assistant', '第二句\n  带换行  和多余空格'),
    ])
    expect(sessionLabel(s)).toBe('第二句 带换行 和多余空格')
  })

  it('truncates to 60 chars with an ellipsis', () => {
    const s = sessionWith([textMsg('user', 'x'.repeat(80))])
    expect(sessionLabel(s)).toBe('x'.repeat(59) + '…')
  })

  it('falls back to the session id when there is no text', () => {
    expect(sessionLabel(sessionWith([]))).toBe('session-src')
  })

  it('skips messages without text blocks', () => {
    const s = sessionWith([
      { id: 'm-tool', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }], source: { kind: 'user' } } as Message,
      textMsg('assistant', '有文字的回复'),
    ])
    expect(sessionLabel(s)).toBe('有文字的回复')
  })
})

describe('firstTextBlock', () => {
  it('returns the first text block text or null', () => {
    expect(firstTextBlock(textMsg('user', 'hello'))).toBe('hello')
    expect(firstTextBlock({ id: 'm', role: 'user', content: [], source: { kind: 'user' } } as unknown as Message)).toBeNull()
  })
})

describe('isCrossRelay', () => {
  it('recognizes the relay source kind', () => {
    const relay = { kind: 'dsh-cross-relay', plugin: 'dsh-cross-chat', form: 'relay', senderSessionId: 's1', senderLabel: 'L' } as MessageSource
    expect(isCrossRelay(relay)).toBe(true)
    expect(isCrossRelay({ kind: 'user' })).toBe(false)
  })
})

describe('buildRelayMessage', () => {
  it('builds an identified user message with the relay source and prefix attribution', () => {
    const sender = agentWith([textMsg('user', '我的开场白')], 'session-a')
    const msg = buildRelayMessage(sender, '你好', 'prefix')
    expect(msg.role).toBe('user')
    expect(typeof msg.id).toBe('string')
    expect(msg.source).toEqual({
      kind: 'dsh-cross-relay',
      plugin: 'dsh-cross-chat',
      form: 'relay',
      senderSessionId: 'session-a',
      senderLabel: '我的开场白',
    })
    expect(msg.content).toEqual([
      { type: 'text', text: '[跨会话消息 · 来自 我的开场白 (session-a)]\n\n你好' },
    ])
  })

  it('omits the prefix when attribution is none', () => {
    const sender = agentWith([], 'session-a')
    const msg = buildRelayMessage(sender, '你好', 'none')
    expect(msg.content).toEqual([{ type: 'text', text: '你好' }])
  })

  it('uses the resolved session title over the label when provided', () => {
    const sender = agentWith([textMsg('user', '我的开场白')], 'session-a')
    const msg = buildRelayMessage(sender, '你好', 'prefix', '跨对话通信会话就绪')
    expect(msg.content).toEqual([
      { type: 'text', text: '[跨会话消息 · 来自 跨对话通信会话就绪 (session-a)]\n\n你好' },
    ])
    expect(msg.source).toMatchObject({
      kind: 'dsh-cross-relay',
      senderLabel: '我的开场白',
      senderTitle: '跨对话通信会话就绪',
    })
  })

  it('falls back to the label when the title is blank', () => {
    const sender = agentWith([textMsg('user', '我的开场白')], 'session-a')
    const msg = buildRelayMessage(sender, '你好', 'prefix', '   ')
    expect(msg.content).toEqual([
      { type: 'text', text: '[跨会话消息 · 来自 我的开场白 (session-a)]\n\n你好' },
    ])
    expect(msg.source).not.toHaveProperty('senderTitle')
  })
})
