import { describe, expect, it } from "vitest";
import {
  addBulletsToDraft,
  appendTextToDraft,
  draftHasBullet,
  findMovedBulletIndices,
  listDraftBullets,
  removeBulletFromDraft,
  removeBulletsFromDraft,
  reorderDraftBullets,
  toggleBulletInDraft,
} from "./insert-draft-text";

describe("appendTextToDraft", () => {
  it("replaces an empty draft", () => {
    expect(appendTextToDraft({ currentText: "", insertion: "Ajouter un mode hors-ligne" })).toBe(
      "Ajouter un mode hors-ligne",
    );
  });

  it("treats a whitespace-only draft as empty", () => {
    expect(appendTextToDraft({ currentText: "  \n ", insertion: "Idée" })).toBe("Idée");
  });

  it("appends on a new line when the draft has content", () => {
    expect(appendTextToDraft({ currentText: "Bonjour", insertion: "Idée" })).toBe("Bonjour\nIdée");
  });

  it("does not double the newline when the draft already ends with one", () => {
    expect(appendTextToDraft({ currentText: "Bonjour\n", insertion: "Idée" })).toBe(
      "Bonjour\nIdée",
    );
  });

  it("trims the insertion", () => {
    expect(appendTextToDraft({ currentText: "Bonjour", insertion: "  Idée  " })).toBe(
      "Bonjour\nIdée",
    );
  });

  it("leaves the draft untouched for an empty insertion", () => {
    expect(appendTextToDraft({ currentText: "Bonjour", insertion: "   " })).toBe("Bonjour");
  });

  it("stacks repeated insertions one per line", () => {
    const first = appendTextToDraft({ currentText: "", insertion: "Première piste" });
    const second = appendTextToDraft({ currentText: first, insertion: "Deuxième piste" });
    expect(second).toBe("Première piste\nDeuxième piste");
  });
});

describe("toggleBulletInDraft", () => {
  it("adds the proposal as a bullet on an empty draft", () => {
    expect(toggleBulletInDraft({ currentText: "", text: "Mode hors-ligne" })).toBe(
      "- Mode hors-ligne",
    );
  });

  it("keeps what the user already typed", () => {
    expect(toggleBulletInDraft({ currentText: "Bonjour", text: "Mode hors-ligne" })).toBe(
      "Bonjour\n- Mode hors-ligne",
    );
  });

  it("stacks several proposals in selection order", () => {
    const first = toggleBulletInDraft({ currentText: "", text: "Première piste" });
    const second = toggleBulletInDraft({ currentText: first, text: "Deuxième piste" });
    expect(second).toBe("- Première piste\n- Deuxième piste");
  });

  it("removes only the matching bullet on a second toggle", () => {
    const both = "Bonjour\n- Première piste\n- Deuxième piste";
    expect(toggleBulletInDraft({ currentText: both, text: "Première piste" })).toBe(
      "Bonjour\n- Deuxième piste",
    );
  });

  it("never adds the same proposal twice", () => {
    const once = toggleBulletInDraft({ currentText: "", text: "Idée" });
    const twice = toggleBulletInDraft({ currentText: once, text: "Idée" });
    const thrice = toggleBulletInDraft({ currentText: twice, text: "Idée" });
    expect(twice).toBe("");
    expect(thrice).toBe("- Idée");
  });

  it("leaves the draft untouched for an empty proposal", () => {
    expect(toggleBulletInDraft({ currentText: "Bonjour", text: "   " })).toBe("Bonjour");
  });
});

describe("draftHasBullet", () => {
  it("finds the proposal whatever list marker the user left", () => {
    for (const line of ["- Idée", "* Idée", "1. Idée", "Idée"]) {
      expect(draftHasBullet({ currentText: `Bonjour\n${line}`, text: "Idée" })).toBe(true);
    }
  });

  it("ignores a line that only contains the proposal", () => {
    expect(draftHasBullet({ currentText: "- Idée revisitée", text: "Idée" })).toBe(false);
  });

  it("is false on an empty draft", () => {
    expect(draftHasBullet({ currentText: "", text: "Idée" })).toBe(false);
  });
});

describe("removeBulletFromDraft", () => {
  it("empties a draft that only held the bullet", () => {
    expect(removeBulletFromDraft({ currentText: "- Idée", text: "Idée" })).toBe("");
  });

  it("keeps surrounding text as it was", () => {
    expect(removeBulletFromDraft({ currentText: "Avant\n- Idée\nAprès", text: "Idée" })).toBe(
      "Avant\nAprès",
    );
  });

  it("leaves the draft untouched when the bullet is absent", () => {
    expect(removeBulletFromDraft({ currentText: "Bonjour", text: "Idée" })).toBe("Bonjour");
  });
});

describe("addBulletsToDraft / removeBulletsFromDraft", () => {
  it("adds every proposal in order, in one pass", () => {
    expect(addBulletsToDraft({ currentText: "Bonjour", texts: ["Une", "Deux", "Trois"] })).toBe(
      "Bonjour\n- Une\n- Deux\n- Trois",
    );
  });

  it("skips the proposals already in the draft", () => {
    expect(addBulletsToDraft({ currentText: "- Deux", texts: ["Une", "Deux"] })).toBe(
      "- Deux\n- Une",
    );
  });

  it("takes them all back out without touching the rest", () => {
    expect(
      removeBulletsFromDraft({ currentText: "Bonjour\n- Une\n- Deux", texts: ["Une", "Deux"] }),
    ).toBe("Bonjour");
  });
});

describe("listDraftBullets", () => {
  it("lists the list items in order, markers stripped", () => {
    expect(listDraftBullets("Bonjour\n- Une\n* Deux\n1. Trois\nUne phrase")).toEqual([
      "Une",
      "Deux",
      "Trois",
    ]);
  });

  it("is empty when nothing was chosen", () => {
    expect(listDraftBullets("Juste une phrase")).toEqual([]);
  });
});

describe("reorderDraftBullets", () => {
  it("moves a bullet without disturbing the surrounding text", () => {
    expect(
      reorderDraftBullets({ currentText: "Bonjour\n- Une\n- Deux\n- Trois", from: 2, to: 0 }),
    ).toBe("Bonjour\n- Trois\n- Une\n- Deux");
  });

  it("keeps a line typed between two bullets in place", () => {
    expect(reorderDraftBullets({ currentText: "- Une\nau fait\n- Deux", from: 0, to: 1 })).toBe(
      "- Deux\nau fait\n- Une",
    );
  });

  it("leaves the draft untouched for an out-of-range move", () => {
    expect(reorderDraftBullets({ currentText: "- Une\n- Deux", from: 0, to: 5 })).toBe(
      "- Une\n- Deux",
    );
  });
});

describe("findMovedBulletIndices", () => {
  it("reads a drag downwards", () => {
    expect(findMovedBulletIndices(["a", "b", "c"], ["b", "c", "a"])).toEqual({ from: 0, to: 2 });
  });

  it("reads a drag upwards", () => {
    expect(findMovedBulletIndices(["a", "b", "c"], ["c", "a", "b"])).toEqual({ from: 2, to: 0 });
  });

  it("returns null when nothing moved", () => {
    expect(findMovedBulletIndices(["a", "b"], ["a", "b"])).toBeNull();
  });

  it("returns null when the lists don't hold the same items", () => {
    expect(findMovedBulletIndices(["a", "b"], ["a", "c"])).toBeNull();
  });
});
