import { beforeEach, describe, expect, it } from 'vitest'
import { buildCardMarkup, expandLabel, kindLabelFor, parseSenderLine, senderNameOf } from '../src/client/card.ts'
import { apply } from '../src/client/index.tsx'

describe('parseSenderLine', () => {
  it('parses the attribution prefix line', () => {
    expect(parseSenderLine('[跨对话消息 · 来自 跨对话通信会话就绪 (session-2e4a467a)]')).toEqual({
      label: '跨对话通信会话就绪',
      id: 'session-2e4a467a',
    })
  })

  it('returns null for unrelated first lines', () => {
    expect(parseSenderLine('你好，普通消息')).toBeNull()
    expect(parseSenderLine('')).toBeNull()
  })
})

describe('senderNameOf', () => {
  it('uses the parsed label when present', () => {
    expect(senderNameOf('[跨对话消息 · 来自 需求评审 (session-x)]')).toBe('需求评审')
  })
  it('falls back to a short id when parsing fails', () => {
    expect(senderNameOf('普通正文')).toBe('')
  })
})

describe('buildCardMarkup', () => {
  it('builds the gray card skeleton with escaped text', () => {
    const html = buildCardMarkup({
      senderName: '需求评审',
      senderId: 'session-test-0000-0000-0000-000000000000',
      text: '评审结论已更新到第三条，你可以直接看。<b>x</b>',
      kindLabel: '跨对话消息',
      expandText: '展开全部',
    })
    expect(html).toContain('data-dsh-cross-chat-card="1"')
    expect(html).toContain('需求评审')
    expect(html).toContain('session-test-0000-0000')
    expect(html).toContain('跨对话消息')
    expect(html).toContain('展开全部') // 按钮初始文案由调用方传入
    expect(html).not.toContain('<b>x</b>') // 必须转义
    expect(html).toContain('评审结论已更新到第三条，你可以直接看。&lt;b&gt;x&lt;/b&gt;')
  })
})

describe('kindLabelFor', () => {
  it('returns the localized kind label', () => {
    expect(kindLabelFor('zh')).toBe('跨对话消息')
    expect(kindLabelFor('zh-CN')).toBe('跨对话消息')
    expect(kindLabelFor('en')).toBe('Cross-Chat Message')
    expect(kindLabelFor('en-US')).toBe('Cross-Chat Message')
    expect(kindLabelFor('')).toBe('跨对话消息')
  })
})

