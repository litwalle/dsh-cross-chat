import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'
import { apply } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** schemastery 3.18 的 `z<Config>` 输入类型是严格全量对象：用 unknown 包装调用。 */
const parse = (input: unknown) => Config(input as never)

describe('plugin entry', () => {
  it('exposes the plugin identity', () => {
    expect(name).toBe('dsh-cross-chat')
    expect(inject).toEqual(['tools', 'agents', 'sessions'])
  })

  it('applies config defaults when called with an empty record', () => {
    expect(parse({})).toEqual({
      attribution: 'prefix',
      maxMessageChars: 4000,
      maxReadMessages: 50,
    })
  })

  it('accepts explicit values', () => {
    expect(parse({ attribution: 'none', maxMessageChars: 100, maxReadMessages: 5 })).toEqual({
      attribution: 'none',
      maxMessageChars: 100,
      maxReadMessages: 5,
    })
  })

  it('rejects an unknown attribution mode', () => {
    expect(() => parse({ attribution: 'sideways' })).toThrow()
  })
})

describe('apply', () => {
  it('registers the four cross-chat tools', () => {
    const registered: string[] = []
    const ctx = {
      tools: { register: (tool: ToolDefinition) => registered.push(tool.name) },
      agents: {},
      sessions: {},
    } as unknown as Context
    apply(ctx, Config({} as never))
    expect(registered).toEqual(['list_sessions', 'send_session_message', 'read_session', 'create_session'])
  })
})
