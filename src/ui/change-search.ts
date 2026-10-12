import type {Annotation, DiffFile, DiffLine, DiffSide} from '../types';

export interface ChangeMatch {path: string; side: DiffSide; line: number; start: number; end: number}
interface SearchRow {path: string; side: DiffSide; line: number; text: string; lower: string; offsets?: number[]}
export interface ChangeIndex {rows: SearchRow[]}

export function indexChanges(files: readonly DiffFile[]): ChangeIndex {
  const rows: SearchRow[] = [];
  for (const file of files) for (const hunk of file.hunks) for (const line of hunk.lines) {
    if (line.type === 'info') continue;
    const side: DiffSide = line.type === 'delete' || line.newLine === undefined ? 'old' : 'new';
    const number = side === 'old' ? line.oldLine : line.newLine;
    if (number === undefined) continue;
    const lower = line.text.toLowerCase();
    let offsets: number[] | undefined;
    if (lower.length !== line.text.length) {
      offsets = []; let sourceOffset = 0;
      for (const character of line.text) {
        for (let index = 0; index < character.toLowerCase().length; index++) offsets.push(sourceOffset);
        sourceOffset += character.length;
      }
      offsets.push(line.text.length);
    }
    rows.push({path:file.path,side,line:number,text:line.text,lower,...(offsets ? {offsets} : {})});
  }
  return {rows};
}

export function findChanges(index: ChangeIndex, query: string): ChangeMatch[] {
  if (!query) return [];
  const term = query.toLowerCase(), matches: ChangeMatch[] = [];
  for (const row of index.rows) {
    let from = 0;
    for (;;) {
      const position = row.lower.indexOf(term,from);
      if (position < 0) break;
      matches.push({path:row.path,side:row.side,line:row.line,start:row.offsets?.[position] ?? position,end:row.offsets?.[position + term.length] ?? position + term.length});
      from = position + term.length;
    }
  }
  return matches;
}

/** Hide equivalent ordered pairs; never change canonical row coordinates. */
export function whitespacePresentation(lines: readonly DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [], normalized = (value: string) => value.replace(/[ \t\r]/g,'');
  for (let index = 0; index < lines.length;) {
    if (lines[index].type !== 'add' && lines[index].type !== 'delete') {result.push(lines[index++]); continue;}
    const block: DiffLine[] = [];
    while (index < lines.length && ['add','delete','info'].includes(lines[index].type)) block.push(lines[index++]);
    const hidden = new Set<DiffLine>(), additions = new Map<string,{rows: Array<{line: DiffLine; index: number}>; cursor: number}>();
    block.forEach((line, position) => {
      if (line.type !== 'add' && line.type !== 'delete') return;
      const text = normalized(line.text);
      if (!text) {hidden.add(line); return;}
      if (line.type === 'add') {
        const group = additions.get(text) ?? {rows:[],cursor:0};
        group.rows.push({line,index:position}); additions.set(text,group);
      }
    });
    let lastMatch = -1;
    for (const line of block) if (line.type === 'delete' && !hidden.has(line)) {
      const group = additions.get(normalized(line.text));
      if (!group) continue;
      while (group.cursor < group.rows.length && group.rows[group.cursor].index <= lastMatch) group.cursor++;
      const match = group.rows[group.cursor++];
      if (match) {hidden.add(line); hidden.add(match.line); lastMatch = match.index;}
    }
    result.push(...block.filter(line => !hidden.has(line)));
  }
  return result;
}

export function annotationSearchText(annotation: Annotation): string {
  return [annotation.path,annotation.body,...annotation.replies.map(reply => reply.body)].join('\n').toLowerCase();
}
