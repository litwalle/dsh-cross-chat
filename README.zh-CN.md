# dsh-cross-chat

**让 DeepSeek Harness 的 agent 拥有 Claude Code / Codex 式的自主协作能力**：自己创建对话，并在不同对话之间互发消息。

> [English](./README.md)

## 定位

Claude Code 和 Codex 的 agent 可以自己开新对话、在对话之间传消息，把一个大任务拆成多个会话并行推进。DeepSeek Harness 缺这一层——会话之间是孤岛，agent 只能待在自己的对话里。

`dsh-cross-chat` 用 4 个模型工具补上这一层。从此一个"协调者"会话可以拉起多个"执行者"会话、派活、读回它们的回复——一个 agent，像一个团队一样工作。

## 能力

| 工具 | 作用 |
|---|---|
| `list_sessions` | 列出当前可发消息的其他会话（id、标签、工作目录、是否忙碌）；支持按 id 或标签模糊过滤 |
| `send_session_message` | 给目标会话发消息并叫醒它的 agent（目标忙则排队）；支持附带图片和文件 |
| `read_session` | 读取目标会话最近的 user/assistant 消息（默认 20 条，上限 50 条） |
| `create_session` | 新建顶层对话（与 GUI"＋"同路径），可选标题与开场消息 |

**图片自适应投递**——发送前先探测目标模型能力：支持图片输入的模型收到原生图片；纯文本模型（如 DeepSeek 官方适配器）自动改为把图片写入对方工作区并附路径说明，纯文本目标永远不会因图片内容崩溃。

**收发闭环**——消息带来源标记，接收方 GUI 显示自绘灰卡片（发送方名称、展开/收起），接收方 agent 可以用同一套工具回消息。

## 安装

一条命令，走 DSH 官方插件通道（`dsh plugin` 会在你的 profile 里转发给 pnpm）：

```bash
dsh plugin --profile web add github:litwalle/dsh-cross-chat
```

然后重启 `dsh web`（结束正在运行的 `dsh web` 进程再重新启动）。

本仓库已提交构建产物 `lib/`，从 Git 安装无需构建步骤。如要从源码构建：`pnpm install && pnpm run build`。

## 配置

可在 profile 的 `cordis.patch.yml` 中覆盖：

| Key | 默认值 | 说明 |
|---|---|---|
| `attribution` | `'prefix'` | 正文前加 `[跨会话消息 · 来自 <名称>]`；`'none'` 关闭 |
| `maxMessageChars` | `4000` | 单条消息字符上限 |
| `maxReadMessages` | `50` | `read_session` 的 `limit` 上限 |

## 已知限制

- 仅能发现同一进程内活着的会话（当前 Web GUI 中打开的对话）。
- 纯文本模型收到的是工作区文件 + 路径说明，需要对方有视觉/文件工具才能真正"看到"图片。

## License

MIT
