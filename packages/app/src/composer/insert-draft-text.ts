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
export function normalizeBulletText(line: string): string {
  return line.trim().replace(LIST_MARKER_PATTERN, "").replace(/\s+/g, " ").trim();
}

const normalizeLine = normalizeBulletText;

/** Whether a draft line is a list item — the lines the strip can reorder. */
function isBulletLine(line: string): boolean {
  return LIST_MARKER_PATTERN.test(line.trim()) && normalizeLine(line).length > 0;
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

/**
 * Adds every proposal that is still missing, in the given order, in one pass —
 * the "tout ajouter" button, which must not rewrite the draft once per card.
 */
export function addBulletsToDraft(input: { currentText: string; texts: string[] }): string {
  let next = input.currentText;
  for (const text of input.texts) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || draftHasBullet({ currentText: next, text: trimmed })) {
      continue;
    }
    next = appendTextToDraft({ currentText: next, insertion: formatDraftBullet(trimmed) });
  }
  return next;
}

/** Takes every listed proposal back out, leaving the rest of the draft alone. */
export function removeBulletsFromDraft(input: { currentText: string; texts: string[] }): string {
  let next = input.currentText;
  for (const text of input.texts) {
    next = removeBulletFromDraft({ currentText: next, text });
  }
  return next;
}

/** The draft's list items, in the order they appear. */
export function listDraftBullets(currentText: string): string[] {
  return currentText
    .split("\n")
    .filter(isBulletLine)
    .map((line) => normalizeLine(line));
}

/**
 * The `from`/`to` ranks behind a single reordering, given the list before and
 * after a drag. A drag-and-drop library hands back the whole reordered array;
 * the draft only needs to know which bullet moved where.
 *
 * Returns null when the two lists are not one move apart (nothing moved, or
 * they don't hold the same items).
 */
export function findMovedBulletIndices(
  previous: string[],
  next: string[],
): { from: number; to: number } | null {
  if (previous.length !== next.length) {
    return null;
  }

  let first = -1;
  let last = -1;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      if (first < 0) {
        first = index;
      }
      last = index;
    }
  }
  if (first < 0) {
    return null;
  }

  // Dragging down moves the item forward (its slot appears last), dragging up
  // moves it backward (its slot appears first).
  const move =
    next[first] === previous[last] ? { from: last, to: first } : { from: first, to: last };
  const check = [...previous];
  const [moved] = check.splice(move.from, 1);
  check.splice(move.to, 0, moved);
  return check.every((line, index) => line === next[index]) ? move : null;
}

/**
 * Moves one list item to another rank among the list items, keeping every other
 * line exactly where it was — reordering the chosen points must not disturb the
 * sentence the user wrote above them.
 */
export function reorderDraftBullets(input: {
  currentText: string;
  from: number;
  to: number;
}): string {
  const lines = input.currentText.split("\n");
  const bulletIndices = lines
    .map((line, index) => (isBulletLine(line) ? index : -1))
    .filter((index) => index >= 0);

  const { from, to } = input;
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= bulletIndices.length ||
    to >= bulletIndices.length
  ) {
    return input.currentText;
  }

  const bulletLines = bulletIndices.map((index) => lines[index]);
  const [moved] = bulletLines.splice(from, 1);
  bulletLines.splice(to, 0, moved);
  // The bullets keep the same slots in the text; only their contents rotate.
  bulletIndices.forEach((lineIndex, rank) => {
    lines[lineIndex] = bulletLines[rank];
  });
  return lines.join("\n");
}
