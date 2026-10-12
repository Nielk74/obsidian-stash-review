import {Fragment, useMemo, useState, type ClipboardEvent} from 'react';
import {ArrowDownUp, Check, ChevronDown, ChevronRight, Copy, FileCode2, FileImage, Maximize2, MessageSquare, MessageSquarePlus, Minimize2, Plus, UnfoldVertical} from 'lucide-react';
import type {Annotation, DiffFile, DiffLayer, DiffLine, DiffSide, ReviewHost} from '../types';
import {AnnotationThread} from './AnnotationThread';
import {DeferredBlock} from './DeferredBlock';
import {escapeHtml, fileId, fullContextLines, highlightedLines} from './format';
import {changeRanges, markChangedText, type ChangeRange} from './word-diff';
import {whitespacePresentation, type ChangeMatch} from './change-search';

export interface AnnotationSelection {path: string; side: DiffSide; startLine: number; endLine: number; layer: DiffLayer}
interface DiffViewProps {
  idPrefix?: string;
  file: DiffFile;
  mode: 'unified' | 'split';
  layer: DiffLayer;
  fullContext: boolean;
  contextLoading: boolean;
  reviewed: boolean;
  collapsed?: boolean;
  defer?: boolean;
  onToggleCollapsed?: () => void;
  annotations: Annotation[];
  selection: AnnotationSelection | null;
  revealAnnotation?: Annotation | null;
  revealSearch?: ChangeMatch | null;
  searchMatches?: ChangeMatch[];
  ignoreWhitespace?: boolean;
  markdownRenderer?: ReviewHost['renderMarkdown'];
  onToggleFull: () => void;
  onCopySource?: () => void;
  onReviewed: () => void;
  onSelectLine: (side: DiffSide, line: number, extend: boolean) => void;
  onSaveAnnotation: (body: string) => void;
  onCancelAnnotation: () => void;
  onUpdateAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (id: string) => void;
}

interface CodeCell {index: number; text: string; side?: DiffSide}
function copyCodeSelection(event: ClipboardEvent<HTMLDivElement>, cells: CodeCell[]): void {
  if ((event.target as HTMLElement).closest('textarea, input')) return;
  const selection = event.currentTarget.ownerDocument.defaultView?.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return;
  const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as HTMLElement : selection.anchorNode?.parentElement;
  const side = event.currentTarget.classList.contains('sr-diff-split') ? anchor?.closest<HTMLElement>('.sr-code')?.dataset.side : undefined;
  let first: {index: number; text: string} | undefined, last: typeof first;
  for (const code of event.currentTarget.querySelectorAll<HTMLElement>('.sr-code')) {
    if (side && code.dataset.side !== side || !range.intersectsNode(code)) continue;
    const clipped = event.currentTarget.ownerDocument.createRange();
    clipped.selectNodeContents(code);
    if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0) clipped.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0) clipped.setEnd(range.endContainer, range.endOffset);
    const cell = {index: Number(code.dataset.codeIndex), text: clipped.toString()};
    first ??= cell; last = cell;
  }
  if (!first || !last) return;
  // Source indices preserve selected lines whose DOM has not been mounted yet.
  const lines = cells.filter(cell => cell.index >= first!.index && cell.index <= last!.index && (!side || cell.side === side))
    .map(cell => cell.index === first!.index ? first!.text : cell.index === last!.index ? last!.text : cell.text);
  if (lines.length) {event.clipboardData.setData('text/plain', lines.join('\n')); event.preventDefault();}
}

function DeferredRows<T>({rows, renderRow, reveal}: {rows: T[]; renderRow: (row: T, index: number) => React.ReactNode; reveal: (row: T) => boolean}) {
  if (rows.length <= 200) return <>{rows.map(renderRow)}</>;
  return <>{Array.from({length: Math.ceil(rows.length / 200)}, (_, chunk) => {
    const start = chunk * 200, group = rows.slice(start, start + 200);
    return <DeferredBlock key={chunk} height={group.length * 22} force={group.some(reveal)} render={() => group.map((row, index) => renderRow(row, start + index))}/>;
  })}</>;
}

function sourceMap(file: DiffFile, side: DiffSide): Map<number, string> {
  const source = side === 'old' ? file.oldContent : file.newContent;
  if (source !== undefined) return new Map(highlightedLines(source, file.path).map((html, index) => [index + 1, html]));
  const visible: {number: number; text: string}[] = [];
  for (const hunk of file.hunks) for (const line of hunk.lines) {
    const number = side === 'old' ? line.oldLine : line.newLine;
    if (number !== undefined) visible.push({number, text: line.text});
  }
  const highlighted = highlightedLines(visible.map(line => line.text.replace(/\r$/, '')).join('\n'), file.path);
  return new Map(visible.map((line, index) => [line.number, highlighted[index] ?? escapeHtml(line.text)]));
}

