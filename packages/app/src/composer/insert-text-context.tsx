import * as React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { appendTextToDraft } from "./insert-draft-text";
import type { ComposerFocusInputOptions } from "./types";

interface ComposerInsertContextValue {
  /** Appends `text` to the current draft and focuses the message input. */
  insertText: (text: string) => void;
  /** Lets the composer publish its focus function to this provider. */
  registerFocusInput: (focus: (options?: ComposerFocusInputOptions) => void) => void;
}

const ComposerInsertContext = createContext<ComposerInsertContextValue | null>(null);

/**
 * Lets a deeply nested chat affordance (today: the "+" button on an
 * "Évolutions possibles" bullet) drop text into the message composer without
 * threading the draft through the generic workspace pane in between.
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
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const focusInputRef = useRef<((options?: ComposerFocusInputOptions) => void) | null>(null);
  const registerFocusInput = useCallback((focus: (options?: ComposerFocusInputOptions) => void) => {
    focusInputRef.current = focus;
  }, []);

  const insertText = useCallback(
    (insertion: string) => {
      const nextText = appendTextToDraft({ currentText: textRef.current, insertion });
      if (nextText !== textRef.current) {
        textRef.current = nextText;
        setText(nextText);
      }
      // Focus only — the message is never sent automatically. On phones the
      // keyboard should come up, since the user is about to keep typing.
      focusInputRef.current?.({ raiseKeyboardOnNative: true });
    },
    [setText],
  );

  const value = useMemo<ComposerInsertContextValue>(
    () => ({ insertText, registerFocusInput }),
    [insertText, registerFocusInput],
  );

  return <ComposerInsertContext.Provider value={value}>{children}</ComposerInsertContext.Provider>;
}

export function useComposerInsert(): ComposerInsertContextValue | null {
  return useContext(ComposerInsertContext);
}