describe('expandLabel', () => {
  it('localizes expand/collapse by locale id', () => {
    expect(expandLabel('zh', false)).toBe('展开全部')
    expect(expandLabel('zh', true)).toBe('收起')
    expect(expandLabel('en', false)).toBe('Expand')
    expect(expandLabel('en', true)).toBe('Collapse')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 接线回归：最小 DOM stub（node 环境可跑；apply 已有 document 守卫）。
// 模型与运行中 bundle 核实的结构一致：
//   div[data-chat-anchor-key]                      (holder，保留)
//     div.DisclosureRow.root
//       div[data-disclosure-row]                   (可点击头部；折叠态含
//         └─ span[data-context-source]              provenance 标签，relay 为 'dsh-cross-relay')
//       div[data-context-injection-body]           (仅展开后挂载)
//         ├─ p[data-context-relay-sender]="true"   "来自会话 <id>" / "From session <id>"
//         └─ pre[data-context-text]                消息正文
// ─────────────────────────────────────────────────────────────────────────────

class FakeHTMLElement {}

class FakeClassList {
  private set = new Set<string>()
  add(c: string): void { this.set.add(c) }
  contains(c: string): boolean { return this.set.has(c) }
  toggle(c: string): boolean {
    if (this.set.has(c)) { this.set.delete(c); return false }
    this.set.add(c); return true
  }
}

class FakeEl extends FakeHTMLElement {
  tag: string
  attrs = new Map<string, string>()
  children: FakeEl[] = []
  parent: FakeEl | null = null
  classList = new FakeClassList()
  textContent = ''
  hidden = false
  scrollHeight = 0
  clientHeight = 0
  private listeners = new Map<string, Array<() => void>>()
  constructor(tag: string) { super(); this.tag = tag }

  setAttribute(k: string, v: string): void { this.attrs.set(k, v) }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null }
  append(...kids: FakeEl[]): void { for (const k of kids) { k.parent = this; this.children.push(k) } }
  appendChild(k: FakeEl): FakeEl { this.append(k); return k }
  replaceChildren(...kids: FakeEl[]): void {
    for (const c of this.children) c.parent = null
    this.children = []
    for (const k of kids) { k.parent = this; this.children.push(k) }
  }
  get firstElementChild(): FakeEl | null { return this.children[0] ?? null }
  get outerHTML(): string {
    const attrs = [...this.attrs.entries()].map(([k, v]) => ` ${k}="${v}"`).join('')
    const kids = this.children.map((c) => c.outerHTML).join('')
    const text = this.textContent ?? ''
    if (kids === '' && text === '' && VOID_TAGS.has(this.tag)) return `<${this.tag}${attrs} />`
    if (kids === '' && text === '') return `<${this.tag}${attrs}>`
    return `<${this.tag}${attrs}>${text}${kids}</${this.tag}>`
  }
  get nextElementSibling(): FakeEl | null {
    if (this.parent === null) return null
    const i = this.parent.children.indexOf(this)
    return i >= 0 ? (this.parent.children[i + 1] ?? null) : null
  }
  addEventListener(t: string, fn: () => void): void {
    const list = this.listeners.get(t)
    if (list === undefined) this.listeners.set(t, [fn]); else list.push(fn)
  }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn() }

  private matchesOne(sel: string): boolean {
    const attrEq = /^([a-zA-Z0-9-]+)?\[([a-zA-Z0-9-]+)="([^"]*)"\]$/.exec(sel)
    if (attrEq !== null) {
      const [, tag, attr, value] = attrEq
      if (tag !== undefined && tag !== this.tag) return false
      return this.attrs.get(attr!) === value
    }
    const attr = /^([a-zA-Z0-9-]+)?\[([a-zA-Z0-9-]+)\]$/.exec(sel)
    if (attr !== null) {
      const [, tag, name] = attr
      if (tag !== undefined && tag !== this.tag) return false
      return this.attrs.has(name!)
    }
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1))
    return this.tag === sel
  }
  matches(sel: string): boolean { return sel.split(/\s+/).every((s) => this.matchesOne(s)) }
  closest(sel: string): FakeEl | null {
    let n: FakeEl | null = this
    while (n !== null) { if (n.matches(sel)) return n; n = n.parent }
    return null
  }
  querySelectorAll(sel: string): FakeEl[] {
    const out: FakeEl[] = []
    const walk = (n: FakeEl): void => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c) } }
    walk(this)
    return out
  }
  querySelector(sel: string): FakeEl | null { return this.querySelectorAll(sel)[0] ?? null }
}

const VOID_TAGS = new Set(['img', 'br', 'input', 'hr'])

/** Tiny parser for buildCardMarkup's regular card markup (text kept literal). */
function parseHtml(html: string): FakeEl {
  const root = new FakeEl('root')
  const stack: FakeEl[] = [root]
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const text = html.slice(last, m.index)
    if (text !== '') stack[stack.length - 1]!.textContent += text
    last = re.lastIndex
    if (m[1] === '/') { stack.pop(); continue }
    const el = new FakeEl(m[2]!)
    const attrRe = /([a-zA-Z0-9-]+)(?:="([^"]*)")?/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(m[3]!)) !== null) {
      el.attrs.set(am[1]!, am[2] ?? '')
      if (am[1] === 'class') for (const c of (am[2] ?? '').split(/\s+/).filter(Boolean)) el.classList.add(c)
    }
    stack[stack.length - 1]!.append(el)
    if (m[4] !== '/' && !VOID_TAGS.has(m[2]!)) stack.push(el)
  }
  const tail = html.slice(last)
  if (tail !== '') stack[stack.length - 1]!.textContent += tail
  return root
}

