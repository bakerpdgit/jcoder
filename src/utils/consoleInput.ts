/**
 * Terminal-style handling of a multi-line paste at the console prompt.
 *
 * Pasting into an `<input>` normally collapses newlines, which is useless when
 * a program wants several answers. A terminal instead treats each newline as a
 * press of Enter: pasting "Ada\n21" answers the current prompt with "Ada" and
 * leaves "21" at the prompt; pasting "Ada\n21\n" answers both.
 */
export interface PastedInput {
  /** Complete lines, in order, each answering one read. */
  submit: string[]
  /** What is left at the prompt afterwards, still editable. */
  draft: string
}

export function splitPastedInput(
  pasted: string,
  draft: string,
  selectionStart: number,
  selectionEnd: number,
): PastedInput {
  const before = draft.slice(0, selectionStart)
  const after = draft.slice(selectionEnd)

  // A trailing newline leaves a final empty part, which is what makes
  // "Ada\n21\n" submit both lines while "Ada\n21" leaves 21 at the prompt.
  const parts = pasted.replace(/\r\n?/g, '\n').split('\n')

  parts[0] = before + parts[0]
  parts[parts.length - 1] = parts[parts.length - 1] + after

  return { submit: parts.slice(0, -1), draft: parts[parts.length - 1] }
}
