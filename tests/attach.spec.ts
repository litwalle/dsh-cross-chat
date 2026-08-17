import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  buildContent,
  dedupeTargetPath,
  mediaTypeForPath,
  resolveImageLimits,
  safeBasename,
} from '../src/attach.ts'

describe('mediaTypeForPath', () => {
  it('maps supported extensions', () => {
    expect(mediaTypeForPath('a.png')).toBe('image/png')
    expect(mediaTypeForPath('a.jpg')).toBe('image/jpeg')
    expect(mediaTypeForPath('a.jpeg')).toBe('image/jpeg')
    expect(mediaTypeForPath('a.webp')).toBe('image/webp')
    expect(mediaTypeForPath('a.gif')).toBe('image/gif')
    expect(mediaTypeForPath('A.PNG')).toBe('image/png')
  })
  it('rejects unsupported extensions', () => {
    expect(mediaTypeForPath('a.pdf')).toBeNull()
    expect(mediaTypeForPath('a')).toBeNull()
  })
})

describe('safeBasename', () => {
  it('extracts a clean basename', () => {
    expect(safeBasename('/a/b/photo.png')).toBe('photo.png')
    expect(safeBasename('photo.png')).toBe('photo.png')
  })
  it('rejects dangerous names', () => {
    // 尾斜杠路径 '/a/b/' 按 Node path.basename 语义返回 'b'（可接受，读取会失败）；
    // 真正拒绝的是空名与点路径。
    expect(safeBasename('')).toBeNull()
    expect(safeBasename('..')).toBeNull()
    expect(safeBasename('.')).toBeNull()
  })
})

describe('dedupeTargetPath', () => {
  it('returns the plain target when it is free', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xcc-dedupe-'))
    const out = await dedupeTargetPath(dir, 'notes.txt')
    expect(out).toBe(path.join(dir, 'notes.txt'))
  })
  it('appends -1/-2 suffixes until a free name', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xcc-dedupe-'))
    writeFileSync(path.join(dir, 'notes.txt'), 'a')
    writeFileSync(path.join(dir, 'notes-1.txt'), 'b')
    const out = await dedupeTargetPath(dir, 'notes.txt')
    expect(out).toBe(path.join(dir, 'notes-2.txt'))
    expect(existsSync(out)).toBe(false)
  })
})

describe('resolveImageLimits', () => {
  it('reads limits from the apiProxy session-list projection', async () => {
    const limits = { maxImageBytes: 123, maxImagesPerMessage: 3, maxMessageImageBytes: 456, maxImagePixels: 789, mediaTypes: ['image/png'] }
    const ctx = {
      get: (name: string) => name === 'apiProxy'
        ? { sessions: { list: async () => ({ rpcId: 'r', result: { ok: true, value: { items: [{ projections: { asOfSeq: 1, values: { imageLimits: limits } } }] } } }) } }
        : undefined,
    } as unknown as Context
    await expect(resolveImageLimits(ctx)).resolves.toEqual(limits)
  })
  it('falls back to defaults when apiProxy is absent', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const limits = await resolveImageLimits(ctx)
    expect(limits.maxImagesPerMessage).toBe(5)
    expect(limits.mediaTypes).toContain('image/gif')
  })
})

describe('buildContent', () => {
  it('puts text first and image blocks after', () => {
    const image = { type: 'image', attachment: { attachmentId: 'a1' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } as const
    const content = buildContent('你好', [image])
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: 'text', text: '你好' })
    expect(content[1]).toEqual(image)
  })
})
