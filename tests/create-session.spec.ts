import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { ApiProxy, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy'
import type { Config } from '../src/index.ts'
import { createSessionTool } from '../src/create-session.ts'

function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: 'rpc-fixture' as never, result: { ok: true, value } }
}
function fail<T>(code: string, message: string): RpcResponse<T> {
  return { rpcId: 'rpc-fixture' as never, result: { ok: false, error: { code, message, details: {} } as never } }
}

interface Calls {
  createPayloads: Array<{ cwd?: string; workspaceId?: string }>
  promptPayloads: Array<{ sessionId: string; mode: string; text: string }>
  renamePayloads: Array<{ sessionId: string; title: string }>
  rpcIds: string[]
  createResult: RpcResponse<{ sessionId: string }>
  promptResult: RpcResponse<{ accepted: true }>
  renameResult: RpcResponse<{ title: string; seq: number }>
  workspaceListResult: RpcResponse<{ items: Array<{ workspaceId: string; path: string }>; archivedSessionIds: string[] }>
}

function makeCalls(): Calls {
  return {
    createPayloads: [],
    promptPayloads: [],
    renamePayloads: [],
    rpcIds: [],
    createResult: ok({ sessionId: 'session-new' }),
    promptResult: ok({ accepted: true }),
    renameResult: ok({ title: '新标题', seq: 1 }),
    workspaceListResult: ok({
      items: [{ workspaceId: 'ws-a', path: '/proj/a' }],
      archivedSessionIds: [],
    }),
  }
}

function ctxWith(calls: Calls, api: unknown): Context {
  return {
    get: (name: string) => (name === 'apiProxy' ? api : undefined),
  } as unknown as Context
}

function sender(cwd?: string): Agent {
  return {
    id: SessionId('session-a'),
    status: 'idle',
    session: {
      id: SessionId('session-a'),
      header: { cwd },
      deriveMessages: () => [],
    } as unknown as Session,
  } as unknown as Agent
}

function cfg(over: Partial<Config> = {}): Config {
  return { attribution: 'prefix', maxMessageChars: 4000, maxReadMessages: 50, ...over }
}

function makeApi(calls: Calls) {
  const api = {
    workspace: {
      list: async (request: { rpcId: string; payload: {} }) => {
        calls.rpcIds.push(request.rpcId)
        return calls.workspaceListResult
      },
    },
    sessions: {
      create: async (request: { rpcId: string; payload: { cwd?: string; workspaceId?: string } }) => {
        calls.rpcIds.push(request.rpcId)
        calls.createPayloads.push({ ...request.payload })
        return calls.createResult
      },
      prompt: async (request: { rpcId: string; payload: { sessionId: string; mode: string; content: Array<{ type: 'text'; text: string }> } }) => {
        calls.rpcIds.push(request.rpcId)
        calls.promptPayloads.push({ sessionId: request.payload.sessionId, mode: request.payload.mode, text: request.payload.content[0]!.text })
        return calls.promptResult
      },
      rename: async (request: { rpcId: string; payload: { sessionId: string; title: string } }) => {
        calls.rpcIds.push(request.rpcId)
        calls.renamePayloads.push({ ...request.payload })
        return calls.renameResult
      },
    },
  } as unknown as ApiProxy
  return api
}

