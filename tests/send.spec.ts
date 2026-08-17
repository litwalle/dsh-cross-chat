import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/index.ts'
import { sendSessionMessageTool } from '../src/tools.ts'

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role, content: [{ type: 'text', text }], source: { kind: 'user' } } as Message
}

function agent(id: string, msgs: Message[], opts: { status?: 'idle' | 'running'; onFollowup?: (m: UserMessage) => void } = {}): Agent {
  return {
    id: SessionId(id),
    status: opts.status ?? 'idle',
    session: {
      id: SessionId(id),
      header: { cwd: '/work' },
      deriveMessages: () => msgs,
    } as unknown as Session,
    followup: opts.onFollowup ?? (() => {}),
  } as unknown as Agent
}

function cfg(over: Partial<Config> = {}): Config {
  return { attribution: 'prefix', maxMessageChars: 4000, maxReadMessages: 50, ...over }
}

describe('send_session_message', () => {
  it('delivers a relay message via followup and reports delivery', async () => {
    const sender = agent('session-a', [textMsg('user', '我的开场白')])
    const received: UserMessage[] = []
    const target = agent('session-b', [], { onFollowup: (m) => received.push(m) })
    const ctx = { agents: { get: (id: unknown) => (id === SessionId('session-b') ? target : undefined), list: () => [] } } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())

    const value = await tool.execute(
      { session_id: 'session-b', message: '帮我看看这个问题' },
      { agent: sender } as never,
    )

    expect(value).toEqual({ delivered: true, session_id: 'session-b', queued: false, image_delivery: 'none' })
    expect(received).toHaveLength(1)
    expect(received[0]!.source).toEqual({
      kind: 'dsh-cross-relay',
      plugin: 'dsh-cross-chat',
      form: 'relay',
      senderSessionId: 'session-a',
      senderLabel: '我的开场白',
    })
    expect(received[0]!.content).toEqual([
      { type: 'text', text: '[跨会话消息 · 来自 我的开场白 (session-a)]\n\n帮我看看这个问题' },
    ])
  })

  it('reports queued when the target is already running', async () => {
    const sender = agent('session-a', [])
    const target = agent('session-b', [], { status: 'running' })
    const ctx = { agents: { get: () => target, list: () => [] } } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    const value = await tool.execute({ session_id: 'session-b', message: 'hi' }, { agent: sender } as never)
    expect(value).toEqual({ delivered: true, session_id: 'session-b', queued: true, image_delivery: 'none' })
  })

  it('omits the attribution prefix when configured', async () => {
    const sender = agent('session-a', [textMsg('user', '标签')])
    const received: UserMessage[] = []
    const target = agent('session-b', [], { onFollowup: (m) => received.push(m) })
    const ctx = { agents: { get: () => target, list: () => [] } } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg({ attribution: 'none' }))
    await tool.execute({ session_id: 'session-b', message: '直接正文' }, { agent: sender } as never)
    expect(received[0]!.content).toEqual([{ type: 'text', text: '直接正文' }])
  })

  it('fails with SESSION_NOT_FOUND for an unknown target', async () => {
    const sender = agent('session-a', [])
    const ctx = { agents: { get: () => undefined, list: () => [] } } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    await expect(
      tool.execute({ session_id: 'session-ghost', message: 'hi' }, { agent: sender } as never),
    ).rejects.toThrow(/SESSION_NOT_FOUND/)
  })

  it('fails with SELF_SEND_REJECTED when targeting its own session', async () => {
    const sender = agent('session-a', [])
    const ctx = { agents: { get: () => sender, list: () => [] } } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    await expect(
      tool.execute({ session_id: 'session-a', message: 'hi' }, { agent: sender } as never),
    ).rejects.toThrow(/SELF_SEND_REJECTED/)
  })

  it('fails with MESSAGE_TOO_LONG over the configured cap', async () => {
    const sender = agent('session-a', [])
    const target = agent('session-b', [])
    const ctx = { agents: { get: () => target, list: () => [] } } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg({ maxMessageChars: 10 }))
    await expect(
      tool.execute({ session_id: 'session-b', message: 'x'.repeat(11) }, { agent: sender } as never),
    ).rejects.toThrow(/MESSAGE_TOO_LONG/)
  })

  it('resolves the sender session title through apiProxy and uses it', async () => {
    const sender = agent('session-a2', [textMsg('user', '我的开场白')])
    const received: UserMessage[] = []
    const target = agent('session-b', [], { onFollowup: (m) => received.push(m) })
    const api = {
      sessions: {
        list: async () => ({
          rpcId: 'rpc-fixture' as never,
          result: { ok: true as const, value: { items: [
            { sessionId: 'session-a2', projections: { asOfSeq: 1, values: { title: '跨对话通信会话就绪' } } },
          ] } },
        }),
      },
    }
    const ctx = {
      agents: { get: () => target, list: () => [] },
      get: (name: string) => (name === 'apiProxy' ? api : undefined),
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    await tool.execute({ session_id: 'session-b', message: 'hi' }, { agent: sender } as never)
    expect(received[0]!.content).toEqual([
      { type: 'text', text: '[跨会话消息 · 来自 跨对话通信会话就绪 (session-a2)]\n\nhi' },
    ])
    expect(received[0]!.source).toMatchObject({ senderTitle: '跨对话通信会话就绪' })
  })

  it('falls back to the label when apiProxy is absent', async () => {
    const sender = agent('session-a', [textMsg('user', '我的开场白')])
    const received: UserMessage[] = []
    const target = agent('session-b', [], { onFollowup: (m) => received.push(m) })
    const ctx = {
      agents: { get: () => target, list: () => [] },
      get: () => undefined,
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    await tool.execute({ session_id: 'session-b', message: 'hi' }, { agent: sender } as never)
    expect(received[0]!.content).toEqual([
      { type: 'text', text: '[跨会话消息 · 来自 我的开场白 (session-a)]\n\nhi' },
    ])
    expect(received[0]!.source).not.toHaveProperty('senderTitle')
  })

  it('calls sessions.list once across two sends from the same sender', async () => {
    const sender = agent('session-c1', [textMsg('user', '我的开场白')])
    const received: UserMessage[] = []
    const target = agent('session-c2', [], { onFollowup: (m) => received.push(m) })
    let listCalls = 0
    const api = {
      sessions: {
        list: async () => {
          listCalls += 1
          return {
            rpcId: 'rpc-fixture' as never,
            result: { ok: true as const, value: { items: [
              { sessionId: 'session-c1', projections: { asOfSeq: 1, values: { title: '缓存标题' } } },
            ] } },
          }
        },
      },
    }
    const ctx = {
      agents: { get: () => target, list: () => [] },
      get: (name: string) => (name === 'apiProxy' ? api : undefined),
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    await tool.execute({ session_id: 'session-c2', message: 'hi' }, { agent: sender } as never)
    await tool.execute({ session_id: 'session-c2', message: 'again' }, { agent: sender } as never)
    expect(listCalls).toBe(1)
    expect(received[1]!.content).toEqual([
      { type: 'text', text: '[跨会话消息 · 来自 缓存标题 (session-c1)]\n\nagain' },
    ])
  })

  it('does not cache a failed lookup: a later successful lookup still resolves', async () => {
    const sender = agent('session-d1', [textMsg('user', '我的开场白')])
    const received: UserMessage[] = []
    const target = agent('session-d2', [], { onFollowup: (m) => received.push(m) })
    let listCalls = 0
    const api = {
      sessions: {
        list: async () => {
          listCalls += 1
          if (listCalls === 1) {
            return { rpcId: 'rpc-fixture' as never, result: { ok: false as const, error: { code: 'internal', message: 'boom', details: {} } as never } }
          }
          return {
            rpcId: 'rpc-fixture' as never,
            result: { ok: true as const, value: { items: [
              { sessionId: 'session-d1', projections: { asOfSeq: 1, values: { title: '恢复标题' } } },
            ] } },
          }
        },
      },
    }
    const ctx = {
      agents: { get: () => target, list: () => [] },
      get: (name: string) => (name === 'apiProxy' ? api : undefined),
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    await tool.execute({ session_id: 'session-d2', message: 'hi' }, { agent: sender } as never)
    expect(received[0]!.content).toEqual([
      { type: 'text', text: '[跨会话消息 · 来自 我的开场白 (session-d1)]\n\nhi' },
    ])
    expect(received[0]!.source).not.toHaveProperty('senderTitle')
    await tool.execute({ session_id: 'session-d2', message: 'again' }, { agent: sender } as never)
    expect(listCalls).toBe(2)
    expect(received[1]!.content).toEqual([
      { type: 'text', text: '[跨会话消息 · 来自 恢复标题 (session-d1)]\n\nagain' },
    ])
    expect(received[1]!.source).toMatchObject({ senderTitle: '恢复标题' })
  })
})

describe('send_session_message attachments', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')

  function targetWith(cwd: string | undefined, options?: { provider?: string; model?: string }): Agent {
    return {
      id: SessionId('session-b'),
      status: 'idle',
      options,
      session: {
        id: SessionId('session-b'),
        header: { cwd },
        deriveMessages: () => [],
      } as unknown as Session,
      followup: () => {},
    } as unknown as Agent
  }

  function sender(): Agent {
    return { id: SessionId('session-a'), status: 'idle', session: { id: SessionId('session-a'), header: { cwd: '/work' }, deriveMessages: () => [] } as unknown as Session } as unknown as Agent
  }

  function ctxWith(over: Record<string, unknown>): Context {
    return {
      agents: { get: () => targetWith('/work'), list: () => [] },
      get: (name: string) => over[name],
    } as unknown as Context
  }

  /** A stub llm service resolving the given input modalities for any route. */
  function llmWith(modalities: readonly string[]): unknown {
    return { resolveModelInfo: async () => ({ provider: 'p', id: 'm', name: 'm', inputModalities: modalities }) }
  }

  const attachmentsApi = {
    saveImage: async (input: { name?: string }) => ({ attachmentId: 'att-1', mediaType: 'image/png', bytes: input.name?.length ?? 1, width: 1, height: 1 }),
  }

  it('delivers images via the attachment service as image blocks when the target model supports images', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xcc-img-'))
    const imgPath = path.join(dir, 'photo.png')
    writeFileSync(imgPath, PNG)
    const received: UserMessage[] = []
    const target = targetWith('/work', { provider: 'pi-ai', model: 'vision-model' })
    target.followup = (m: UserMessage) => received.push(m)
    const ctx = {
      agents: { get: () => target, list: () => [] },
      get: (name: string) => name === 'attachments' ? attachmentsApi : name === 'llm' ? llmWith(['text', 'image']) : undefined,
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    const value = await tool.execute({ session_id: 'session-b', message: '看图', image_paths: [imgPath] }, { agent: sender() } as never)
    expect(value).toEqual({ delivered: true, session_id: 'session-b', queued: false, image_delivery: 'blocks' })
    expect(received).toHaveLength(1)
    const content = received[0]!.content
    expect(content[0]).toMatchObject({ type: 'text', text: '[跨会话消息 · 来自 session-a (session-a)]\n\n看图' })
    expect(content[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'att-1' } })
  })

  it('delivers images as workspace files when the target model is text-only', async () => {
    const srcDir = mkdtempSync(path.join(tmpdir(), 'xcc-img-src-'))
    const tgtDir = mkdtempSync(path.join(tmpdir(), 'xcc-img-tgt-'))
    const imgPath = path.join(srcDir, 'photo.png')
    writeFileSync(imgPath, PNG)
    const received: UserMessage[] = []
    const target = targetWith(tgtDir, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    target.followup = (m: UserMessage) => received.push(m)
    const ctx = {
      agents: { get: () => target, list: () => [] },
      get: (name: string) => name === 'llm' ? llmWith(['text']) : undefined,
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    const value = await tool.execute({ session_id: 'session-b', message: '看图', image_paths: [imgPath] }, { agent: sender() } as never)
    expect(value).toEqual({ delivered: true, session_id: 'session-b', queued: false, image_delivery: 'files' })
    expect(received).toHaveLength(1)
    expect(received[0]!.content).not.toContainEqual(expect.objectContaining({ type: 'image' }))
    const text = received[0]!.content[0] as { text: string }
    expect(text.text).toContain('📎 图片（已投递到对方工作区）：photo.png')
    expect(text.text).toContain('目标模型不支持图片输入')
    expect(existsSync(path.join(tgtDir, 'photo.png'))).toBe(true)
  })

  it('falls back to file delivery when the llm service is unavailable', async () => {
    const srcDir = mkdtempSync(path.join(tmpdir(), 'xcc-img-src-'))
    const tgtDir = mkdtempSync(path.join(tmpdir(), 'xcc-img-tgt-'))
    const imgPath = path.join(srcDir, 'photo.png')
    writeFileSync(imgPath, PNG)
    const received: UserMessage[] = []
    const target = targetWith(tgtDir)
    target.followup = (m: UserMessage) => received.push(m)
    const ctx = {
      agents: { get: () => target, list: () => [] },
      get: () => undefined,
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    const value = await tool.execute({ session_id: 'session-b', message: '看图', image_paths: [imgPath] }, { agent: sender() } as never)
    expect(value).toMatchObject({ delivered: true, image_delivery: 'files' })
    expect(existsSync(path.join(tgtDir, 'photo.png'))).toBe(true)
    expect(received[0]!.content).not.toContainEqual(expect.objectContaining({ type: 'image' }))
  })

  it('fails with ATTACHMENT_UNAVAILABLE when an image-capable target lacks the attachment service', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xcc-img-'))
    const imgPath = path.join(dir, 'photo.png')
    writeFileSync(imgPath, PNG)
    const ctx = {
      agents: { get: () => targetWith('/work', { provider: 'pi-ai', model: 'vision-model' }), list: () => [] },
      get: (name: string) => name === 'llm' ? llmWith(['text', 'image']) : undefined,
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    await expect(tool.execute({ session_id: 'session-b', message: 'x', image_paths: [imgPath] }, { agent: sender() } as never)).rejects.toThrow(/ATTACHMENT_UNAVAILABLE/)
  })

  it('fails with IMAGE_TARGET_NO_CWD when a text-only target lacks a cwd', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xcc-img-'))
    const imgPath = path.join(dir, 'photo.png')
    writeFileSync(imgPath, PNG)
    const ctx = {
      agents: { get: () => targetWith(undefined, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }), list: () => [] },
      get: (name: string) => name === 'llm' ? llmWith(['text']) : undefined,
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    await expect(tool.execute({ session_id: 'session-b', message: 'x', image_paths: [imgPath] }, { agent: sender() } as never)).rejects.toThrow(/IMAGE_TARGET_NO_CWD/)
  })

  it('delivers files into the target cwd and appends the note', async () => {
    const srcDir = mkdtempSync(path.join(tmpdir(), 'xcc-src-'))
    const tgtDir = mkdtempSync(path.join(tmpdir(), 'xcc-tgt-'))
    const filePath = path.join(srcDir, 'notes.txt')
    writeFileSync(filePath, 'hello')
    const received: UserMessage[] = []
    const target = targetWith(tgtDir)
    target.followup = (m: UserMessage) => received.push(m)
    const ctx = {
      agents: { get: () => target, list: () => [] },
      get: () => undefined,
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    await tool.execute({ session_id: 'session-b', message: '文件', file_paths: [filePath] }, { agent: sender() } as never)
    expect(existsSync(path.join(tgtDir, 'notes.txt'))).toBe(true)
    expect(existsSync(path.join(tgtDir, 'notes-1.txt'))).toBe(false)
    const text = received[0]!.content[0] as { text: string }
    expect(text.text).toContain('📎 文件（已投递到对方工作区）：notes.txt（5 字节）')
  })

  it('fails with IMAGE_TOO_MANY over the cap', async () => {
    const paths = Array.from({ length: 6 }, (_, i) => `/x/${i}.png`)
    const tool = sendSessionMessageTool(ctxWith({}), cfg())
    await expect(tool.execute({ session_id: 'session-b', message: 'x', image_paths: paths }, { agent: sender() } as never)).rejects.toThrow(/IMAGE_TOO_MANY/)
  })

  it('fails with FILE_TARGET_NO_CWD when the target lacks a cwd', async () => {
    const srcDir = mkdtempSync(path.join(tmpdir(), 'xcc-src-'))
    const filePath = path.join(srcDir, 'notes.txt')
    writeFileSync(filePath, 'hello')
    const target = targetWith(undefined)
    const ctx = {
      agents: { get: () => target, list: () => [] },
      get: () => undefined,
    } as unknown as Context
    const tool = sendSessionMessageTool(ctx, cfg())
    await expect(tool.execute({ session_id: 'session-b', message: 'x', file_paths: [filePath] }, { agent: sender() } as never)).rejects.toThrow(/FILE_TARGET_NO_CWD/)
  })
})
