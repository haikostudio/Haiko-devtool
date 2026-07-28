/**
 * @vitest-environment jsdom
 */
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerInsertProvider, useComposerInsert } from "./insert-text-context";
import type { ComposerFocusInputOptions } from "./types";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Stands in for the composer: registers its focus function, shows the draft. */
function FakeComposer({ focus }: { focus: (options?: ComposerFocusInputOptions) => void }) {
  const insert = useComposerInsert();
  React.useEffect(() => {
    insert?.registerFocusInput(focus);
  }, [insert, focus]);
  return null;
}

/** Stands in for a "+" button on an "Évolutions possibles" bullet. */
function FakeInsertButton({ text }: { text: string }) {
  const insert = useComposerInsert();
  const handleClick = React.useCallback(() => insert?.insertText(text), [insert, text]);
  return (
    <button type="button" onClick={handleClick}>
      insert
    </button>
  );
}

function Harness({
  initialText,
  focus,
}: {
  initialText: string;
  focus: (options?: ComposerFocusInputOptions) => void;
}) {
  const [text, setText] = useState(initialText);
  return (
    <ComposerInsertProvider text={text} setText={setText}>
      <FakeInsertButton text="Piste numéro un" />
      <FakeInsertButton text="Piste numéro deux" />
      <FakeComposer focus={focus} />
      <output data-testid="draft">{text}</output>
    </ComposerInsertProvider>
  );
}

function renderHarness(initialText: string) {
  const focus = vi.fn();
  act(() => {
    root.render(<Harness initialText={initialText} focus={focus} />);
  });
  const buttons = Array.from(container.querySelectorAll("button"));
  const click = (index: number) => {
    act(() => {
      buttons[index].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const draft = () => container.querySelector("output")?.textContent ?? "";
  return { focus, click, draft };
}

describe("ComposerInsertProvider", () => {
  it("fills an empty draft without a leading newline", () => {
    const { click, draft } = renderHarness("");
    click(0);
    expect(draft()).toBe("Piste numéro un");
  });

  it("appends after an existing draft instead of overwriting it", () => {
    const { click, draft } = renderHarness("Ce que j'écrivais");
    click(0);
    expect(draft()).toBe("Ce que j'écrivais\nPiste numéro un");
  });

  it("stacks several insertions one per line", () => {
    const { click, draft } = renderHarness("");
    click(0);
    click(1);
    expect(draft()).toBe("Piste numéro un\nPiste numéro deux");
  });

  it("focuses the input and asks for the keyboard on native", () => {
    const { click, focus } = renderHarness("");
    click(0);
    expect(focus).toHaveBeenCalledWith({ raiseKeyboardOnNative: true });
  });
});
