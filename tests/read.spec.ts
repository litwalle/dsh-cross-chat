import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/index.ts'
import { readSessionTool } from '../src/tools.ts'

function msg(role: 'user' | 'assistant', text: string, source: Message['source'] = { kind: 'user' }): Message {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role, content: [{ type: 'text', text }], source } as Message
}

const toolResult: Message = {
  id: 'm-tool',
  role: 'user',
  content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '工具输出' }] }],
  source: { kind: 'tool', callId: 'c1' } as Message['source'],
} as Message

const relay: Message = msg('user', '来自 A 的问候', {
  kind: 'dsh-cross-relay', plugin: 'dsh-cross-chat', form: 'relay', senderSessionId: 'session-a', senderLabel: 'A',
} as Message['source'])

function targetWith(msgs: Message[]): Agent {
  return {
    id: SessionId('session-b'),
    status: 'idle',
    session: {
      id: SessionId('session-b'),
      header: { cwd: '/work' },
      deriveMessages: () => msgs,
    } as unknown as Session,
  } as unknown as Agent
}

function cfg(over: Partial<Config> = {}): Config {
  return { attribution: 'prefix', maxMessageChars: 4000, maxReadMessages: 50, ...over }
}

describe('read_session', () => {
  it('reads the most recent user/assistant messages, newest last', async () => {
    const ctx = {
      agents: { get: () => targetWith([msg('user', '一'), msg('assistant', '二'), msg('user', '三'), msg('assistant', '四')]), list: () => [] },
    } as unknown as Context
    const tool = readSessionTool(ctx, cfg())
    const value = await tool.execute({ session_id: 'session-b', limit: 2 }, {} as never)
    expect(value).toEqual({
      session_id: 'session-b',
      entries: [
        { role: 'user', from: null, text: '三' },
        { role: 'assistant', from: null, text: '四' },
      ],
      omitted: 2,
    })
  })

  it('skips tool-result user messages', async () => {
    const ctx = {
      agents: { get: () => targetWith([toolResult, msg('assistant', '回答')]), list: () => [] },
    } as unknown as Context
    const tool = readSessionTool(ctx, cfg())
    const value = await tool.execute({ session_id: 'session-b' }, {} as never)
    expect(value).toEqual({ session_id: 'session-b', entries: [{ role: 'assistant', from: null, text: '回答' }], omitted: 0 })
  })

  it('annotates relay messages with their sender', async () => {
    const ctx = {
      agents: { get: () => targetWith([relay, msg('assistant', '收到')]), list: () => [] },
    } as unknown as Context
    const tool = readSessionTool(ctx, cfg())
    const value = await tool.execute({ session_id: 'session-b' }, {} as never)
    expect(value).toEqual({
      session_id: 'session-b',
      entries: [
        { role: 'user', from: 'session-a', text: '来自 A 的问候' },
        { role: 'assistant', from: null, text: '收到' },
      ],
      omitted: 0,
    })
  })

  it('clamps limit into [1, maxReadMessages]', async () => {
    const msgs = Array.from({ length: 6 }, (_, i) => msg('user', `第${i}条`))
    const ctx = { agents: { get: () => targetWith(msgs), list: () => [] } } as unknown as Context
    const tool = readSessionTool(ctx, cfg({ maxReadMessages: 3 }))
    const value = await tool.execute({ session_id: 'session-b', limit: 100 }, {} as never)
    expect(value).toMatchObject({ entries: [{ text: '第3条' }, { text: '第4条' }, { text: '第5条' }], omitted: 3 })
  })

  it('fails with SESSION_NOT_FOUND for an unknown target', async () => {
    const ctx = { agents: { get: () => undefined, list: () => [] } } as unknown as Context
    const tool = readSessionTool(ctx, cfg())
    await expect(tool.execute({ session_id: 'session-ghost' }, {} as never)).rejects.toThrow(/SESSION_NOT_FOUND/)
  })
})
