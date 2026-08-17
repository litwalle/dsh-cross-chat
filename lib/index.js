import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
//#region src/relay.ts
/**
* Cross-chat relay core: the message source kind that triggers the GUI's
* built-in relay card rendering, plus pure helpers for sender labels and
* message construction.
*
* @module @dsh-external/dsh-cross-chat/relay
*/
/** This plugin's loader id. */
const PLUGIN_ID = "dsh-cross-chat";
/** Narrow a message source to the cross-chat relay kind. */
function isCrossRelay(source) {
	return source.kind === "dsh-cross-relay";
}
/** The first text block of a message, or null. */
function firstTextBlock(message) {
	for (const block of message.content) if (block.type === "text") return block.text;
	return null;
}
/**
* A human/model-facing label for a session: the last user/assistant text
* message, whitespace-collapsed and truncated; falls back to the session id.
*/
function sessionLabel(session, maxChars = 60) {
	for (const message of [...session.deriveMessages()].reverse()) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = firstTextBlock(message);
		if (text === null || text.trim() === "") continue;
		const flat = text.replace(/\s+/g, " ").trim();
		return flat.length > maxChars ? flat.slice(0, maxChars - 1) + "…" : flat;
	}
	return session.id;
}
/**
* Build the identified user message delivered to the target session.
* `attribution: 'prefix'` prepends one attribution line so the receiving
* MODEL knows who sent it (the GUI card is for humans only). `senderTitle`
* is the resolved session title and wins over the label when non-blank.
*/
function buildRelayMessage(sender, text, attribution, senderTitle) {
	const title = senderTitle !== void 0 && senderTitle.trim() !== "" ? senderTitle.trim() : void 0;
	const label = title ?? sessionLabel(sender.session);
	const body = attribution === "prefix" ? `[跨会话消息 · 来自 ${label} (${sender.id})]\n\n${text}` : text;
	return createUserMessage({
		content: [{
			type: "text",
			text: body
		}],
		source: {
			kind: "dsh-cross-relay",
			plugin: PLUGIN_ID,
			form: "relay",
			senderSessionId: sender.id,
			senderLabel: sessionLabel(sender.session),
			...title === void 0 ? {} : { senderTitle: title }
		}
	});
}
const EXT_MEDIA = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif"
};
/** Map a file path to a supported image media type, or null. */
function mediaTypeForPath(filePath) {
	return EXT_MEDIA[path.extname(filePath).toLowerCase()] ?? null;
}
/** A clean basename, or null for empty/dot/dotdot/root-only paths. */
function safeBasename(filePath) {
	const base = path.basename(filePath);
	if (base === "" || base === "." || base === "..") return null;
	return base;
}
/** Conservative attachment limits when the host projection is unavailable. */
const DEFAULT_LIMITS = {
	maxImageBytes: 20971520,
	maxImagesPerMessage: 5,
	maxMessageImageBytes: 20971520,
	maxImagePixels: 4e7,
	mediaTypes: [
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif"
	]
};
/** Best-effort host attachment limits from the apiProxy session-list projection. */
async function resolveImageLimits(ctx) {
	const api = ctx.get?.("apiProxy");
	if (!api) return DEFAULT_LIMITS;
	try {
		const res = await api.sessions.list({
			rpcId: RpcId(randomUUID()),
			payload: {}
		});
		if (!res.result.ok) return DEFAULT_LIMITS;
		return (res.result.value.items[0]?.projections?.values)?.imageLimits ?? DEFAULT_LIMITS;
	} catch {
		return DEFAULT_LIMITS;
	}
}
/** Read one image file and build the attachment save request. */
async function readImageRequest(filePath, limits) {
	let data;
	try {
		data = await readFile(filePath);
	} catch {
		throw new Error(`IMAGE_READ_FAILED: 无法读取图片 ${filePath}`);
	}
	if (data.byteLength > limits.maxImageBytes) throw new Error(`IMAGE_READ_FAILED: 图片 ${filePath} 超过 ${limits.maxImageBytes} 字节上限`);
	const mediaType = mediaTypeForPath(filePath);
	if (mediaType === null) throw new Error("IMAGE_INVALID: 仅支持 png/jpeg/webp/gif");
	const name = safeBasename(filePath) ?? void 0;
	return {
		data,
		mediaType,
		...name === void 0 ? {} : { name }
	};
}
/** Resolve a non-colliding write target for `basename` under `targetDir`. */
async function dedupeTargetPath(targetDir, basename) {
	const ext = path.extname(basename);
	const stem = basename.slice(0, basename.length - ext.length);
	let candidate = path.join(targetDir, basename);
	for (let n = 1; n < 1e3; n++) try {
		await readFile(candidate);
		candidate = path.join(targetDir, `${stem}-${n}${ext}`);
	} catch {
		return candidate;
	}
	return candidate;
}
/**
* Whether a resolved model's declared input modalities accept image content.
* DeepSeek's chat-completions adapter always declares `['text']`, so this is
* the capability gate that keeps `image_paths` from breaking a text-only
* receiving session.
*/
function acceptsImage(modalities) {
	return modalities?.includes("image") === true;
}
/**
* Deliver files into `targetCwd` (deduped) and return one note line per file.
* Shared by `file_paths` and the image→file fallback used when the target
* model cannot ingest image content; `readErrorPrefix` keeps the error
* vocabulary of the feature that triggered the read (IMAGE_* vs FILE_*).
*/
async function deliverFiles(targetCwd, paths, kind, readErrorPrefix) {
	const lines = [];
	for (const p of paths) {
		const base = safeBasename(p);
		if (base === null) throw new Error(`${readErrorPrefix}_READ_FAILED: 非法文件名 ${p}`);
		let data;
		try {
			data = await readFile(p);
		} catch {
			throw new Error(`${readErrorPrefix}_READ_FAILED: 无法读取文件 ${p}`);
		}
		const dest = await dedupeTargetPath(targetCwd, base);
		await writeFile(dest, data);
		lines.push(`📎 ${kind}（已投递到对方工作区）：${base}（${data.byteLength} 字节）`);
	}
	return lines;
}
//#endregion
//#region src/tools.ts
const LIST_TOOL_NAME = "list_sessions";
/** 发送方会话标题缓存（sessionId → title，上限 200）。 */
const TITLE_CACHE = /* @__PURE__ */ new Map();
const TITLE_CACHE_MAX = 200;
/**
* Build the `list_sessions` tool: enumerate live sessions the caller may
* message, each with an id the send tool accepts.
*/
function listSessionsTool(ctx) {
	return defineTool({
		name: LIST_TOOL_NAME,
		description: "列出当前可发消息的其他会话（除你所在的会话外）。返回每个会话的 session_id、标签（最近一条消息的前 60 字符）、工作目录与是否正在运行；用返回的 session_id 配合 send_session_message 发消息。可选 filter 按 id 或标签模糊过滤。",
		parameters: { filter: {
			type: "string",
			description: "可选：按 session_id 或标签不区分大小写模糊过滤。"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { sessions: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							session_id: {
								type: "string",
								required: true
							},
							label: {
								type: "string",
								required: true
							},
							cwd: {
								type: "string",
								required: true
							},
							busy: {
								type: "boolean",
								required: true
							}
						}
					}
				} }
			},
			render: (_args, value) => {
				if (value.sessions.length === 0) return [{
					type: "text",
					text: "没有其他会话（可能还没有第二个对话，或全部被 filter 过滤）。"
				}];
				const lines = value.sessions.map((s) => `- ${s.label} — 会话 ${s.session_id}（cwd: ${s.cwd}，${s.busy ? "运行中" : "空闲"}）`);
				return [{
					type: "text",
					text: `可发消息的会话（${value.sessions.length} 个）：\n${lines.join("\n")}`
				}];
			}
		},
		async execute(args, exec) {
			const self = exec.agent;
			if (!self) throw new Error("list_sessions 需要调用方 agent（exec.agent 未定义）");
			const needle = args.filter?.trim().toLowerCase() ?? "";
			return { sessions: ctx.agents.list().filter((a) => a.id !== self.id).map((a) => ({
				session_id: a.id,
				label: sessionLabel(a.session),
				cwd: a.session.header.cwd ?? "",
				busy: a.status === "running"
			})).filter((c) => needle === "" || c.session_id.toLowerCase().includes(needle) || c.label.toLowerCase().includes(needle)) };
		}
	});
}
const SEND_TOOL_NAME = "send_session_message";
/**
* Decide how `image_paths` should reach the target: native image content
* blocks only when the target model declares image input; every other case
* (text-only model, unknown capability, llm service unavailable) falls back
* to workspace-file delivery so a text-only target can still see the picture
* through vision tools instead of failing its next model call with
* UNSUPPORTED_CONTENT (the DeepSeek chat-completions adapter is text-only).
*/
async function resolveImageDelivery(ctx, target) {
	const provider = target.options?.provider;
	const model = target.options?.model;
	const llm = ctx.get?.("llm");
	if (llm === void 0 || provider === void 0 || provider === "" || model === void 0 || model === "") return "files";
	try {
		return acceptsImage((await llm.resolveModelInfo(provider, model)).inputModalities) ? "blocks" : "files";
	} catch {
		return "files";
	}
}
/**
* Build the `send_session_message` tool: deliver one message to another live
* session and wake its agent (`Agent.followup`). Failures are explicit tool
* errors, never silent.
*/
function sendSessionMessageTool(ctx, config) {
	return defineTool({
		name: SEND_TOOL_NAME,
		description: "给另一个会话发消息：消息会成为目标会话 agent 的下一轮输入并叫醒它（目标正在运行时消息排队，等其当前轮结束）。目标须是 list_sessions 列出的活会话。本调用不返回对方的回复；想看结果用 read_session。",
		parameters: {
			session_id: {
				type: "string",
				required: true,
				description: "目标会话 id（来自 list_sessions）。"
			},
			message: {
				type: "string",
				required: true,
				description: `要发送的消息正文，不超过 ${config.maxMessageChars} 字符。`
			},
			image_paths: {
				type: "array",
				items: { type: "string" },
				description: `可选：要随消息发送的图片路径（png/jpeg/webp/gif，最多 5 张），相对发送方工作目录或绝对路径。目标模型支持图片时以图片内容投递；目标模型为纯文本时自动作为文件投递到对方工作区并附路径说明。`
			},
			file_paths: {
				type: "array",
				items: { type: "string" },
				description: `可选：要投递到目标会话工作区的文件路径（最多 10 个），消息会附带路径说明。`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					delivered: {
						type: "boolean",
						required: true
					},
					session_id: {
						type: "string",
						required: true
					},
					queued: {
						type: "boolean",
						required: true
					},
					image_delivery: {
						type: "string",
						required: true,
						enum: [
							"none",
							"blocks",
							"files"
						]
					}
				}
			},
			render: (_args, value) => {
				const imageNote = value.image_delivery === "files" ? " 图片已作为文件投递到对方工作区（目标模型不支持图片输入），对方可用视觉工具查看。" : value.image_delivery === "blocks" ? " 图片已以图片内容投递，对方可直接查看。" : "";
				return [{
					type: "text",
					text: (value.queued ? `已把消息投递给会话 ${value.session_id}（对方正在运行，消息已排队，将在其当前轮结束后成为下一轮输入）。本次调用不返回对方的回复；想看结果用 read_session。` : `已把消息投递给会话 ${value.session_id}，对方将被叫醒开始新的一轮回复。本次调用不返回对方的回复；想看结果用 read_session。`) + imageNote
				}];
			}
		},
		async execute(args, exec) {
			const self = exec.agent;
			if (!self) throw new Error("send_session_message 需要调用方 agent（exec.agent 未定义）");
			const target = ctx.agents.get(SessionId(args.session_id));
			if (!target) throw new Error(`SESSION_NOT_FOUND: 会话 ${args.session_id} 当前不在线。用 list_sessions 查看当前可发消息的会话。`);
			if (target.id === self.id) throw new Error("SELF_SEND_REJECTED: 不能给自己所在的会话发消息。");
			if (args.message.length > config.maxMessageChars) throw new Error(`MESSAGE_TOO_LONG: 消息共 ${args.message.length} 字符，超过上限 ${config.maxMessageChars}。`);
			const queued = target.status === "running";
			const senderTitle = await resolveSenderTitle(ctx, self.id);
			const images = args.image_paths ?? [];
			if (images.length > 5) throw new Error(`IMAGE_TOO_MANY: 图片最多 5 张。`);
			const imageDelivery = images.length === 0 ? "none" : await resolveImageDelivery(ctx, target);
			const imageBlocks = [];
			if (images.length > 0 && imageDelivery === "blocks") {
				const api = ctx.get?.("attachments");
				if (!api) throw new Error("ATTACHMENT_UNAVAILABLE: 当前 DSH 未启用附件服务，无法发送图片");
				const limits = await resolveImageLimits(ctx);
				for (const p of images) {
					const request = await readImageRequest(p, limits);
					imageBlocks.push({
						type: "image",
						attachment: await api.saveImage(request)
					});
				}
			}
			let text = args.message;
			const files = args.file_paths ?? [];
			if (files.length > 10) throw new Error(`FILE_TOO_MANY: 文件最多 10 个。`);
			if (files.length > 0) {
				const targetCwd = target.session.header.cwd;
				if (targetCwd === void 0) throw new Error("FILE_TARGET_NO_CWD: 目标会话没有工作目录，无法投递文件");
				const lines = await deliverFiles(targetCwd, files, "文件", "FILE");
				if (lines.length > 0) text = `${text}\n\n${lines.join("\n")}`;
			}
			if (images.length > 0 && imageDelivery === "files") {
				const targetCwd = target.session.header.cwd;
				if (targetCwd === void 0) throw new Error("IMAGE_TARGET_NO_CWD: 目标会话没有工作目录，无法以文件方式投递图片");
				for (const p of images) if (mediaTypeForPath(p) === null) throw new Error("IMAGE_INVALID: 仅支持 png/jpeg/webp/gif");
				const lines = await deliverFiles(targetCwd, images, "图片", "IMAGE");
				if (lines.length > 0) text = `${text}\n\n${lines.join("\n")}\n（图片未作为图片内容投递：目标模型不支持图片输入，请用视觉工具或直接读取文件查看）`;
			}
			const msg = buildRelayMessage(self, text, config.attribution, senderTitle);
			if (imageBlocks.length > 0) target.followup(createUserMessage({
				content: [...msg.content, ...imageBlocks],
				source: msg.source
			}));
			else target.followup(msg);
			return {
				delivered: true,
				session_id: target.id,
				queued,
				image_delivery: imageDelivery
			};
		}
	});
}
/**
* Resolve the sender session's title through the API gateway, cached by
* session id. Failures (absent apiProxy, rpc error, missing/blank title) are
* never cached and fall back to the label.
*/
async function resolveSenderTitle(ctx, senderId) {
	const cached = TITLE_CACHE.get(senderId);
	if (cached !== void 0) return cached;
	try {
		const api = ctx.get?.("apiProxy");
		if (!api) return void 0;
		const res = await api.sessions.list({
			rpcId: RpcId(randomUUID()),
			payload: {}
		});
		if (!res.result.ok) return void 0;
		const title = (res.result.value.items.find((it) => it.sessionId === senderId)?.projections?.values)?.title;
		if (title === void 0 || title === null || title.trim() === "") return void 0;
		if (TITLE_CACHE.size >= TITLE_CACHE_MAX) TITLE_CACHE.clear();
		TITLE_CACHE.set(senderId, title.trim());
		return title.trim();
	} catch {
		return;
	}
}
const READ_TOOL_NAME = "read_session";
/** 单条消息渲染时的展示截断长度。 */
const READ_ENTRY_RENDER_MAX = 2e3;
/** Collect the most recent readable entries from a session log. */
function pickRecentEntries(session, limit) {
	const collected = [];
	for (const message of [...session.deriveMessages()].reverse()) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		if (message.role === "user" && message.content.every((block) => block.type === "tool-result")) continue;
		const text = firstTextBlock(message);
		if (text === null) continue;
		collected.unshift({
			role: message.role,
			from: message.role === "user" && isCrossRelay(message.source) ? message.source.senderSessionId : null,
			text
		});
	}
	const omitted = Math.max(0, collected.length - limit);
	return {
		entries: collected.slice(Math.max(0, collected.length - limit)),
		omitted
	};
}
/**
* Build the `read_session` tool: read the most recent user/assistant messages
* of another live session (folded surface, so compacted history stays hidden).
*/
function readSessionTool(ctx, config) {
	return defineTool({
		name: READ_TOOL_NAME,
		description: `读取另一个会话最近的消息（默认 20 条，最多 ${config.maxReadMessages} 条），用于查看对方对你消息的回复。返回角色标记的文本；跨会话消息会标注发送方 session id。`,
		parameters: {
			session_id: {
				type: "string",
				required: true,
				description: "目标会话 id（来自 list_sessions）。"
			},
			limit: {
				type: "integer",
				description: `要读的最近消息条数，默认 20，上限 ${config.maxReadMessages}。`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					session_id: {
						type: "string",
						required: true
					},
					entries: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								role: {
									type: "string",
									required: true,
									enum: ["user", "assistant"]
								},
								from: {
									oneOf: [{ type: "string" }, { type: "null" }],
									required: true
								},
								text: {
									type: "string",
									required: true
								}
							}
						}
					},
					omitted: {
						type: "integer",
						required: true
					}
				}
			},
			render: (_args, value) => {
				if (value.entries.length === 0) return [{
					type: "text",
					text: `会话 ${value.session_id} 没有可读的 user/assistant 消息。`
				}];
				const lines = value.entries.map((e) => {
					const shown = e.text.length > READ_ENTRY_RENDER_MAX ? e.text.slice(0, 1999) + "…" : e.text;
					return `[${e.from !== null ? `来自 ${e.from}` : e.role}] ${shown}`;
				});
				const tail = value.omitted > 0 ? `\n（更早的 ${value.omitted} 条省略）` : "";
				return [{
					type: "text",
					text: `会话 ${value.session_id} 最近 ${value.entries.length} 条消息：\n${lines.join("\n")}${tail}`
				}];
			}
		},
		async execute(args, exec) {
			const target = ctx.agents.get(SessionId(args.session_id));
			if (!target) throw new Error(`SESSION_NOT_FOUND: 会话 ${args.session_id} 当前不在线。用 list_sessions 查看当前可发消息的会话。`);
			const limit = Math.min(Math.max(1, args.limit ?? 20), config.maxReadMessages);
			const picked = pickRecentEntries(target.session, limit);
			return {
				session_id: target.id,
				entries: picked.entries,
				omitted: picked.omitted
			};
		}
	});
}
//#endregion
//#region src/create-session.ts
const CREATE_TOOL_NAME = "create_session";
/** Unwrap an rpc envelope, translating business errors into thrown tool errors. */
function unwrap(result, prefix, sessionHint) {
	if (result.ok) return result.value;
	const suffix = sessionHint === "" ? "" : `（会话 ${sessionHint}）`;
	throw new Error(`${prefix}: ${result.error.code}: ${result.error.message}${suffix}`);
}
/**
* Build the `create_session` tool. `apiProxy` resolves optionally: profiles
* without the API gateway (e.g. headless) fail with API_PROXY_UNAVAILABLE,
* and the other three tools are unaffected.
*/
function createSessionTool(ctx, config) {
	return defineTool({
		name: CREATE_TOOL_NAME,
		description: "新建一个顶层对话（与 GUI 新建对话相同）。可选 cwd（默认用你所在会话的工作目录）、title（标题）、first_message（开场消息：发送后新会话立即开始工作并出现在侧边栏；不传则创建空白会话，直到收到第一条消息才可见）。返回的 session_id 可用于 send_session_message / read_session 与其通信；新会话的 agent 也有同样的工具，可以回你消息。",
		parameters: {
			cwd: {
				type: "string",
				description: "新会话的工作目录；缺省为调用者会话的 cwd。"
			},
			title: {
				type: "string",
				description: "可选会话标题；不传则沿用自动标题。"
			},
			first_message: {
				type: "string",
				description: `可选开场消息（不超过 ${config.maxMessageChars} 字符）；发送后会话立即开工并出现在侧边栏。`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					session_id: {
						type: "string",
						required: true
					},
					title: {
						oneOf: [{ type: "string" }, { type: "null" }],
						required: true
					},
					first_message_sent: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `已创建会话 ${value.session_id}${value.title === null ? "" : `（标题：${value.title}）`}。` + (value.first_message_sent ? "开场消息已发送，该会话已开始工作并出现在侧边栏。" : "未发送开场消息：该会话暂为空白，在侧边栏隐藏，收到第一条消息后可见。") + "后续用 send_session_message 给它发消息、read_session 读它的回复；它也可以主动回你消息。"
			}]
		},
		async execute(args, exec) {
			const self = exec.agent;
			if (!self) throw new Error("create_session 需要调用方 agent（exec.agent 未定义）");
			const api = ctx.get("apiProxy");
			if (!api) throw new Error("API_PROXY_UNAVAILABLE: 当前 DSH 未启用 API 网关，无法创建新会话（其余跨对话工具不受影响）。");
			const firstMessage = args.first_message?.trim() === "" ? void 0 : args.first_message;
			if (firstMessage !== void 0 && firstMessage.length > config.maxMessageChars) throw new Error(`MESSAGE_TOO_LONG: 开场消息共 ${firstMessage.length} 字符，超过上限 ${config.maxMessageChars}。`);
			const cwd = args.cwd ?? self.session.header.cwd;
			const payload = {};
			if (cwd !== void 0) payload.cwd = cwd;
			const sessionId = unwrap((await api.sessions.create({
				rpcId: RpcId(randomUUID()),
				payload
			})).result, "CREATE_FAILED", "").sessionId;
			let title = null;
			if (args.title !== void 0) title = unwrap((await api.sessions.rename({
				rpcId: RpcId(randomUUID()),
				payload: {
					sessionId,
					title: args.title
				}
			})).result, "RENAME_FAILED", sessionId).title;
			if (firstMessage !== void 0) unwrap((await api.sessions.prompt({
				rpcId: RpcId(randomUUID()),
				payload: {
					sessionId,
					mode: "queue",
					content: [{
						type: "text",
						text: firstMessage
					}]
				}
			})).result, "PROMPT_FAILED", sessionId);
			return {
				session_id: sessionId,
				title,
				first_message_sent: firstMessage !== void 0
			};
		}
	});
}
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "dsh-cross-chat";
/** Required services: tool registry + live agent/session registries. */
const inject = [
	"tools",
	"agents",
	"sessions"
];
/** Schemastery configuration validated by the Loader. */
const Config = z.object({
	attribution: z.union(["prefix", "none"]).default("prefix"),
	maxMessageChars: z.natural().default(4e3),
	maxReadMessages: z.natural().default(50)
});
/**
* Register the four cross-chat tools.
* @param ctx - registrant context.
* @param config - validated deployment configuration.
*/
function apply(ctx, config) {
	ctx.tools.register(listSessionsTool(ctx));
	ctx.tools.register(sendSessionMessageTool(ctx, config));
	ctx.tools.register(readSessionTool(ctx, config));
	ctx.tools.register(createSessionTool(ctx, config));
}
//#endregion
export { Config, apply, inject, name };
