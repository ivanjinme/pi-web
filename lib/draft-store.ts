import { composerText, type ComposerPart } from "./composer";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  parts: ComposerPart[];
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    parts: draft.parts.map((part) => ({ ...part })),
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !composerText(draft.parts) && draft.images.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}
