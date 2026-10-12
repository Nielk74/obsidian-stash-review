import hljs from 'highlight.js/lib/common';
import type {DiffFile, DiffLine, Stash} from '../types';

export function stashTitle(stash: Stash): string {
  return stash.message.replace(/^(?:WIP on|On) [^:]+:\s*/, '').replace(/^[a-f0-9]{7,40}\s+/, '') || 'Untitled stash';
}

export function relativeDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown date';
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fileId(path: string, prefix = ''): string {
  return `${prefix}sr-file-${Array.from(path).map(char => char.codePointAt(0)!.toString(16)).join('-')}`;
}

const languageMap: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  css: 'css', scss: 'scss', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', json: 'json', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', markdown: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', c: 'c', h: 'c',
  cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', lua: 'lua', ini: 'ini', toml: 'ini', diff: 'diff', patch: 'diff'
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!));
}

// Highlight the complete source, then carry open token spans across line boundaries.
// Every HTML fragment originates from highlight.js or the escaping fallback.
const syntaxCache = new Map<string, string[]>();
let syntaxCacheSize = 0;
const MAX_HIGHLIGHT_CHARS = 200_000;
const MAX_CACHE_CHARS = 2_000_000;
export function highlightedLines(source: string, path: string): string[] {
  source = source.replace(/\r\n/g, '\n');
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const language = languageMap[extension];
  const key = `${language ?? ''}\0${source}`;
  const cached = syntaxCache.get(key);
  if (cached) {syntaxCache.delete(key); syntaxCache.set(key, cached); return cached;}
  let html: string;
  try {
    html = source.length <= MAX_HIGHLIGHT_CHARS && language && hljs.getLanguage(language)
      ? hljs.highlight(source, {language, ignoreIllegals: true}).value
      : escapeHtml(source);
  } catch { html = escapeHtml(source); }
  const pieces = html.split(/(<\/?span[^>]*>|\n)/);
  const stack: string[] = [];
  const result: string[] = [];
  let line = '';
  for (const piece of pieces) {
    if (piece === '\n') {
      result.push(line + '</span>'.repeat(stack.length));
      line = stack.join('');
    } else if (piece.startsWith('<span')) {
      stack.push(piece);
      line += piece;
    } else if (piece === '</span>') {
      stack.pop();
      line += piece;
    } else line += piece;
  }
  result.push(line + '</span>'.repeat(stack.length));
  const size = key.length + result.reduce((length, line) => length + line.length, 0);
  if (size <= MAX_CACHE_CHARS) {
    syntaxCache.set(key, result); syntaxCacheSize += size;
    while (syntaxCacheSize > MAX_CACHE_CHARS || syntaxCache.size > 32) {
      const [oldKey, oldLines] = syntaxCache.entries().next().value!;
      syntaxCache.delete(oldKey);
      syntaxCacheSize -= oldKey.length + oldLines.reduce((length, line) => length + line.length, 0);
    }
  }
  return result;
}

export function fullContextLines(file: DiffFile): DiffLine[] {
  const oldLines = (file.oldContent ?? '').split('\n');
  const newLines = (file.newContent ?? '').split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  const result: DiffLine[] = [];
  let oldCursor = 1;
  let newCursor = 1;
  for (const hunk of file.hunks) {
    const oldBoundary = hunk.oldStart + (hunk.oldCount === 0 ? 1 : 0);
    const newBoundary = hunk.newStart + (hunk.newCount === 0 ? 1 : 0);
    while (oldCursor < oldBoundary && newCursor < newBoundary) {
      result.push({type: 'context', text: newLines[newCursor - 1] ?? oldLines[oldCursor - 1] ?? '', oldLine: oldCursor++, newLine: newCursor++});
    }
    for (const line of hunk.lines) {
      result.push(line);
      if (line.oldLine !== undefined) oldCursor = line.oldLine + 1;
      if (line.newLine !== undefined) newCursor = line.newLine + 1;
    }
  }
  while (oldCursor <= oldLines.length && newCursor <= newLines.length) {
    result.push({type: 'context', text: newLines[newCursor - 1] ?? oldLines[oldCursor - 1] ?? '', oldLine: oldCursor++, newLine: newCursor++});
  }
  return result;
}

export function uniqueId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