const doc = {
  documentElement: { lang: 'zh-CN' },
  head: new FakeEl('head'),
  body: new FakeEl('body'),
  createElement(tag: string): FakeEl {
    const el = new FakeEl(tag)
    if (tag === 'div') {
      Object.defineProperty(el, 'innerHTML', {
        set(v: string) { el.replaceChildren(...parseHtml(v).children) },
        get() { return '' },
      })
    }
    return el
  },
  querySelector(sel: string): FakeEl | null {
    return doc.head.querySelector(sel) ?? doc.body.querySelector(sel)
  },
  querySelectorAll(sel: string): FakeEl[] {
    return [...doc.head.querySelectorAll(sel), ...doc.body.querySelectorAll(sel)]
  },
}

class FakeMutationObserver {
  static last: FakeMutationObserver | null = null
  callback: () => void
  constructor(callback: () => void) { this.callback = callback; FakeMutationObserver.last = this }
  observe(): void {}
}

const win = {
  listeners: new Map<string, () => void>(),
  addEventListener(t: string, fn: () => void): void { win.listeners.set(t, fn) },
}

/** 最小 ClientContext stub：`get('locale')` 返回可变的 locale 服务 mock，
 * `on` 记录事件注册（测试可手动触发 locale/change）。 */
function stubCtx(active = 'zh'): {
  locale: { active: string }
  handlers: Map<string, () => void>
  get(name: string): unknown
  on(event: string, fn: () => void): void
} {
  const locale = { active }
  const handlers = new Map<string, () => void>()
  return {
    locale,
    handlers,
    get(name: string): unknown {
      if (name === 'locale') return { getLocale: () => locale }
      return undefined
    },
    on(event: string, fn: () => void): void { handlers.set(event, fn) },
  }
}

/** 折叠态 relay 行：头部带 provenance 标签；点击头部时挂载正文（模拟 React setOpen）。 */
function buildCollapsedRelayRow(contentText: string, senderLine: string): FakeEl {
  const holder = new FakeEl('div')
  holder.attrs.set('data-chat-anchor-key', 'node-1')
  holder.attrs.set('data-chat-flow-key', 'node-1')
  holder.attrs.set('data-chat-flow-kind', 'context')
  const root = new FakeEl('div')
  const header = new FakeEl('div')
  header.attrs.set('data-disclosure-row', '')
  const source = new FakeEl('span')
  source.attrs.set('data-context-source', '')
  source.textContent = 'dsh-cross-relay'
  header.append(source)
  const bodyDiv = new FakeEl('div')
  bodyDiv.attrs.set('data-context-injection-body', '')
  bodyDiv.attrs.set('data-context-form', 'relay')
  const p = new FakeEl('p')
  p.attrs.set('data-context-relay-sender', 'true') // 真实 bundle：布尔标记
  p.textContent = senderLine
  const pre = new FakeEl('pre')
  pre.attrs.set('data-context-text', '')
  pre.textContent = contentText
  bodyDiv.append(p, pre)
  header.addEventListener('click', () => {
    if (root.querySelector('[data-context-injection-body]') === null) root.append(bodyDiv)
  })
  root.append(header)
  holder.append(root)
  return holder
}

/** 已展开 relay 行（正文已在 DOM 中），供第一遍扫描直接替换。 */
function buildExpandedRelayRow(contentText: string, senderLine: string): FakeEl {
  const holder = buildCollapsedRelayRow(contentText, senderLine)
  const header = holder.querySelector('[data-disclosure-row]')!
  header.click() // 挂载正文
  return holder
}

