/** Inject the gray-card stylesheet once, keyed like the official plugins. */
export function installStyles(): void {
  const tagId = '@dsh-external/dsh-cross-chat/RelayCard.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', tagId)
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
`
  document.head.appendChild(tag)
}
