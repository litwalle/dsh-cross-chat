/**
 * Relay-card pure helpers: parsing the host attribution prefix and building
 * the gray card markup. Kept DOM-free so vitest can cover them directly.
 */

/**
 * Parse the attribution prefix line emitted by the host (attribution: 'prefix').
 *
 * The host writes `[跨会话消息 · 来自 <label> (<id>)]` (see src/relay.ts
 * buildRelayMessage); the plan's tests use 跨对话消息. Accept both spellings.
 */
export function parseSenderLine(line: string): { label: string; id: string } | null {
  const m = /^\[跨(?:对话|会话)消息 · 来自 (.+?) \(([^()]+)\)\]$/.exec(line.trim())
  if (m === null) return null
  const label = m[1]!.trim()
  const id = m[2]!.trim()
  if (label === '' || id === '') return null
  return { label, id }
}

/** The display name for a message body: parsed label, else empty (id shown separately). */
export function senderNameOf(firstLine: string | undefined): string {
  const parsed = firstLine === undefined ? null : parseSenderLine(firstLine)
  return parsed === null ? '' : parsed.label
}

/**
 * The session id embedded in the built-in relay sender line rendered by the
 * host UI: `来自会话 <id>` (zh) / `From session <id>` (en). The
 * `data-context-relay-sender` element itself only carries a boolean marker, so
 * the id must be read from its text.
 */
export function senderIdFromRelayLine(line: string): string {
  const m = /^(?:来自会话|From session)\s+(\S+)/.exec(line.trim())
  return m === null ? '' : m[1]!.trim()
}

/** Short display form of a session id: first two dash-separated segments. */
export function shortId(id: string): string {
  return id.split('-').slice(0, 2).join('-')
}

/** Escape HTML special characters for safe text insertion. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 按界面语言 id 返回右上角标签文案。 */
export function kindLabelFor(localeId: string): string {
  return localeId.toLowerCase().startsWith('en') ? 'Cross-Chat Message' : '跨对话消息'
}

/** 按界面语言 id 与展开状态返回按钮文案。 */
export function expandLabel(localeId: string, expanded: boolean): string {
  if (expanded) return localeId.toLowerCase().startsWith('en') ? 'Collapse' : '收起'
  return localeId.toLowerCase().startsWith('en') ? 'Expand' : '展开全部'
}

const ICON_SVG =
  '<svg class="xcc-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
  + '<path d="M2.5 4.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H6.2L3.5 14v-3h-.5A1.5 1.5 0 0 1 2.5 9.5v-5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
  + '<path d="M5.5 6h5M5.5 8h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'

/**
 * Build the gray card markup. `text` is escaped; `senderName` may be empty
 * (fall back to the short id in the header then). 标签与按钮文案均为纯文案参数
 * （`kindLabel` / `expandText`），由调用方按当前界面语言生成——本函数不做任何
 * 语言判定，保持"纯函数、文案由调用方决定"。
 */
export function buildCardMarkup(opts: {
  senderName: string
  senderId: string
  text: string
  kindLabel: string
  expandText: string
  /** 可选：渲染在正文与按钮之间的额外标记（图片容器等）；调用方负责其安全性。 */
  extra?: string
}): string {
  const name = opts.senderName === '' ? shortId(opts.senderId) : opts.senderName
  return [
    `<div class="xcc-card" data-dsh-cross-chat-card="1">`,
    `  <div class="xcc-head">`,
    `    <div class="xcc-from">${ICON_SVG}<span class="xcc-name" title="${escapeHtml(opts.senderId)}">${escapeHtml(name)}</span></div>`,
    `    <span class="xcc-kind">${escapeHtml(opts.kindLabel)}</span>`,
    `  </div>`,
    `  <p class="xcc-body clamped">${escapeHtml(opts.text)}</p>`,
    opts.extra === undefined || opts.extra === '' ? '' : `  ${opts.extra}`,
    `  <button class="xcc-more" type="button" hidden>${escapeHtml(opts.expandText)}</button>`,
    `</div>`,
  ].join('\n')
}
