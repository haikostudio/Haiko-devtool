import * as React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { draftHasBullet, toggleBulletInDraft } from "./insert-draft-text";
import type { ComposerFocusInputOptions } from "./types";

interface ComposerInsertContextValue {
  /**
   * Adds `text` to the current draft as its own bullet, or removes that bullet
   * when it is already there, then focuses the message input. Everything else
   * in the draft is left untouched.
   */
  toggleBullet: (text: string) => void;
  /** Subscribes to draft changes; returns the unsubscribe function. */
  subscribeToDraft: (listener: () => void) => () => void;
  /** Reads the draft as it is right now (paired with `subscribeToDraft`). */
  getDraft: () => string;
  /** Lets the composer publish its focus function to this provider. */
  registerFocusInput: (focus: (options?: ComposerFocusInputOptions) => void) => void;
  /**
   * Sends `text` to the agent right away, WITHOUT touching the draft — a
   * one-click reply (today: accepting the conductor's offer to make a task)
   * must not swallow a message the user is in the middle of writing, nor the
   * attachments they already picked.
   *
   * Null until the composer publishes its send function, and when the chat is
   * read-only (archived agent): callers render nothing in that case.
   */
  sendText: ((text: string) => Promise<void>) | null;
  /** Lets the composer publish its send function to this provider. */
  registerSendText: (send: ((text: string) => Promise<void>) | null) => void;
}

const ComposerInsertContext = createContext<ComposerInsertContextValue | null>(null);

/**
 * Lets a deeply nested chat affordance (today: an "Évolutions possibles"
 * mini-card) drop text into the message composer without threading the draft
 * through the generic workspace pane in between.
 *
 * Mounted once around the stream and the composer, so both the conductor chat
 * and the task-agent chat get it for free. Null outside that tree — the "+"
 * buttons simply don't render there.
 */
export function ComposerInsertProvider({
  text,
  setText,
  children,
}: {
  text: string;
  setText: (text: string) => void;
  children: ReactNode;
}) {
  // The draft text changes on every keystroke; reading it from a ref keeps the
  // context value stable so the whole transcript doesn't re-render while typing.
  // Cards that need to follow the draft subscribe instead (see
  // `useIsBulletInDraft`), and only re-render when their own line appears or
  // disappears.
  const textRef = useRef(text);
  const listenersRef = useRef(new Set<() => void>());
  useEffect(() => {
    textRef.current = text;
    for (const listener of listenersRef.current) {
      listener();
    }
  }, [text]);

  const subscribeToDraft = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);
  const getDraft = useCallback(() => textRef.current, []);

  const focusInputRef = useRef<((options?: ComposerFocusInputOptions) => void) | null>(null);
  const registerFocusInput = useCallback((focus: (options?: ComposerFocusInputOptions) => void) => {
    focusInputRef.current = focus;
  }, []);

  const toggleBullet = useCallback(
    (bulletText: string) => {
      const nextText = toggleBulletInDraft({ currentText: textRef.current, text: bulletText });
      if (nextText !== textRef.current) {
        textRef.current = nextText;
        setText(nextText);
        // The parent re-render lands a tick later; notify now so the card that
        // was just tapped flips immediately.
        for (const listener of listenersRef.current) {
          listener();
        }
      }
      // Focus only — the message is never sent automatically. On phones the
      // keyboard should come up, since the user is about to keep typing.
      focusInputRef.current?.({ raiseKeyboardOnNative: true });
    },
    [setText],
  );

  // The composer publishes its send function here. Kept in state (not a ref) so
  // a button that depends on it appears as soon as the composer mounts.
  const [send, setSend] = React.useState<((text: string) => Promise<void>) | null>(null);
  const registerSendText = useCallback((next: ((text: string) => Promise<void>) | null) => {
    // Wrapped in a thunk: React treats a bare function argument as an updater.
    setSend(() => next);
  }, []);

  const value = useMemo<ComposerInsertContextValue>(
    () => ({
      toggleBullet,
      subscribeToDraft,
      getDraft,
      registerFocusInput,
      sendText: send,
      registerSendText,
    }),
    [getDraft, registerFocusInput, registerSendText, send, subscribeToDraft, toggleBullet],
  );

  return <ComposerInsertContext.Provider value={value}>{children}</ComposerInsertContext.Provider>;
}

export function useComposerInsert(): ComposerInsertContextValue | null {
  return useContext(ComposerInsertContext);
}

const NO_SUBSCRIPTION = () => () => {};

/**
 * Whether `text` currently sits in the draft as its own bullet.
 *
 * The card draws itself from this rather than from a local "I was tapped"
 * flag, so editing or deleting the line by hand unselects the card too.
 */
export function useIsBulletInDraft(text: string): boolean {
  const composerInsert = useComposerInsert();
  const subscribe = composerInsert?.subscribeToDraft ?? NO_SUBSCRIPTION;
  const getSnapshot = useCallback(() => {
    if (!composerInsert) {
      return false;
    }
    return draftHasBullet({ currentText: composerInsert.getDraft(), text });
  }, [composerInsert, text]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
