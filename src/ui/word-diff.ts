export interface ChangeRange { start: number; end: number }

/** Locate the changed region without splitting surrogate pairs. */
export function changeRanges(before: string, after: string): {old: ChangeRange; next: ChangeRange} | null {
  const old = Array.from(before.replace(/\r$/, ''));
  const next = Array.from(after.replace(/\r$/, ''));
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  if (prefix === old.length && prefix === next.length) return null;
  let suffix = 0;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const identifier = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}_$]/u.test(character);
  // Highlight an edited identifier as a word rather than leaving a common
  // letter at either edge of the old and new names unmarked.
  while (prefix > 0 && ((identifier(old[prefix - 1]) && identifier(old[prefix])) || (identifier(next[prefix - 1]) && identifier(next[prefix])))) prefix--;
  while (suffix > 0 && ((identifier(old[old.length - suffix - 1]) && identifier(old[old.length - suffix])) || (identifier(next[next.length - suffix - 1]) && identifier(next[next.length - suffix])))) suffix--;
  return {
    old: {start: old.slice(0, prefix).join('').length, end: old.slice(0, old.length - suffix).join('').length},
    next: {start: next.slice(0, prefix).join('').length, end: next.slice(0, next.length - suffix).join('').length}
  };
}

/** Add inline marks to already escaped highlight.js output, keeping token tags intact. */
export function markChangedText(html: string, range: ChangeRange): string {
  if (range.start >= range.end) return html;
  let offset = 0;
  return (html.match(/<[^>]*>|&(?:#\d+|#x[a-f\d]+|[a-z]+);|[^<&]+|[<&]/gi) ?? []).map(piece => {
    if (piece.startsWith('<')) return piece;
    if (piece.startsWith('&') && piece.endsWith(';')) {
      const code = piece.startsWith('&#x') ? parseInt(piece.slice(3, -1), 16) : piece.startsWith('&#') ? parseInt(piece.slice(2, -1), 10) : 0;
      const length = code > 0xffff ? 2 : 1;
      const changed = offset < range.end && offset + length > range.start;
      offset += length;
      return changed ? `<mark class="sr-inline-change">${piece}</mark>` : piece;
    }
    const start = Math.max(0, Math.min(piece.length, range.start - offset));
    const end = Math.max(start, Math.min(piece.length, range.end - offset));
    offset += piece.length;
    return start === end ? piece : `${piece.slice(0, start)}<mark class="sr-inline-change">${piece.slice(start, end)}</mark>${piece.slice(end)}`;
  }).join('');
}
