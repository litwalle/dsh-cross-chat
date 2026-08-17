# dsh-cross-chat

**Give DeepSeek Harness agents Claude Code / Codex-style autonomy**: create their own conversations and message each other across sessions.

> [简体中文](./README.zh-CN.md)

## Positioning

Claude Code and Codex agents can open new conversations and pass messages between them, splitting a big task into parallel sessions. DeepSeek Harness lacked this — sessions were islands, and an agent could never leave its own chat.

`dsh-cross-chat` adds that layer with 4 model tools. A "coordinator" session can now spin up "worker" sessions, delegate work, and read their replies — one agent, working like a team.

## Capabilities

| Tool | What it does |
|---|---|
| `list_sessions` | List other messageable sessions (id, label, cwd, busy); optional fuzzy filter by id or label |
| `send_session_message` | Deliver a message to another session and wake its agent (queues if the target is busy); supports images and files |
| `read_session` | Read the target session's recent user/assistant messages (default 20, max 50) |
| `create_session` | Create a new top-level conversation (same path as the GUI "+"), with optional title and first message |

**Adaptive image delivery** — image capability is probed before sending: vision-capable models get native image blocks; text-only models (e.g. the official DeepSeek adapter) get the file delivered to their workspace with a path note. Text-only targets never crash on image content.

**Full round-trip** — delivered messages carry provenance and render as a gray card in the receiver's GUI (sender name, expand/collapse). The receiving agent replies with the same tools.

## Install

One command, the official DSH plugin way (`dsh plugin` forwards to pnpm in your profile):

```bash
dsh plugin --profile web add github:litwalle/dsh-cross-chat
```

Then restart `dsh web` (kill the running `dsh web` process and start it again).

The built `lib/` output is committed to this repo, so install-from-Git works without a build step. To build from source instead: `pnpm install && pnpm run build`.

## Configuration

Overridable in your profile's `cordis.patch.yml`:

| Key | Default | Notes |
|---|---|---|
| `attribution` | `'prefix'` | Prepends `[跨会话消息 · 来自 <name>]` to the message body; `'none'` disables |
| `maxMessageChars` | `4000` | Max characters per message |
| `maxReadMessages` | `50` | Max `limit` for `read_session` |

## Limitations

- Only live sessions in the same process (conversations open in the current Web GUI) are discoverable.
- Text-only models receive images as workspace files with a path note; the receiver needs vision/file tools to actually "see" them.

## License

MIT