interface SplitRow {old?: DiffLine; next?: DiffLine; info?: string}
function pairLines(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.type === 'context') {rows.push({old: line, next: line}); index++; continue;}
    if (line.type === 'info') {rows.push({info: line.text}); index++; continue;}
    const removed: DiffLine[] = []; const added: DiffLine[] = [];
    while (index < lines.length && lines[index].type === 'delete') removed.push(lines[index++]);
    while (index < lines.length && lines[index].type === 'add') added.push(lines[index++]);
    // A standalone addition can be followed by deletion; leave that deletion for the next group.
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) rows.push({old: removed[pair], next: added[pair]});
  }
  return rows;
}

function AnnotationComposer({selection, onSave, onCancel}: {selection: AnnotationSelection; onSave: (body: string) => void; onCancel: () => void}) {
  const [body, setBody] = useState('');
  return <form className="sr-composer" onSubmit={event => {event.preventDefault(); if (body.trim()) onSave(body.trim());}}>
    <div className="sr-composer-heading"><MessageSquarePlus size={16}/><strong>New annotation</strong><span>{selection.side === 'old' ? 'Old' : 'New'} line{selection.endLine !== selection.startLine ? 's' : ''} {selection.startLine}{selection.endLine !== selection.startLine ? `–${selection.endLine}` : ''}</span></div>
    <textarea aria-label="Annotation text" rows={3} placeholder="Capture a thought, question, or follow-up…" value={body} onChange={event => setBody(event.target.value)} autoFocus/>
    <div className="sr-composer-footer"><span>Shift-click another + to select a range.</span><div className="sr-form-actions"><button className="sr-button sr-button-small" type="button" onClick={onCancel}>Cancel annotation</button><button className="sr-button sr-button-primary sr-button-small" type="submit" disabled={!body.trim()}>Save annotation</button></div></div>
  </form>;
}

