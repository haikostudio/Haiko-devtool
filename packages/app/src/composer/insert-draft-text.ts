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