describe('relay card DOM mounting (stub)', () => {
  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).document = doc
    ;(globalThis as Record<string, unknown>).MutationObserver = FakeMutationObserver
    ;(globalThis as Record<string, unknown>).HTMLElement = FakeHTMLElement
    ;(globalThis as Record<string, unknown>).HTMLButtonElement = FakeHTMLElement
    ;(globalThis as Record<string, unknown>).window = win
    FakeMutationObserver.last = null
    win.listeners.clear()
    doc.head.children = []
    doc.body.children = []
  })

  it('auto-expands a collapsed relay row and swaps in the gray card', () => {
    const holder = buildCollapsedRelayRow(
      '[跨会话消息 · 来自 我的开场白 (session-abc-123)]\n\n你好，这是内容。<b>x</b>',
      '来自会话 session-abc-123',
    )
    doc.body.append(holder)
    apply(stubCtx('zh') as never)
    const scan = FakeMutationObserver.last!.callback

    // apply 时的初始扫描已跑完第二遍：点击 disclosure 头部 → 正文已挂载。
    expect(doc.body.querySelector('[data-context-relay-sender]')).not.toBeNull()

    scan() // 第一遍：替换为卡片
    expect(holder.children).toHaveLength(1)
    const card = holder.children[0]!
    expect(card.matches('.xcc-card')).toBe(true)
    expect(card.attrs.get('data-dsh-cross-chat-card')).toBe('1')
    expect(doc.body.querySelector('[data-context-relay-sender]')).toBeNull()

    const name = card.querySelector('.xcc-name')!
    expect(name.textContent).toBe('我的开场白')
    expect(name.attrs.get('title')).toBe('session-abc-123')
    const body = card.querySelector('.xcc-body')!
    expect(body.textContent).toContain('你好，这是内容。')
    expect(body.textContent).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(body.textContent).not.toContain('<b>x</b>')
    expect(card.querySelector('.xcc-kind')!.textContent).toBe('跨对话消息')

    // 展开/收起（zh 标签）
    const more = card.querySelector('.xcc-more')!
    body.clientHeight = 40
    body.scrollHeight = 160
    more.click()
    expect(body.classList.contains('clamped')).toBe(false)
    expect(more.textContent).toBe('收起')
    more.click()
    expect(body.classList.contains('clamped')).toBe(true)
    expect(more.textContent).toBe('展开全部')

    // 再扫描一次 → 去重，仍只有一张卡片
    scan()
    expect(holder.children).toHaveLength(1)
    expect(holder.querySelector('.xcc-card')).toBe(card)
  })

  it('never clicks a holder that already carries the card (dedupe guard)', () => {
    const holder = new FakeEl('div')
    holder.attrs.set('data-chat-anchor-key', 'node-1')
    const header = new FakeEl('div')
    header.attrs.set('data-disclosure-row', '')
    let clicks = 0
    header.addEventListener('click', () => { clicks += 1 })
    const source = new FakeEl('span')
    source.attrs.set('data-context-source', '')
    source.textContent = 'dsh-cross-relay'
    const card = parseHtml(buildCardMarkup({
      senderName: '需求评审',
      senderId: 'session-x',
      text: '已处理',
      kindLabel: '跨对话消息',
      expandText: '展开全部',
    })).children[0]!
    holder.append(header, source, card)
    doc.body.append(holder)
    apply(stubCtx('zh') as never)
    FakeMutationObserver.last!.callback()
    expect(clicks).toBe(0)
    expect(holder.querySelectorAll('.xcc-card')).toHaveLength(1)
  })

  it('uses English kind and expand/collapse labels when the locale is en', () => {
    const holder = buildExpandedRelayRow(
      '[跨会话消息 · 来自 需求评审 (session-abc-123)]\n\n你好',
      'From session session-abc-123',
    )
    doc.body.append(holder)
    apply(stubCtx('en') as never)
    FakeMutationObserver.last!.callback()
    const card = holder.children[0]!
    expect(card.querySelector('.xcc-kind')!.textContent).toBe('Cross-Chat Message')
    const more = card.querySelector('.xcc-more')!
    expect(more.textContent).toBe('Expand')
    more.click()
    expect(more.textContent).toBe('Collapse')
  })

  it('falls back to the relay-line id when the content has no attribution prefix', () => {
    const holder = buildExpandedRelayRow('你好，这是内容。\n第二行', 'From session session-abc-123')
    doc.body.append(holder)
    apply(stubCtx('zh') as never)
    FakeMutationObserver.last!.callback()
    const card = holder.children[0]!
    const name = card.querySelector('.xcc-name')!
    expect(name.textContent).toBe('session-abc') // shortId(senderIdFromRelayLine(...))
    expect(name.attrs.get('title')).toBe('session-abc-123')
    expect(card.querySelector('.xcc-body')!.textContent).toContain('你好，这是内容。')
  })

  it('shows the expand button only when the body overflows, and re-measures on resize', () => {
    const holder = buildExpandedRelayRow(
      '[跨会话消息 · 来自 我的开场白 (session-abc-123)]\n\n你好',
      '来自会话 session-abc-123',
    )
    doc.body.append(holder)
    apply(stubCtx('zh') as never)
    FakeMutationObserver.last!.callback()
    const card = holder.children[0]!
    const body = card.querySelector('.xcc-body')!
    const more = card.querySelector('.xcc-more')!
    expect(more.hidden).toBe(true) // 默认 0/0 → 未溢出

    body.clientHeight = 40
    body.scrollHeight = 160
    win.listeners.get('resize')!()
    expect(more.hidden).toBe(false) // 溢出 → 显示

    body.clientHeight = 160
    body.scrollHeight = 40
    win.listeners.get('resize')!()
    expect(more.hidden).toBe(true) // 不溢出 → 隐藏
  })

  it('updates kind labels of mounted cards when the locale changes', () => {
    const ctx = stubCtx('zh')
    const holder = buildCollapsedRelayRow(
      '[跨会话消息 · 来自 需求评审 (session-abc-123)]\n\n你好',
      '来自会话 session-abc-123',
    )
    doc.body.append(holder)
    apply(ctx as never)
    const scan = FakeMutationObserver.last!.callback
    scan() // 第一遍：替换为卡片
    const card = holder.children[0]!
    expect(card.querySelector('.xcc-kind')!.textContent).toBe('跨对话消息')
    const more = card.querySelector('.xcc-more')!
    expect(more.textContent).toBe('展开全部')

    // locale/change 回调已注册：切换 locale 后触发，已挂载卡片实时更新
    ctx.locale.active = 'en'
    expect(ctx.handlers.has('locale/change')).toBe(true)
    ctx.handlers.get('locale/change')!()
    expect(card.querySelector('.xcc-kind')!.textContent).toBe('Cross-Chat Message')
    expect(more.textContent).toBe('Expand')

    // 切换后点击仍按当前语言出文案
    more.click()
    expect(more.textContent).toBe('Collapse')
  })
  it('embeds images from the default row into the gray card', () => {
    const holder = buildExpandedRelayRow(
      '[跨会话消息 · 来自 我的开场白 (session-abc-123)]\n\n看图',
      '来自会话 session-abc-123',
    )
    const pre = holder.querySelector('[data-context-text]')!
    const img = new FakeEl('img')
    img.attrs.set('src', 'blob:photo-1')
    img.attrs.set('alt', '图')
    pre.append(img)
    doc.body.append(holder)
    apply(stubCtx('zh') as never)
    const scan = FakeMutationObserver.last!.callback
    scan()
    const card = holder.children[0]!
    const containers = card.querySelectorAll('.xcc-images')
    expect(containers).toHaveLength(1)
    const images = containers[0]!.querySelectorAll('img')
    expect(images).toHaveLength(1)
    expect(images[0]!.attrs.get('src')).toBe('blob:photo-1')
  })
})
