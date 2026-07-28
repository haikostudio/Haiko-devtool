import { describe, expect, it } from "vitest";
import { appendTextToDraft } from "./insert-draft-text";

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
