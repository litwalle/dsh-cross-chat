/**
 * The `create_session` tool: create a real top-level conversation through
 * the host API gateway — the same path the GUI's "+" button uses — then
 * optionally title it and send a first prompt so it starts working and
 * appears in the sidebar.
 *
 * @module @dsh-external/dsh-cross-chat/create-session
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RpcId, type ApiProxy, type RpcResult, type WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy'
import type { Config } from './index.ts'

const CREATE_TOOL_NAME = 'create_session'

/** Unwrap an rpc envelope, translating business errors into thrown tool errors. */
function unwrap<T>(result: RpcResult<T>, prefix: string, sessionHint: string): T {
  if (result.ok) return result.value
  const suffix = sessionHint === '' ? '' : `（会话 ${sessionHint}）`
  throw new Error(`${prefix}: ${result.error.code}: ${result.error.message}${suffix}`)
}

/**
 * Canonicalize a directory the way the workspace registry does (`fs.realpath`:
 * symlinks, `..`, and trailing slashes resolved), falling back to an absolute
 * spelling when the path does not exist yet (a brand-new cwd can never match a
 * workspace record, so the fallback only ever yields `undefined`).
 */
async function canonicalDirectory(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return isAbsolute(path) ? path : resolve(path)
  }
}

/**
 * Build the `create_session` tool. `apiProxy` resolves optionally: profiles
 * without the API gateway (e.g. headless) fail with API_PROXY_UNAVAILABLE,
 * and the other three tools are unaffected.
 */
export function createSessionTool(ctx: Context, config: Config) {
  return defineTool({
    name: CREATE_TOOL_NAME,
    description:
      '新建一个顶层对话（与 GUI 新建对话相同）。可选 cwd（默认用你所在会话的工作目录）、'
      + 'title（标题）、first_message（开场消息：发送后新会话立即开始工作并出现在侧边栏；'
      + '不传则创建空白会话，直到收到第一条消息才可见）。若 cwd 属于某个已注册工作区，'
      + '新会话会挂入该工作区分组（否则落入「未分组」）。返回的 session_id 可用于 '
      + 'send_session_message / read_session 与其通信；新会话的 agent 也有同样的工具，可以回你消息。',
    parameters: {
      cwd: {
        type: 'string',
        description: '新会话的工作目录；缺省为调用者会话的 cwd。属于已注册工作区时自动挂入对应分组。',
      },
      title: {
        type: 'string',
        description: '可选会话标题；不传则沿用自动标题。',
      },
      first_message: {
        type: 'string',
        description: `可选开场消息（不超过 ${config.maxMessageChars} 字符）；发送后会话立即开工并出现在侧边栏。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          title: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          first_message_sent: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已创建会话 ${value.session_id}${value.title === null ? '' : `（标题：${value.title}）`}。`
          + (value.first_message_sent
            ? '开场消息已发送，该会话已开始工作并出现在侧边栏。'
            : '未发送开场消息：该会话暂为空白，在侧边栏隐藏，收到第一条消息后可见。')
          + '后续用 send_session_message 给它发消息、read_session 读它的回复；它也可以主动回你消息。',
      }],
    },
    async execute(args, exec) {
      const self = exec.agent
      if (!self) throw new Error('create_session 需要调用方 agent（exec.agent 未定义）')
      const api = ctx.get('apiProxy') as ApiProxy | undefined
      if (!api) {
        throw new Error('API_PROXY_UNAVAILABLE: 当前 DSH 未启用 API 网关，无法创建新会话（其余跨对话工具不受影响）。')
      }
      const firstMessage = args.first_message?.trim() === '' ? undefined : args.first_message
      if (firstMessage !== undefined && firstMessage.length > config.maxMessageChars) {
        throw new Error(`MESSAGE_TOO_LONG: 开场消息共 ${firstMessage.length} 字符，超过上限 ${config.maxMessageChars}。`)
      }
      const cwd = args.cwd ?? self.session.header.cwd

      /**
       * Resolve the workspace owning `cwd` (canonical path comparison) so the
       * new session attaches to that workspace group instead of landing in the
       * sidebar's ungrouped bucket. `session.create` accepts at most one of
       * `workspaceId` / `cwd`; when the owning workspace exists we send the id
       * (the server then derives the directory from the workspace record and
       * attaches the session), otherwise we fall back to a plain `cwd` create.
       * A workspace baseline failure never blocks creation: the fallback keeps
       * the tool usable, matching the pre-workspace behavior.
       */
      const workspaceIdFor = async (directory: string): Promise<WorkspaceId | undefined> => {
        const canonical = await canonicalDirectory(directory)
        try {
          const listed = await api.workspace.list({ rpcId: RpcId(randomUUID()), payload: {} })
          const workspaces = unwrap(listed.result, 'WORKSPACE_LIST_FAILED', '').items
          return workspaces.find((workspace) => workspace.path === canonical)?.workspaceId
        } catch {
          return undefined
        }
      }

      const payload: { cwd?: string; workspaceId?: WorkspaceId } = {}
      if (cwd !== undefined) {
        const ownerId = await workspaceIdFor(cwd)
        if (ownerId !== undefined) payload.workspaceId = ownerId
        else payload.cwd = cwd
      }

      const created = await api.sessions.create({ rpcId: RpcId(randomUUID()), payload })
      const sessionId = unwrap(created.result, 'CREATE_FAILED', '').sessionId

      let title: string | null = null
      if (args.title !== undefined) {
        const renamed = await api.sessions.rename({ rpcId: RpcId(randomUUID()), payload: { sessionId, title: args.title } })
        title = unwrap(renamed.result, 'RENAME_FAILED', sessionId).title
      }
      if (firstMessage !== undefined) {
        const prompted = await api.sessions.prompt({
          rpcId: RpcId(randomUUID()),
          payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: firstMessage }] },
        })
        unwrap(prompted.result, 'PROMPT_FAILED', sessionId)
      }
      return {
        session_id: sessionId,
        title,
        first_message_sent: firstMessage !== undefined,
      }
    },
  })
}
