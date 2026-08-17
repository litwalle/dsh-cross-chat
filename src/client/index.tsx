/**
 * dsh-cross-chat, browser half: replaces the built-in relay card with a
 * custom gray card via DOM mounting (see spec §12.2 - the chat node slot
 * cannot be safely overridden per node). Host side unchanged.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { buildCardMarkup, expandLabel, kindLabelFor, parseSenderLine, senderIdFromRelayLine } from './card.ts'
import { installStyles } from './styles.ts'

export const name = 'dsh-cross-chat'

// 本插件是纯 DOM 挂载（MutationObserver + 卡片替换），不依赖任何 client 服务。
// 注意：inject 是「服务名」列表（如 'slots'），不是包名——之前误写了包名
// '@deepseek-ai/dsh-client-runtime'，导致 web boot 永远等不到该服务而 pending。
export const inject: string[] = []

const CARD_MARK = 'data-dsh-cross-chat-card'
/** Provenance label the host projects for `dsh-cross-relay` sources
 * (contextProvenance default branch: label = source kind). */
const RELAY_SOURCE_LABEL = 'dsh-cross-relay'

/** 解析当前界面语言 id：locale 服务 → navigator.language → 'zh'。 */
function resolveLocaleId(ctx: ClientContext): string {
  const locale = (ctx as { get?: (name: string) => unknown }).get?.('locale') as
    | { getLocale?: () => { active?: string } }
    | undefined
  const active = locale?.getLocale?.().active
  if (typeof active === 'string' && active !== '') return active
  const nav = (typeof navigator !== 'undefined' ? navigator.language : '') ?? ''
  return nav.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** 更新已挂载卡片的标签与按钮文案（语言切换后调用）。 */
function updateKindLabels(localeId: string): void {
  for (const card of document.querySelectorAll<HTMLElement>('[data-dsh-cross-chat-card]')) {
    const kind = card.querySelector('.xcc-kind')
    if (kind !== null) kind.textContent = kindLabelFor(localeId)
    const body = card.querySelector('.xcc-body')
    const more = card.querySelector('.xcc-more') as HTMLButtonElement | null
    if (more !== null && body !== null) {
      more.textContent = expandLabel(localeId, !body.classList.contains('clamped'))
    }
  }
}

/**
 * Swap one built-in relay row (RelayBody with data-context-relay-sender) for
 * the gray card.
 *
 * Real host structure (verified against the running bundle): the anchor div
 * `[data-chat-anchor-key]` wraps a DisclosureRow whose body (only rendered
 * once expanded) is `<div data-context-injection-body>` containing
 * `<p data-context-relay-sender>` (a boolean marker; the sender id lives in
 * its text `来自会话 <id>` / `From session <id>`) followed by the content node
 * `<pre data-context-text>`. We keep the anchor div itself (scroll anchoring
 * and `data-chat-anchor-key` survive) and replace its children with the card.
 *
 * `getLocaleId` 读取当前语言（闭包变量），保证语言切换后点击仍按最新语言出文案。
 */
function swapRow(row: HTMLElement, getLocaleId: () => string): void {
  const holder = row.closest('[data-chat-anchor-key]')
  if (holder === null || holder.querySelector(`[${CARD_MARK}]`) !== null) return
  const contentNode = row.nextElementSibling
  const text = contentNode === null ? '' : (contentNode.textContent ?? '').trim()
  const firstLine = text.split('\n')[0] ?? ''
  const parsed = parseSenderLine(firstLine)
  const bodyText = parsed === null ? text : text.slice(firstLine.length).trimStart()
  const localeId = getLocaleId()
  // 收集默认渲染内容节点里的图片元素（ModelFacingContent 渲染的 <img>），克隆进卡片
  const images = contentNode === null ? [] : [...contentNode.querySelectorAll<HTMLImageElement>('img')]
  const imageMarkup = images.length === 0
    ? ''
    : `<div class="xcc-images">${images.map((img) => img.outerHTML).join('')}</div>`
  const html = buildCardMarkup({
    senderName: parsed === null ? '' : parsed.label,
    senderId: parsed === null ? senderIdFromRelayLine(row.textContent ?? '') : parsed.id,
    text: bodyText === '' ? firstLine : bodyText,
    kindLabel: kindLabelFor(localeId),
    expandText: expandLabel(localeId, false),
    extra: imageMarkup,
  })
  const wrapper = document.createElement('div')
  wrapper.innerHTML = html
  const cardEl = wrapper.firstElementChild
  if (!(cardEl instanceof HTMLElement)) return
  // 保留 anchor 元素本身，只替换其内容（滚动锚点与 data-chat-anchor-key 不丢）
  holder.replaceChildren(cardEl)
  // 展开/收起：仅当正文溢出时显示按钮；插入时测量一次，窗口 resize 时重测（每张卡片只注册一次）
  const body = cardEl.querySelector('.xcc-body')
  const more = cardEl.querySelector('.xcc-more')
  if (body instanceof HTMLElement && more instanceof HTMLButtonElement) {
    const measure = () => {
      more.hidden = body.scrollHeight <= body.clientHeight
    }
    measure()
    if (typeof window !== 'undefined') window.addEventListener('resize', measure)
    more.addEventListener('click', () => {
      const clamped = body.classList.toggle('clamped')
      more.textContent = expandLabel(getLocaleId(), !clamped)
    })
  }
}

/**
 * One full scan pass over the chat flow:
 *  - pass 1 swaps expanded relay rows (body mounted) for the gray card;
 *  - pass 2 auto-expands collapsed relay rows so pass 1 can swap them.
 * Per-row try/catch keeps one bad row from aborting the rest of the pass
 * (a throw would otherwise leave the remaining rows unswapped, silently,
 * until the next DOM mutation).
 */
function scanOnce(getLocaleId: () => string): void {
  // 第一遍：已展开的 relay 行（正文已挂载）直接替换。
  for (const el of document.querySelectorAll<HTMLElement>('[data-context-relay-sender]')) {
    try {
      swapRow(el, getLocaleId)
    } catch (err) {
      console.error('[dsh-cross-chat] 替换 relay 行失败:', err)
    }
  }
  // 第二遍：折叠态 relay 行（data-context-source 标签在头部，正文未挂载）。
  // 派发一次 click 让 React setOpen(true) 挂载正文 → 观察器再次触发 → 第一遍替换；
  // 替换销毁了 disclosure，卡片存在性检查防止循环。
  for (const el of document.querySelectorAll<HTMLElement>('[data-context-source]')) {
    try {
      if ((el.textContent ?? '').trim() !== RELAY_SOURCE_LABEL) continue
      const holder = el.closest('[data-chat-anchor-key]')
      if (holder === null) continue
      if (holder.querySelector(`[${CARD_MARK}]`) !== null) continue
      if (holder.querySelector('[data-context-relay-sender]') !== null) continue
      const disclosure = holder.querySelector('[data-disclosure-row]')
      if (disclosure instanceof HTMLElement) disclosure.click()
    } catch (err) {
      console.error('[dsh-cross-chat] 展开 relay 行失败:', err)
    }
  }
}

/** Observe the chat flow for relay rows and swap them in. */
export function apply(ctx: ClientContext): void {
  // 非浏览器环境（node 测试）直接返回；观察器与样式注入只在真实 GUI 生效。
  if (typeof document === 'undefined') return
  installStyles()
  // 当前语言随 locale/change 更新；扫描与点击都通过 getter 读最新值。
  let localeId = resolveLocaleId(ctx)
  const getLocaleId = (): string => localeId
  const scan = () => scanOnce(getLocaleId)
  const mo = new MutationObserver(scan)
  mo.observe(document.body, { childList: true, subtree: true })
  // 立即扫描一次：HMR 重挂载或插件重载时对话可能已经渲染，而观察器只会
  // 在下一次 DOM 变更时才触发；不先扫一次，已有 relay 行会一直保持默认样式。
  scan()
  // 语言切换：更新已渲染卡片
  ;(ctx as { on?: (event: string, fn: () => void) => void }).on?.('locale/change', () => {
    localeId = resolveLocaleId(ctx)
    updateKindLabels(localeId)
  })
}