function DiffBody(props: DiffViewProps & {threads: Annotation[]}) {
  const {file, mode, layer, fullContext, contextLoading, selection, threads} = props;
  const localSelection = selection?.path === file.path && selection.layer === layer ? selection : null;
  const oldSyntax = useMemo(() => sourceMap(file, 'old'), [file]);
  const newSyntax = useMemo(() => sourceMap(file, 'new'), [file]);
  const canonicalSections = useMemo(() => fullContext && file.oldContent !== undefined && file.newContent !== undefined
    ? [{header: 'Full file context', lines: fullContextLines(file), oldStart: 1, newStart: 1, oldCount: 0, newCount: 0}]
    : file.hunks, [file, fullContext]);
  const sections = useMemo(() => props.ignoreWhitespace ? canonicalSections.map(section => ({...section,lines:whitespacePresentation(section.lines)})) : canonicalSections,[canonicalSections,props.ignoreWhitespace]);
  const whitespaceOnly = useMemo(() => props.ignoreWhitespace && canonicalSections.some(section => section.lines.some(line => line.type === 'add' || line.type === 'delete'))
    && !sections.some(section => section.lines.some(line => line.type === 'add' || line.type === 'delete')),[props.ignoreWhitespace,canonicalSections,sections]);
  const searchByLine = useMemo(() => {
    const result = new Map<string, ChangeMatch[]>();
    for (const match of props.searchMatches ?? []) {
      const key = `${match.side}:${match.line}`, group = result.get(key) ?? [];
      group.push(match); result.set(key,group);
    }
    return result;
  },[props.searchMatches]);
  const pairedSections = useMemo(() => sections.map(section => pairLines(section.lines)), [sections]);
  const threadsByLine = useMemo(() => {
    const result = new Map<string, Annotation[]>();
    for (const thread of threads) {
      const key = `${thread.side}:${thread.endLine}`;
      const group = result.get(key) ?? []; group.push(thread); result.set(key, group);
    }
    return result;
  }, [threads]);
  const inlinePairs = useMemo(() => {
    const result = new Map<string, SplitRow>();
    for (const rows of pairedSections) for (const row of rows) {
      if (row.old?.type !== 'delete' || row.next?.type !== 'add') continue;
      result.set(`old:${row.old.oldLine}`, row); result.set(`new:${row.next.newLine}`, row);
    }
    return result;
  }, [pairedSections]);
  const inlineRanges = useMemo(() => new Map<SplitRow, ReturnType<typeof changeRanges>>(), [pairedSections]);
  const offsets = useMemo(() => {
    let offset = 0;
    return sections.map((section, index) => {const start = offset; offset += mode === 'unified' ? section.lines.length : pairedSections[index].length * 2; return start;});
  }, [sections, pairedSections, mode]);
  const codeCells = useMemo<CodeCell[]>(() => sections.flatMap((section, sectionIndex) => mode === 'unified'
    ? section.lines.map((line, index) => ({index: offsets[sectionIndex] + index, text: line.text.replace(/\r$/, '') || ' '}))
    : pairedSections[sectionIndex].flatMap((row, index) => row.info ? [] : [
      {index: offsets[sectionIndex] + index * 2, text: row.old?.text.replace(/\r$/, '') || ' ', side: 'old' as const},
      {index: offsets[sectionIndex] + index * 2 + 1, text: row.next?.text.replace(/\r$/, '') || ' ', side: 'new' as const}
    ])), [sections, pairedSections, offsets, mode]);
  const revealLine = (line?: DiffLine) => {
    return [localSelection, props.revealAnnotation].some(target => target?.path === file.path && target.layer === layer && target.endLine === (target.side === 'old' ? line?.oldLine : line?.newLine))
      || props.revealSearch?.path === file.path && props.revealSearch.line === (props.revealSearch.side === 'old' ? line?.oldLine : line?.newLine);
  };
  const syntax = (line: DiffLine, side: DiffSide) => {
    const number = side === 'old' ? line.oldLine : line.newLine;
    const html = number === undefined ? escapeHtml(line.text) : (side === 'old' ? oldSyntax : newSyntax).get(number) ?? escapeHtml(line.text.replace(/\r$/, ''));
    const pair = inlinePairs.get(`${side}:${number}`);
    if (pair && !inlineRanges.has(pair)) inlineRanges.set(pair, changeRanges(pair.old!.text, pair.next!.text));
    const ranges = pair && inlineRanges.get(pair);
    const range: ChangeRange | undefined = ranges ? ranges[side === 'old' ? 'old' : 'next'] : undefined;
    let marked = range ? markChangedText(html, range) : html;
    for (const match of searchByLine.get(`${side}:${number}`) ?? []) marked = markChangedText(marked,match,'sr-search-match');
    return marked;
  };
  const selected = (line: DiffLine, side: DiffSide) => {
    const number = side === 'old' ? line.oldLine : line.newLine;
    return localSelection?.side === side && number !== undefined && number >= localSelection.startLine && number <= localSelection.endLine;
  };
  const afterRow = (oldLine?: number, newLine?: number) => {
    const rowThreads = [...(threadsByLine.get(`old:${oldLine}`) ?? []), ...(threadsByLine.get(`new:${newLine}`) ?? [])];
    const composerHere = localSelection && localSelection.endLine === (localSelection.side === 'old' ? oldLine : newLine);
    if (!rowThreads.length && !composerHere) return null;
    return <div className="sr-line-discussion">{rowThreads.map(annotation => <DeferredBlock key={annotation.id} height={180} force={rowThreads.length <= 25 || props.revealAnnotation?.id === annotation.id} render={() => <AnnotationThread annotation={annotation} onUpdate={props.onUpdateAnnotation} onDelete={props.onDeleteAnnotation} markdownRenderer={props.markdownRenderer}/>}/>)}
      {composerHere && <AnnotationComposer key={`${localSelection.path}-${localSelection.side}`} selection={localSelection} onSave={props.onSaveAnnotation} onCancel={props.onCancelAnnotation}/>}
    </div>;
  };
  const annotateButton = (side: DiffSide, number?: number) => number !== undefined ? <button className="sr-line-add" type="button" aria-label={`Annotate ${side} line ${number}`} title={`Annotate ${side} line ${number}. Shift-click to select a range.`} onClick={event => props.onSelectLine(side, number, event.shiftKey)}><Plus size={12}/></button> : <span className="sr-line-add-empty"/>;
  const lineNumber = (side: DiffSide, number?: number) => number === undefined ? <span/> : <button className="sr-line-number" type="button" aria-label={`Select ${side} line ${number}`} title={`${side === 'old' ? 'Original' : 'Stashed'} line ${number}. Shift-click to select a range.`} onClick={event => props.onSelectLine(side, number, event.shiftKey)}>{number}</button>;
  const splitCell = (line: DiffLine | undefined, side: DiffSide, index: number) => {
    const number = side === 'old' ? line?.oldLine : line?.newLine;
    return <div className={`sr-split-cell ${line ? `sr-line-${line.type}` : 'sr-line-empty'} ${line && selected(line, side) ? 'sr-line-selected' : ''}`}>
      <div className="sr-split-gutter">{annotateButton(side, number)}{lineNumber(side, number)}</div>
      <span className="sr-line-sign" aria-hidden="true">{line?.type === 'delete' ? '−' : line?.type === 'add' ? '+' : ' '}</span>
      <code className="sr-code" data-side={side} data-line-number={side === 'old' ? line?.oldLine : line?.newLine} data-code-index={index} dangerouslySetInnerHTML={{__html: line ? syntax(line, side) || ' ' : ' '}}/>
    </div>;
  };
  return file.binary ? <div className="sr-binary"><FileImage size={28}/><strong>Binary file changed</strong><p>A text diff is unavailable for this file.</p></div> : whitespaceOnly ? <div className="sr-file-empty"><ArrowDownUp size={20}/><p>Whitespace-only changes are hidden.</p></div> : !sections.length ? <div className="sr-file-empty"><ArrowDownUp size={20}/><p>{file.status === 'renamed' ? 'File renamed with no content changes.' : 'No text changes in this file.'}</p></div> : <div className={`sr-diff-code sr-diff-${mode}`} onCopy={event => copyCodeSelection(event, codeCells)}>
      {mode === 'split' && <div className="sr-split-labels"><span>Before</span><span>Stashed changes</span></div>}
      {sections.map((section, sectionIndex) => <Fragment key={sectionIndex}>
        {!fullContext && (section.oldStart > (sectionIndex ? sections[sectionIndex - 1].oldStart + sections[sectionIndex - 1].oldCount : 1) || section.newStart > (sectionIndex ? sections[sectionIndex - 1].newStart + sections[sectionIndex - 1].newCount : 1)) && <button className="sr-context-gap" type="button" aria-label={`Show omitted context before hunk ${sectionIndex + 1} in ${file.path}`} onClick={props.onToggleFull} disabled={contextLoading}><UnfoldVertical size={14}/><span>Show omitted context</span></button>}
        <div className="sr-hunk-header"><span className="sr-hunk-icon" aria-hidden="true"><UnfoldVertical size={13}/></span><code className="sr-hunk-range">{section.header.match(/^@@.*?@@/)?.[0] ?? section.header}</code>{section.header.startsWith('@@') && <code className="sr-hunk-function">{section.header.replace(/^@@.*?@@\s*/, '')}</code>}</div>
        {mode === 'unified' ? <DeferredRows key={`unified-${fullContext}`} rows={section.lines} reveal={revealLine} renderRow={(line, index) => <Fragment key={index}>
          <div className={`sr-diff-row sr-line-${line.type} ${selected(line, 'old') || selected(line, 'new') ? 'sr-line-selected' : ''}`}>
            <div className="sr-unified-gutter">{line.type === 'info' ? <span className="sr-line-add-empty"/> : annotateButton(line.type === 'delete' ? 'old' : 'new', line.type === 'delete' ? line.oldLine : line.newLine)}{lineNumber('old', line.oldLine)}{lineNumber('new', line.newLine)}</div>
            <span className="sr-line-sign" aria-hidden="true">{line.type === 'delete' ? '−' : line.type === 'add' ? '+' : line.type === 'info' ? '\\' : ' '}</span>
            <code className="sr-code" data-side={line.type === 'delete' ? 'old' : 'new'} data-line-number={line.type === 'delete' ? line.oldLine : line.newLine} data-code-index={offsets[sectionIndex] + index} dangerouslySetInnerHTML={{__html: line.type === 'info' ? escapeHtml(line.text) : syntax(line, line.type === 'delete' ? 'old' : 'new') || ' '}}/>
          </div>{afterRow(line.oldLine, line.newLine)}
        </Fragment>}/> : <DeferredRows key={`split-${fullContext}`} rows={pairedSections[sectionIndex]} reveal={row => revealLine(row.old) || revealLine(row.next)} renderRow={(row, index) => <Fragment key={index}>{row.info ? <div className="sr-diff-info"><code>{row.info}</code></div> : <div className="sr-split-row">{splitCell(row.old, 'old', offsets[sectionIndex] + index * 2)}{splitCell(row.next, 'new', offsets[sectionIndex] + index * 2 + 1)}</div>}{afterRow(row.old?.oldLine, row.next?.newLine)}</Fragment>}/>}
      </Fragment>)}
      {!fullContext && <button className="sr-context-gap" type="button" aria-label={`Show remaining context for ${file.path}`} onClick={props.onToggleFull} disabled={contextLoading}><UnfoldVertical size={14}/><span>Show full file context</span></button>}
    </div>;
}