describe('create_session', () => {
  it('creates with the owning workspace id, sends first message, renames', async () => {
    const calls = makeCalls()
    const api = makeApi(calls)
    const tool = createSessionTool(ctxWith(calls, api), cfg())
    const value = await tool.execute(
      { first_message: '帮我做 X', title: '任务 X' },
      { agent: sender('/proj/a') } as never,
    )
    expect(value).toEqual({ session_id: 'session-new', title: '新标题', first_message_sent: true })
    expect(calls.createPayloads).toEqual([{ workspaceId: 'ws-a' }])
    expect(calls.promptPayloads).toEqual([{ sessionId: 'session-new', mode: 'queue', text: '帮我做 X' }])
    expect(calls.renamePayloads).toEqual([{ sessionId: 'session-new', title: '任务 X' }])
  })

  it('falls back to a plain cwd create when no workspace owns the directory', async () => {
    const calls = makeCalls()
    const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg())
    await tool.execute({}, { agent: sender('/other/b') } as never)
    expect(calls.createPayloads).toEqual([{ cwd: '/other/b' }])
  })

  it('matches a workspace through a symlinked cwd (canonical path comparison)', async () => {
    const calls = makeCalls()
    const root = await mkdtemp(join(tmpdir(), 'cross-chat-ws-'))
    const real = join(root, 'real')
    const link = join(root, 'link')
    try {
      await mkdir(real)
      await symlink(real, link)
      calls.workspaceListResult = ok({
        items: [{ workspaceId: 'ws-real', path: await realpath(real) }],
        archivedSessionIds: [],
      })
      const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg())
      await tool.execute({}, { agent: sender(link) } as never)
      expect(calls.createPayloads).toEqual([{ workspaceId: 'ws-real' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still creates with cwd when the workspace baseline fails', async () => {
    const calls = makeCalls()
    calls.workspaceListResult = fail('internal', 'boom')
    const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg())
    await tool.execute({}, { agent: sender('/proj/a') } as never)
    expect(calls.createPayloads).toEqual([{ cwd: '/proj/a' }])
  })

  it('mints a distinct non-empty rpcId for every rpc envelope', async () => {
    const calls = makeCalls()
    const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg())
    await tool.execute(
      { first_message: '帮我做 X', title: '任务 X' },
      { agent: sender('/proj/a') } as never,
    )
    expect(calls.rpcIds).toHaveLength(4)
    for (const rpcId of calls.rpcIds) {
      expect(typeof rpcId).toBe('string')
      expect(rpcId.length).toBeGreaterThan(0)
    }
    expect(new Set(calls.rpcIds).size).toBe(4)
  })

  it('omits cwd from payload when the sender has none', async () => {
    const calls = makeCalls()
    const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg())
    await tool.execute({}, { agent: sender(undefined) } as never)
    expect(calls.createPayloads).toEqual([{}])
  })

  it('creates a blank session without first_message or title', async () => {
    const calls = makeCalls()
    const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg())
    const value = await tool.execute({}, { agent: sender('/proj/a') } as never)
    expect(value).toEqual({ session_id: 'session-new', title: null, first_message_sent: false })
    expect(calls.promptPayloads).toEqual([])
    expect(calls.renamePayloads).toEqual([])
  })

  it('treats a blank first_message as not provided', async () => {
    const calls = makeCalls()
    const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg())
    const value = await tool.execute({ first_message: '   ' }, { agent: sender('/proj/a') } as never)
    expect(value).toMatchObject({ first_message_sent: false })
    expect(calls.promptPayloads).toEqual([])
  })

  it('fails with API_PROXY_UNAVAILABLE when the service is absent', async () => {
    const calls = makeCalls()
    const tool = createSessionTool(ctxWith(calls, undefined), cfg())
    await expect(tool.execute({}, { agent: sender('/proj/a') } as never)).rejects.toThrow(/API_PROXY_UNAVAILABLE/)
  })

  it('translates an rpc create failure into CREATE_FAILED', async () => {
    const calls = makeCalls()
    calls.createResult = fail('agent-preset-not-found', 'unknown preset')
    const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg())
    await expect(tool.execute({}, { agent: sender('/proj/a') } as never)).rejects.toThrow(/CREATE_FAILED: agent-preset-not-found: unknown preset/)
  })

  it('fails with RENAME_FAILED including the session id', async () => {
    const calls = makeCalls()
    calls.renameResult = fail('title-invalid', 'empty title')
    const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg())
    await expect(
      tool.execute({ title: ' ' }, { agent: sender('/proj/a') } as never),
    ).rejects.toThrow(/RENAME_FAILED: title-invalid: empty title.*session-new/)
  })

  it('fails with PROMPT_FAILED including the session id', async () => {
    const calls = makeCalls()
    calls.promptResult = fail('session-not-found', 'gone')
    const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg())
    await expect(
      tool.execute({ first_message: 'hi' }, { agent: sender('/proj/a') } as never),
    ).rejects.toThrow(/PROMPT_FAILED: session-not-found: gone.*session-new/)
  })

  it('rejects an oversized first_message with MESSAGE_TOO_LONG', async () => {
    const calls = makeCalls()
    const tool = createSessionTool(ctxWith(calls, makeApi(calls)), cfg({ maxMessageChars: 10 }))
    await expect(
      tool.execute({ first_message: 'x'.repeat(11) }, { agent: sender('/proj/a') } as never),
    ).rejects.toThrow(/MESSAGE_TOO_LONG/)
  })
})
