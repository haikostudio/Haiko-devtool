/**
 * @vitest-environment jsdom
 */
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComposerInsertProvider,
  useComposerInsert,
  useIsBulletInDraft,
} from "./insert-text-context";
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

/** Stands in for the composer: registers its focus + send functions. */
function FakeComposer({
  focus,
  send,
}: {
  focus: (options?: ComposerFocusInputOptions) => void;
  send?: (text: string) => Promise<void>;
}) {
  const insert = useComposerInsert();
  React.useEffect(() => {
    insert?.registerFocusInput(focus);
  }, [insert, focus]);
  React.useEffect(() => {
    if (!send) {
      return;
    }
    insert?.registerSendText(send);
    return () => insert?.registerSendText(null);
  }, [insert, send]);
  return null;
}

/** Stands in for the "Oui, fais-en une tâche" button under a conductor offer. */
function FakeQuickReplyButton({ text }: { text: string }) {
  const insert = useComposerInsert();
  const send = insert?.sendText ?? null;
  const handleClick = React.useCallback(() => {
    void send?.(text);
  }, [send, text]);
  if (!send) {
    return <output data-testid="no-send-channel" />;
  }
  return (
    <button type="button" data-testid="quick-reply" onClick={handleClick}>
      send
    </button>
  );
}

/** Stable no-op focus, so the harness never rebuilds a prop function inline. */
const noopFocus = () => {};

/** Stands in for an "Évolutions possibles" mini-card. */
function FakeEvolutionCard({ text }: { text: string }) {
  const insert = useComposerInsert();
  const isSelected = useIsBulletInDraft(text);
  const handleClick = React.useCallback(() => insert?.toggleBullet(text), [insert, text]);
  return (
    <button type="button" data-selected={isSelected ? "yes" : "no"} onClick={handleClick}>
      {text}
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
  const handleHandEdit = React.useCallback(() => setText("Réécrit à la main"), []);
  return (
    <ComposerInsertProvider text={text} setText={setText}>
      <FakeEvolutionCard text="Piste numéro un" />
      <FakeEvolutionCard text="Piste numéro deux" />
      <FakeComposer focus={focus} />
      {/* Stands in for the user editing the message field by hand. */}
      <button type="button" data-testid="hand-edit" onClick={handleHandEdit}>
        edit
      </button>
      <output data-testid="draft">{text}</output>
    </ComposerInsertProvider>
  );
}

function renderHarness(initialText: string) {
  const focus = vi.fn();
  act(() => {
    root.render(<Harness initialText={initialText} focus={focus} />);
  });
  const cards = Array.from(container.querySelectorAll("button[data-selected]"));
  const click = (index: number) => {
    act(() => {
      cards[index].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const editByHand = () => {
    act(() => {
      container
        .querySelector('[data-testid="hand-edit"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const draft = () => container.querySelector("output")?.textContent ?? "";
  const isSelected = (index: number) => cards[index].getAttribute("data-selected") === "yes";
  return { focus, click, draft, isSelected, editByHand };
}

describe("ComposerInsertProvider", () => {
  it("fills an empty draft without a leading newline", () => {
    const { click, draft } = renderHarness("");
    click(0);
    expect(draft()).toBe("- Piste numéro un");
  });

  it("appends after an existing draft instead of overwriting it", () => {
    const { click, draft } = renderHarness("Ce que j'écrivais");
    click(0);
    expect(draft()).toBe("Ce que j'écrivais\n- Piste numéro un");
  });

  it("stacks several selections one bullet per line", () => {
    const { click, draft, isSelected } = renderHarness("");
    click(0);
    click(1);
    expect(draft()).toBe("- Piste numéro un\n- Piste numéro deux");
    expect(isSelected(0)).toBe(true);
    expect(isSelected(1)).toBe(true);
  });

  it("takes back only the deselected bullet", () => {
    const { click, draft, isSelected } = renderHarness("Ce que j'écrivais");
    click(0);
    click(1);
    click(0);
    expect(draft()).toBe("Ce que j'écrivais\n- Piste numéro deux");
    expect(isSelected(0)).toBe(false);
    expect(isSelected(1)).toBe(true);
  });

  it("never adds the same proposal twice", () => {
    const { click, draft } = renderHarness("");
    click(0);
    click(0);
    click(0);
    expect(draft()).toBe("- Piste numéro un");
  });

  it("unselects a card whose bullet the user deleted by hand", () => {
    const { click, isSelected, editByHand } = renderHarness("");
    click(0);
    expect(isSelected(0)).toBe(true);
    editByHand();
    expect(isSelected(0)).toBe(false);
  });

  it("focuses the input and asks for the keyboard on native", () => {
    const { click, focus } = renderHarness("");
    click(0);
    expect(focus).toHaveBeenCalledWith({ raiseKeyboardOnNative: true });
  });
});

/** Harness with a composer that also publishes a send function. */
function SendHarness({
  initialText,
  send,
  withComposer = true,
}: {
  initialText: string;
  send: (text: string) => Promise<void>;
  withComposer?: boolean;
}) {
  const [text, setText] = useState(initialText);
  return (
    <ComposerInsertProvider text={text} setText={setText}>
      <FakeQuickReplyButton text="Oui, fais-en une tâche." />
      {withComposer ? <FakeComposer focus={noopFocus} send={send} /> : null}
      <output data-testid="draft">{text}</output>
    </ComposerInsertProvider>
  );
}

describe("ComposerInsertProvider — one-click replies", () => {
  it("sends the canned text through the composer's send function", () => {
    const send = vi.fn(async () => {});
    act(() => {
      root.render(<SendHarness initialText="" send={send} />);
    });
    act(() => {
      container
        .querySelector('[data-testid="quick-reply"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(send).toHaveBeenCalledWith("Oui, fais-en une tâche.");
  });

  it("leaves a draft the user is writing completely untouched", () => {
    const send = vi.fn(async () => {});
    act(() => {
      root.render(<SendHarness initialText="Message à moitié écrit" send={send} />);
    });
    act(() => {
      container
        .querySelector('[data-testid="quick-reply"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The whole point of bypassing the draft: the half-typed message survives.
    expect(container.querySelector("output")?.textContent).toBe("Message à moitié écrit");
  });

  it("offers no button at all when no composer published a send function", () => {
    const send = vi.fn(async () => {});
    act(() => {
      root.render(<SendHarness initialText="" send={send} withComposer={false} />);
    });
    expect(container.querySelector('[data-testid="quick-reply"]')).toBeNull();
    expect(container.querySelector('[data-testid="no-send-channel"]')).not.toBeNull();
  });
});
