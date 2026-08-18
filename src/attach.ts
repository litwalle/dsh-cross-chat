/**
 * Attachment helpers for cross-chat image/file delivery (spec §13).
 *
 * @module dsh-cross-chat/attach
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentLimits, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { RpcId, type ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

export const MAX_IMAGES_PER_MESSAGE = 5
export const MAX_FILES_PER_MESSAGE = 10

const EXT_MEDIA: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Map a file path to a supported image media type, or null. */
export function mediaTypeForPath(filePath: string): ImageMediaType | null {
  return EXT_MEDIA[path.extname(filePath).toLowerCase()] ?? null
}

/** A clean basename, or null for empty/dot/dotdot/root-only paths. */
export function safeBasename(filePath: string): string | null {
  const base = path.basename(filePath)
  if (base === '' || base === '.' || base === '..') return null
  return base
}

/** Conservative attachment limits when the host projection is unavailable. */
export const DEFAULT_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: MAX_IMAGES_PER_MESSAGE,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** Best-effort host attachment limits from the apiProxy session-list projection. */
export async function resolveImageLimits(ctx: Context): Promise<ImageAttachmentLimits> {
  const api = ctx.get?.('apiProxy') as ApiProxy | undefined
  if (!api) return DEFAULT_LIMITS
  try {
    const res = await api.sessions.list({ rpcId: RpcId(randomUUID()), payload: {} })
    if (!res.result.ok) return DEFAULT_LIMITS
    const limits = (res.result.value.items[0]?.projections?.values as { imageLimits?: ImageAttachmentLimits } | undefined)?.imageLimits
    return limits ?? DEFAULT_LIMITS
  } catch {
    return DEFAULT_LIMITS
  }
}

/** Read one image file and build the attachment save request. */
export async function readImageRequest(filePath: string, limits: ImageAttachmentLimits): Promise<SaveImageAttachment> {
  let data: Buffer
  try {
    data = await readFile(filePath)
  } catch {
    throw new Error(`IMAGE_READ_FAILED: 无法读取图片 ${filePath}`)
  }
  if (data.byteLength > limits.maxImageBytes) {
    throw new Error(`IMAGE_READ_FAILED: 图片 ${filePath} 超过 ${limits.maxImageBytes} 字节上限`)
  }
  const mediaType = mediaTypeForPath(filePath)
  if (mediaType === null) throw new Error('IMAGE_INVALID: 仅支持 png/jpeg/webp/gif')
  const name = safeBasename(filePath) ?? undefined
  return { data, mediaType, ...(name === undefined ? {} : { name }) }
}

/** Resolve a non-colliding write target for `basename` under `targetDir`. */
export async function dedupeTargetPath(targetDir: string, basename: string): Promise<string> {
  const ext = path.extname(basename)
  const stem = basename.slice(0, basename.length - ext.length)
  let candidate = path.join(targetDir, basename)
  for (let n = 1; n < 1000; n++) {
    try {
      await readFile(candidate)
      candidate = path.join(targetDir, `${stem}-${n}${ext}`)
    } catch {
      return candidate
    }
  }
  return candidate
}

/**
 * Whether a resolved model's declared input modalities accept image content.
 * DeepSeek's chat-completions adapter always declares `['text']`, so this is
 * the capability gate that keeps `image_paths` from breaking a text-only
 * receiving session.
 */
export function acceptsImage(modalities: readonly string[] | undefined): boolean {
  return modalities?.includes('image') === true
}

/** Delivery note line kinds for {@link deliverFiles}. */
export type DeliverKind = '文件' | '图片'

/**
 * Deliver files into `targetCwd` (deduped) and return one note line per file.
 * Shared by `file_paths` and the image→file fallback used when the target
 * model cannot ingest image content; `readErrorPrefix` keeps the error
 * vocabulary of the feature that triggered the read (IMAGE_* vs FILE_*).
 */
export async function deliverFiles(
  targetCwd: string,
  paths: readonly string[],
  kind: DeliverKind,
  readErrorPrefix: 'FILE' | 'IMAGE',
): Promise<string[]> {
  const lines: string[] = []
  for (const p of paths) {
    const base = safeBasename(p)
    if (base === null) throw new Error(`${readErrorPrefix}_READ_FAILED: 非法文件名 ${p}`)
    let data: Buffer
    try {
      data = await readFile(p)
    } catch {
      throw new Error(`${readErrorPrefix}_READ_FAILED: 无法读取文件 ${p}`)
    }
    const dest = await dedupeTargetPath(targetCwd, base)
    await writeFile(dest, data)
    lines.push(`📎 ${kind}（已投递到对方工作区）：${base}（${data.byteLength} 字节）`)
  }
  return lines
}

/** Build the message content: text first, then image blocks. */
export function buildContent(text: string, imageBlocks: ImageBlock[]): Array<{ type: 'text'; text: string } | ImageBlock> {
  return [{ type: 'text', text }, ...imageBlocks]
}