export function DiffView(props: DiffViewProps) {
  const {file, mode, layer, fullContext, contextLoading, reviewed, annotations, selection} = props;
  const localSelection = selection?.path === file.path && selection.layer === layer ? selection : null;
  const collapsed = props.collapsed === true && !localSelection;
  const threads = useMemo(() => annotations.filter(annotation => annotation.path === file.path && annotation.layer === layer), [annotations, file.path, layer]);
  const openThreads = threads.filter(thread => !thread.resolved).length;
  return <article id={fileId(file.path, props.idPrefix)} className={`sr-diff-file ${reviewed ? 'sr-diff-reviewed' : ''} ${collapsed ? 'sr-diff-collapsed' : ''} ${props.defer ? 'sr-diff-deferred' : ''}`} data-file-path={file.path}>
    <div className="sr-diff-file-header">{props.onToggleCollapsed && <button className="sr-icon-button sr-diff-toggle" type="button" aria-label={`${collapsed ? 'Expand' : 'Collapse'} diff for ${file.path}`} aria-expanded={!collapsed} aria-controls={`${fileId(file.path, props.idPrefix)}-content`} onClick={props.onToggleCollapsed} disabled={!!localSelection} title={localSelection ? 'Save or cancel your annotation before collapsing this file' : collapsed ? 'Expand file diff' : 'Collapse file diff'}>{collapsed ? <ChevronRight size={16}/> : <ChevronDown size={16}/>}</button>}<FileCode2 size={16}/><div className="sr-diff-filename">{file.oldPath && file.oldPath !== file.path && <span>{file.oldPath} → </span>}<strong title={file.path}>{file.path}</strong></div>
      <span className={`sr-file-status sr-status-${file.status}`}>{file.untracked ? 'untracked' : file.status}</span><span className="sr-diff-stat"><span className="sr-additions">+{file.additions}</span><span className="sr-deletions">−{file.deletions}</span></span>
      {openThreads > 0 && <span className="sr-file-thread-count" title={`${openThreads} unresolved annotation${openThreads === 1 ? '' : 's'}`}><MessageSquare size={13}/>{openThreads}</span>}
      {!file.binary && props.onCopySource && <button className="sr-icon-button sr-copy-source" type="button" aria-label={`Copy ${file.status === 'deleted' ? 'original' : 'stashed'} code for ${file.path}`} title={`Copy ${file.status === 'deleted' ? 'original' : 'stashed'} file contents`} onClick={props.onCopySource}><Copy size={14}/></button>}
      {!file.binary && <button className="sr-icon-button sr-context-button" type="button" aria-label={`${fullContext ? 'Collapse full context for' : 'Show full context for'} ${file.path}`} title={fullContext ? 'Collapse full file context' : 'Show full file context'} onClick={props.onToggleFull} disabled={contextLoading}>{contextLoading ? <span className="sr-spinner"/> : fullContext ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button>}
      <label className="sr-reviewed-control"><input type="checkbox" aria-label={`Mark ${file.path} as reviewed`} checked={reviewed} onChange={props.onReviewed}/><span className="sr-reviewed-check"><Check size={12}/></span><span>Viewed</span></label>
    </div>
    {collapsed ? <div className="sr-collapsed-summary">{reviewed ? <Check size={13}/> : <FileCode2 size={13}/>}<span>{reviewed ? 'Viewed' : 'Diff collapsed'}{openThreads > 0 ? ` · ${openThreads} unresolved annotation${openThreads === 1 ? '' : 's'}` : ''}</span></div> : <div id={`${fileId(file.path, props.idPrefix)}-content`} className="sr-diff-content"><DeferredBlock height={Math.max(100, (file.additions + file.deletions + file.hunks.length * 8) * 22)} force={!props.defer || !!localSelection || props.revealAnnotation?.path === file.path || props.revealSearch?.path === file.path} render={() => <DiffBody {...props} threads={threads}/>}/></div>}
    {file.truncated && <div className="sr-file-notice">This file is too large to load in full. The available diff remains reviewable.</div>}
  </article>;
}
