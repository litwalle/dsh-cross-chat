import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/client/index.tsx'

describe('client entry', () => {
  it('exposes the plugin identity', () => {
    expect(name).toBe('dsh-cross-chat')
    expect(inject).toEqual([])
  })

  it('apply runs without throwing on a minimal context', () => {
    expect(() => apply({} as never)).not.toThrow()
  })
})
