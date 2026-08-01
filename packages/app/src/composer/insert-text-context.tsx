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
import {
  addBulletsToDraft,
  draftHasBullet,
  listDraftBullets,
  normalizeBulletText,
  removeBulletsFromDraft,
  reorderDraftBullets,
  toggleBulletInDraft,
} from "./insert-draft-text";
import type { ComposerFocusInputOptions } from "./types";

interface ComposerInsertContextValue {
  /**
   * Adds `text` to the current draft as its own bullet, or removes that bullet
   * when it is already there, then focuses the message input. Everything else
   * in the draft is left untouched.
   */
  toggleBullet: (text: string) => void;
  /** Adds every missing proposal at once, or takes them all back out. */
  toggleAllBullets: (texts: string[], select: boolean) => void;
  /** Moves one bullet to another rank among the draft's bullets. */
  reorderBullets: (from: number, to: number) => void;
  /**
   * Records the lines of a message that just left for the agent, so a card can
   * keep showing "already asked" once the draft is emptied by the send.
   */
  markBulletsSent: (message: string) => void;
  /** Subscribes to sent-message changes; returns the unsubscribe function. */
  subscribeToSent: (listener: () => void) => () => void;
  /** Whether that exact proposal was part of a message already sent. */
  wasSent: (text: string) => boolean;
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

  // The parent re-render lands a tick later; notifying here is what flips the
  // card that was just tapped straight away.
  const applyDraft = useCallback(
    (nextText: string) => {
      if (nextText === textRef.current) {
        return;
      }
      textRef.current = nextText;
      setText(nextText);
      for (const listener of listenersRef.current) {
        listener();
      }
    },
    [setText],
  );

  const toggleBullet = useCallback(
    (bulletText: string) => {
      applyDraft(toggleBulletInDraft({ currentText: textRef.current, text: bulletText }));
      // Focus only — the message is never sent automatically. On phones the
      // keyboard should come up, since the user is about to keep typing.
      focusInputRef.current?.({ raiseKeyboardOnNative: true });
    },
    [applyDraft],
  );

  const toggleAllBullets = useCallback(
    (texts: string[], select: boolean) => {
      applyDraft(
        select
          ? addBulletsToDraft({ currentText: textRef.current, texts })
          : removeBulletsFromDraft({ currentText: textRef.current, texts }),
      );
      focusInputRef.current?.({ raiseKeyboardOnNative: false });
    },
    [applyDraft],
  );

  const reorderBullets = useCallback(
    (from: number, to: number) => {
      applyDraft(reorderDraftBullets({ currentText: textRef.current, from, to }));
    },
    [applyDraft],
  );

  // What already left for the agent, so a proposal stays visibly "asked" once
  // the send has emptied the draft. In memory on purpose: it describes this
  // conversation as it is being held, not something worth persisting.
  const sentRef = useRef(new Set<string>());
  const sentListenersRef = useRef(new Set<() => void>());
  const subscribeToSent = useCallback((listener: () => void) => {
    sentListenersRef.current.add(listener);
    return () => {
      sentListenersRef.current.delete(listener);
    };
  }, []);
  const wasSent = useCallback((bulletText: string) => {
    const normalized = normalizeBulletText(bulletText);
    return normalized.length > 0 && sentRef.current.has(normalized);
  }, []);
  const markBulletsSent = useCallback((message: string) => {
    const bullets = listDraftBullets(message);
    if (bullets.length === 0) {
      return;
    }
    for (const bullet of bullets) {
      sentRef.current.add(bullet);
    }
    for (const listener of sentListenersRef.current) {
      listener();
    }
  }, []);

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
      toggleAllBullets,
      reorderBullets,
      markBulletsSent,
      subscribeToSent,
      wasSent,
      subscribeToDraft,
      getDraft,
      registerFocusInput,
      sendText: send,
      registerSendText,
    }),
    [
      getDraft,
      markBulletsSent,
      registerFocusInput,
      registerSendText,
      reorderBullets,
      send,
      subscribeToDraft,
      subscribeToSent,
      toggleAllBullets,
      toggleBullet,
      wasSent,
    ],
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

/** Whether `text` went out with a message already sent in this conversation. */
export function useWasBulletSent(text: string): boolean {
  const composerInsert = useComposerInsert();
  const subscribe = composerInsert?.subscribeToSent ?? NO_SUBSCRIPTION;
  const getSnapshot = useCallback(
    () => composerInsert?.wasSent(text) ?? false,
    [composerInsert, text],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const NO_BULLETS: string[] = [];

/**
 * The draft's bullets, in order — what the reorder strip draws.
 *
 * The snapshot is cached against the raw draft so `useSyncExternalStore` keeps
 * getting the same array identity between keystrokes that change nothing here.
 */
export function useDraftBullets(): string[] {
  const composerInsert = useComposerInsert();
  const cacheRef = useRef<{ source: string; bullets: string[] } | null>(null);
  const subscribe = composerInsert?.subscribeToDraft ?? NO_SUBSCRIPTION;
  const getSnapshot = useCallback(() => {
    if (!composerInsert) {
      return NO_BULLETS;
    }
    const source = composerInsert.getDraft();
    const cached = cacheRef.current;
    if (cached && cached.source === source) {
      return cached.bullets;
    }
    const bullets = listDraftBullets(source);
    // Same list of bullets after an unrelated edit: keep the previous array so
    // subscribers don't re-render on every keystroke.
    if (
      cached &&
      cached.bullets.length === bullets.length &&
      cached.bullets.every((bullet, index) => bullet === bullets[index])
    ) {
      cacheRef.current = { source, bullets: cached.bullets };
      return cached.bullets;
    }
    cacheRef.current = { source, bullets };
    return bullets;
  }, [composerInsert]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
