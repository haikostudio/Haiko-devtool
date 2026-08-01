/**
 * Appends a suggestion (e.g. an "Évolutions possibles" bullet the user tapped)
 * to the composer draft without ever clobbering what is already typed.
 *
 * Rules:
 * - an empty draft is replaced outright, so the first insertion has no leading
 *   blank line;
 * - a non-empty draft keeps its content and the suggestion lands on its own
 *   line;
 * - a draft that already ends with a newline does not get a second one, so
 *   repeated insertions stay a tidy one-per-line list.
 */
export function appendTextToDraft(input: { currentText: string; insertion: string }): string {
  const insertion = input.insertion.trim();
  if (insertion.length === 0) {
    return input.currentText;
  }

  const currentText = input.currentText;
  if (currentText.trim().length === 0) {
    return insertion;
  }

  return currentText.endsWith("\n") ? `${currentText}${insertion}` : `${currentText}\n${insertion}`;
}

/** Marker written in front of a proposal dropped into the draft. */
const BULLET_MARKER = "- ";
// Any list marker the user might end up with after editing the draft by hand:
// swapping "-" for "*", or letting an editor renumber the lines.
const LIST_MARKER_PATTERN = /^(?:[-*+•]|\d+[.)])\s+/;

export function formatDraftBullet(text: string): string {
  return `${BULLET_MARKER}${text.trim()}`;
}

/**
 * The comparable form of a draft line: no list marker, no double spaces.
 *
 * Selection state is read back from the draft rather than remembered, so a
 * bullet the user retyped with a different marker still counts as selected —
 * and a bullet they reworded does not.
 */
function normalizeLine(line: string): string {
  return line.trim().replace(LIST_MARKER_PATTERN, "").replace(/\s+/g, " ").trim();
}

/** Whether `text` is already present in the draft as its own line. */
export function draftHasBullet(input: { currentText: string; text: string }): boolean {
  const target = normalizeLine(input.text);
  if (target.length === 0) {
    return false;
  }
  return input.currentText.split("\n").some((line) => normalizeLine(line) === target);
}

/**
 * Removes every line matching `text` and leaves the rest of the draft byte for
 * byte as it was — the other bullets and whatever the user typed around them.
 */
export function removeBulletFromDraft(input: { currentText: string; text: string }): string {
  const target = normalizeLine(input.text);
  if (target.length === 0) {
    return input.currentText;
  }

  const kept = input.currentText.split("\n").filter((line) => normalizeLine(line) !== target);
  const next = kept.join("\n");
  // Dropping the only line of the draft leaves whitespace behind ("\n\n" for a
  // bullet surrounded by blank lines); an all-blank draft reads as empty.
  return next.trim().length === 0 ? "" : next;
}

/**
 * Adds the proposal as a bullet when it is missing, removes it when it is
 * already there. Never produces a duplicate: the add path is guarded by the
 * same lookup the UI uses to draw the struck-through state.
 */
export function toggleBulletInDraft(input: { currentText: string; text: string }): string {
  const text = input.text.trim();
  if (text.length === 0) {
    return input.currentText;
  }

  if (draftHasBullet({ currentText: input.currentText, text })) {
    return removeBulletFromDraft({ currentText: input.currentText, text });
  }

  return appendTextToDraft({ currentText: input.currentText, insertion: formatDraftBullet(text) });
}
