import type { PaneTerminal } from './paneTerminal';
import { useStore } from '../state/store';

/** The pasted image, if the clipboard holds one and no text. */
export function clipboardImage(data: DataTransfer | null): File | null {
  if (!data || data.getData('text')) return null;
  const item = [...data.items].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  return item?.getAsFile() ?? null;
}

/** Save `image` on the server and paste its path, which agents attach as an image. */
export async function pasteImage(paneId: string, term: PaneTerminal, image: Blob) {
  try {
    const res = await fetch(`/api/panes/${encodeURIComponent(paneId)}/paste-image`, {
      method: 'POST',
      headers: { 'Content-Type': image.type },
      body: image,
    });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const { path } = (await res.json()) as { path: string };
    term.paste(path);
  } catch (e) {
    useStore.getState().showToast(`Image paste failed: ${e instanceof Error ? e.message : e}`, 'error');
  }
}
