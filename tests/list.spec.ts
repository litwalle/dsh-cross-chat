import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { listSessionsTool } from '../src/tools.ts'

function agent(id: string, msgs: Message[], opts: { cwd?: string; status?: 'idle' | 'running' } = {}): Agent {
  return {
    id: SessionId(id),
    status: opts.status ?? 'idle',
    session: {
      id: SessionId(id),
      header: { cwd: opts.cwd ?? '/work' },
      deriveMessages: () => msgs,
    } as unknown as Session,
  } as unknown as Agent
}

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role, content: [{ type: 'text', text }], source: { kind: 'user' } } as Message
}

function ctxWith(selfId: string, others: Agent[]) {
  return {
    agents: {
      list: () => [agent(selfId, [textMsg('user', '我自己')]), ...others],
      get: () => undefined,
    },
  } as unknown as Context
}

describe('list_sessions', () => {
  it('lists other live sessions with label, cwd and busy', async () => {
    const others = [
      agent('session-b', [textMsg('user', 'B 的最近消息')], { cwd: '/proj/b', status: 'running' }),
      agent('session-c', [], { cwd: '/proj/c' }),
    ]
    const tool = listSessionsTool(ctxWith('session-a', others))
    const value = await tool.execute({}, { agent: agent('session-a', []) } as never)
    expect(value).toEqual({
      sessions: [
        { session_id: 'session-b', label: 'B 的最近消息', cwd: '/proj/b', busy: true },
        { session_id: 'session-c', label: 'session-c', cwd: '/proj/c', busy: false },
      ],
    })
  })

  it('filters by id or label, case-insensitively', async () => {
    const others = [
      agent('session-b', [textMsg('user', 'Alpha 项目')]),
      agent('session-c', [textMsg('user', 'Beta 项目')]),
    ]
    const tool = listSessionsTool(ctxWith('session-a', others))
    const value = await tool.execute({ filter: 'ALPHA' }, { agent: agent('session-a', []) } as never)
    expect(value).toEqual({
      sessions: [{ session_id: 'session-b', label: 'Alpha 项目', cwd: '/work', busy: false }],
    })
  })

  it('rejects when there is no calling agent', async () => {
    const tool = listSessionsTool(ctxWith('session-a', []))
    await expect(tool.execute({}, {} as never)).rejects.toThrow(/需要调用方 agent/)
  })

  it('renders an empty list as guidance text', () => {
    const tool = listSessionsTool(ctxWith('session-a', []))
    const rendered = tool.output.render({}, { sessions: [] })
    expect(rendered[0]).toMatchObject({ type: 'text' })
    expect((rendered[0] as { text: string }).text).toContain('没有其他会话')
  })
})
