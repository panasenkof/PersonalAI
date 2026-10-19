import * as Crypto from "expo-crypto";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { DirectChatStore } from "./chat-store";
import { diagnosticTrace } from "./diagnostics";
import { normalizeDraft } from "./normalize-draft";
import type { DirectAgentSettings } from "./settings";

type DraftStore = Pick<DirectChatStore, "getSnapshot" | "subscribe" | "setQuestion">;
const IDLE = { busy: false, alternate: false, normalized: false };
function currentDraft(store: DraftStore) {
  const state = store.getSnapshot();
  const conversation = state.conversations.find(c => c.id === state.activeId);
  return { id: state.activeId, text: conversation?.question || "", usable: state.ready && Boolean(conversation && !conversation.deleting) };
}

/** Undo belongs to one unchanged draft. A synchronous store subscription also
 * detects edit-then-revert and switch-away-then-back before React renders. */
export function useDraftNormalization(store: DraftStore, profile: string | null, notice: (text: string) => void) {
  const [state, setState] = useState(IDLE);
  const request = useRef<AbortController | null>(null);
  const versions = useRef<{ id: string; original: string; normalized: string } | null>(null);
  const writing = useRef(false);
  const reset = useCallback(() => {
    request.current?.abort(); request.current = null;
    versions.current = null; setState(IDLE);
  }, []);

  useLayoutEffect(() => {
    let observed = currentDraft(store);
    setState(IDLE);
    const unsubscribe = store.subscribe(() => {
      const next = currentDraft(store);
      const changed = next.id !== observed.id || next.text !== observed.text || next.usable !== observed.usable;
      observed = next;
      if (changed && !writing.current) reset();
    });
    return () => {
      unsubscribe(); request.current?.abort(); request.current = null; versions.current = null;
    };
  }, [store, reset]);

  const toggle = async (settings: DirectAgentSettings | null) => {
    if (request.current) { reset(); return; }
    const draft = currentDraft(store);
    if (!draft.id || !draft.usable || !draft.text.trim()) return;
    const pair = versions.current;
    if (pair && pair.id === draft.id && (draft.text === pair.original || draft.text === pair.normalized)) {
      const normalized = draft.text === pair.original;
      writing.current = true;
      try { store.setQuestion(normalized ? pair.normalized : pair.original); }
      finally { writing.current = false; }
      setState({ busy: false, alternate: true, normalized }); notice(""); return;
    }
    if (!settings || !profile) { notice("Выберите подключение LLM в настройках."); return; }
    const aborter = new AbortController(); request.current = aborter;
    setState({ busy: true, alternate: false, normalized: false }); notice("");
    const trace = diagnosticTrace(profile, draft.id, Crypto.randomUUID());
    try {
      const text = await normalizeDraft(settings, draft.text, { signal: aborter.signal, diagnostic: trace });
      const current = currentDraft(store);
      if (request.current !== aborter || aborter.signal.aborted || !current.usable || current.id !== draft.id || current.text !== draft.text) return;
      if (text === draft.text) { setState(IDLE); notice("Текст уже в порядке — исправления не потребовались."); return; }
      versions.current = { id: draft.id, original: draft.text, normalized: text };
      writing.current = true;
      try { store.setQuestion(text); }
      finally { writing.current = false; }
      setState({ busy: false, alternate: true, normalized: true });
    } catch (error) {
      if (request.current === aborter && !aborter.signal.aborted) {
        setState(IDLE); notice("Не удалось улучшить текст. " + (error as Error).message);
      }
    } finally { if (request.current === aborter) request.current = null; }
  };
  return { ...state, toggle, reset };
}
