window.__ModuleLoader__.load({
	id: "dsh-cross-chat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/card.ts
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
		function parseSenderLine(line) {
			const m = /^\[跨(?:对话|会话)消息 · 来自 (.+?) \(([^()]+)\)\]$/.exec(line.trim());
			if (m === null) return null;
			const label = m[1].trim();
			const id = m[2].trim();
			if (label === "" || id === "") return null;
			return {
				label,
				id
			};
		}
		/**
		* The session id embedded in the built-in relay sender line rendered by the
		* host UI: `来自会话 <id>` (zh) / `From session <id>` (en). The
		* `data-context-relay-sender` element itself only carries a boolean marker, so
		* the id must be read from its text.
		*/
		function senderIdFromRelayLine(line) {
			const m = /^(?:来自会话|From session)\s+(\S+)/.exec(line.trim());
			return m === null ? "" : m[1].trim();
		}
		/** Short display form of a session id: first two dash-separated segments. */
		function shortId(id) {
			return id.split("-").slice(0, 2).join("-");
		}
		/** Escape HTML special characters for safe text insertion. */
		function escapeHtml(text) {
			return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
		}
		/** 按界面语言 id 返回右上角标签文案。 */
		function kindLabelFor(localeId) {
			return localeId.toLowerCase().startsWith("en") ? "Cross-Chat Message" : "跨对话消息";
		}
		/** 按界面语言 id 与展开状态返回按钮文案。 */
		function expandLabel(localeId, expanded) {
			if (expanded) return localeId.toLowerCase().startsWith("en") ? "Collapse" : "收起";
			return localeId.toLowerCase().startsWith("en") ? "Expand" : "展开全部";
		}
		const ICON_SVG = "<svg class=\"xcc-icon\" width=\"15\" height=\"15\" viewBox=\"0 0 16 16\" fill=\"none\" aria-hidden=\"true\"><path d=\"M2.5 4.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H6.2L3.5 14v-3h-.5A1.5 1.5 0 0 1 2.5 9.5v-5Z\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linejoin=\"round\"/><path d=\"M5.5 6h5M5.5 8h3\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/></svg>";
		/**
		* Build the gray card markup. `text` is escaped; `senderName` may be empty
		* (fall back to the short id in the header then). 标签与按钮文案均为纯文案参数
		* （`kindLabel` / `expandText`），由调用方按当前界面语言生成——本函数不做任何
		* 语言判定，保持"纯函数、文案由调用方决定"。
		*/
		function buildCardMarkup(opts) {
			const name = opts.senderName === "" ? shortId(opts.senderId) : opts.senderName;
			return [
				`<div class="xcc-card" data-dsh-cross-chat-card="1">`,
				`  <div class="xcc-head">`,
				`    <div class="xcc-from">${ICON_SVG}<span class="xcc-name" title="${escapeHtml(opts.senderId)}">${escapeHtml(name)}</span></div>`,
				`    <span class="xcc-kind">${escapeHtml(opts.kindLabel)}</span>`,
				`  </div>`,
				`  <p class="xcc-body clamped">${escapeHtml(opts.text)}</p>`,
				opts.extra === void 0 || opts.extra === "" ? "" : `  ${opts.extra}`,
				`  <button class="xcc-more" type="button" hidden>${escapeHtml(opts.expandText)}</button>`,
				`</div>`
			].join("\n");
		}
		//#endregion
		//#region src/client/styles.ts
		/** Inject the gray-card stylesheet once, keyed like the official plugins. */
		function installStyles() {
			const tagId = "dsh-cross-chat/RelayCard.css";
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", tagId);
			tag.textContent = `
.xcc-card {
  width: 100%; box-sizing: border-box;
  border: 1px solid light-dark(#E0E0DC, #3A3A40);
  border-radius: 12px;
  background: light-dark(#EEEEEC, #2A2A2F);
  color: light-dark(#2A2A2E, #E9E9ED);
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
  font-size: 13px;
}
.xcc-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.xcc-from { display: flex; align-items: center; gap: 7px; min-width: 0; }
.xcc-icon { flex: none; color: light-dark(#7C7C84, #A8A8B0); }
.xcc-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.xcc-kind { flex: none; font-size: 11.5px; color: light-dark(#A9A8B0, #77767F); letter-spacing: .03em; white-space: nowrap; }
.xcc-body { font-size: 13.5px; line-height: 1.7; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.xcc-body.clamped { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }
.xcc-more {
  align-self: flex-start; border: 0; background: none; padding: 0; cursor: pointer;
  font-size: 11.5px; font-family: inherit; letter-spacing: .02em;
  color: light-dark(#7C7C84, #A8A8B0);
}
.xcc-more:hover { text-decoration: underline; }
.xcc-images { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
.xcc-images img { max-height: 160px; max-width: 100%; border-radius: 8px; object-fit: cover; display: block; }
`;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/index.tsx
		const name = "dsh-cross-chat";
		const inject = [];
		const CARD_MARK = "data-dsh-cross-chat-card";
		/** Provenance label the host projects for `dsh-cross-relay` sources
		* (contextProvenance default branch: label = source kind). */
		const RELAY_SOURCE_LABEL = "dsh-cross-relay";
		/** 解析当前界面语言 id：locale 服务 → navigator.language → 'zh'。 */
		function resolveLocaleId(ctx) {
			const active = (ctx.get?.("locale"))?.getLocale?.().active;
			if (typeof active === "string" && active !== "") return active;
			return ((typeof navigator !== "undefined" ? navigator.language : "") ?? "").toLowerCase().startsWith("en") ? "en" : "zh";
		}
		/** 更新已挂载卡片的标签与按钮文案（语言切换后调用）。 */
		function updateKindLabels(localeId) {
			for (const card of document.querySelectorAll("[data-dsh-cross-chat-card]")) {
				const kind = card.querySelector(".xcc-kind");
				if (kind !== null) kind.textContent = kindLabelFor(localeId);
				const body = card.querySelector(".xcc-body");
				const more = card.querySelector(".xcc-more");
				if (more !== null && body !== null) more.textContent = expandLabel(localeId, !body.classList.contains("clamped"));
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
		function swapRow(row, getLocaleId) {
			const holder = row.closest("[data-chat-anchor-key]");
			if (holder === null || holder.querySelector(`[${CARD_MARK}]`) !== null) return;
			const contentNode = row.nextElementSibling;
			const text = contentNode === null ? "" : (contentNode.textContent ?? "").trim();
			const firstLine = text.split("\n")[0] ?? "";
			const parsed = parseSenderLine(firstLine);
			const bodyText = parsed === null ? text : text.slice(firstLine.length).trimStart();
			const localeId = getLocaleId();
			const images = contentNode === null ? [] : [...contentNode.querySelectorAll("img")];
			const imageMarkup = images.length === 0 ? "" : `<div class="xcc-images">${images.map((img) => img.outerHTML).join("")}</div>`;
			const html = buildCardMarkup({
				senderName: parsed === null ? "" : parsed.label,
				senderId: parsed === null ? senderIdFromRelayLine(row.textContent ?? "") : parsed.id,
				text: bodyText === "" ? firstLine : bodyText,
				kindLabel: kindLabelFor(localeId),
				expandText: expandLabel(localeId, false),
				extra: imageMarkup
			});
			const wrapper = document.createElement("div");
			wrapper.innerHTML = html;
			const cardEl = wrapper.firstElementChild;
			if (!(cardEl instanceof HTMLElement)) return;
			holder.replaceChildren(cardEl);
			const body = cardEl.querySelector(".xcc-body");
			const more = cardEl.querySelector(".xcc-more");
			if (body instanceof HTMLElement && more instanceof HTMLButtonElement) {
				const measure = () => {
					more.hidden = body.scrollHeight <= body.clientHeight;
				};
				measure();
				if (typeof window !== "undefined") window.addEventListener("resize", measure);
				more.addEventListener("click", () => {
					const clamped = body.classList.toggle("clamped");
					more.textContent = expandLabel(getLocaleId(), !clamped);
				});
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
		function scanOnce(getLocaleId) {
			for (const el of document.querySelectorAll("[data-context-relay-sender]")) try {
				swapRow(el, getLocaleId);
			} catch (err) {
				console.error("[dsh-cross-chat] 替换 relay 行失败:", err);
			}
			for (const el of document.querySelectorAll("[data-context-source]")) try {
				if ((el.textContent ?? "").trim() !== RELAY_SOURCE_LABEL) continue;
				const holder = el.closest("[data-chat-anchor-key]");
				if (holder === null) continue;
				if (holder.querySelector(`[${CARD_MARK}]`) !== null) continue;
				if (holder.querySelector("[data-context-relay-sender]") !== null) continue;
				const disclosure = holder.querySelector("[data-disclosure-row]");
				if (disclosure instanceof HTMLElement) disclosure.click();
			} catch (err) {
				console.error("[dsh-cross-chat] 展开 relay 行失败:", err);
			}
		}
		/** Observe the chat flow for relay rows and swap them in. */
		function apply(ctx) {
			if (typeof document === "undefined") return;
			installStyles();
			let localeId = resolveLocaleId(ctx);
			const getLocaleId = () => localeId;
			const scan = () => scanOnce(getLocaleId);
			new MutationObserver(scan).observe(document.body, {
				childList: true,
				subtree: true
			});
			scan();
			ctx.on?.("locale/change", () => {
				localeId = resolveLocaleId(ctx);
				updateKindLabels(localeId);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
