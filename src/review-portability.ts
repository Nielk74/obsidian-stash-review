import {DIFF_LAYERS, isRecord, loadPluginData, readMetadata} from './review-store';
import type {DiffFile, DiffHunk, DiffLayer, DiffLine, SavedLayer, Stash, StashMetadata} from './types';

export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const hashPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const layerSet = new Set<string>(DIFF_LAYERS);
function fail(message: string): never {throw new Error(`Invalid review package: ${message}`);}
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

export interface PortableReview {
  format: 'stash-review'; version: 1;
  repository: {id: string; name: string}; stash: Stash;
  metadata: StashMetadata; layers: Record<DiffLayer, SavedLayer>;
}

export function validRepositoryId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
}

export function validSavedPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\0')
    && !value.startsWith('/') && !value.startsWith('\\') && !/^[a-z]:[\\/]/i.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

export function fileFingerprint(file: Pick<DiffFile, 'path' | 'oldPath' | 'oldMode' | 'newMode' | 'oldBlob' | 'newBlob' | 'untracked'>): string | undefined {
  if (!file.oldMode || !file.newMode || !file.oldBlob || !file.newBlob) return undefined;
  return JSON.stringify([file.oldMode, file.oldBlob, file.newMode, file.newBlob, file.oldPath ?? file.path, file.path, file.untracked]);
}

function parseFile(raw: unknown): DiffFile {
  if (!isRecord(raw) || !validSavedPath(raw.path) || raw.oldPath !== undefined && !validSavedPath(raw.oldPath)) fail('invalid saved path');
  const value = raw as Record<string, unknown>;
  if (!['added','modified','deleted','renamed'].includes(String(value.status)) || typeof value.binary !== 'boolean' || typeof value.untracked !== 'boolean'
    || !integer(value.additions) || !integer(value.deletions) || !Array.isArray(value.hunks) || value.hunks.length > 100000) fail('invalid file metadata');
  for (const mode of [value.oldMode, value.newMode]) if (mode !== undefined && (typeof mode !== 'string' || !/^[0-7]{6}$/.test(mode))) fail('invalid blob mode');
  for (const blob of [value.oldBlob, value.newBlob]) if (blob !== undefined && (typeof blob !== 'string' || !hashPattern.test(blob))) fail('invalid blob identity');
  for (const source of [value.oldContent,value.newContent]) if (source !== undefined && typeof source !== 'string') fail('invalid file source');
  const oldSource = typeof value.oldContent === 'string' ? value.oldContent.split('\n') : undefined;
  const newSource = typeof value.newContent === 'string' ? value.newContent.split('\n') : undefined;
  let additions = 0, deletions = 0, oldBoundary = 0, newBoundary = 0, rowCount = 0;
  const hunks = (value.hunks as unknown[]).map((rawHunk): DiffHunk => {
    if (!isRecord(rawHunk) || typeof rawHunk.header !== 'string' || !integer(rawHunk.oldStart) || !integer(rawHunk.newStart)
      || !integer(rawHunk.oldCount) || !integer(rawHunk.newCount) || !Array.isArray(rawHunk.lines)
      || rawHunk.oldStart < oldBoundary || rawHunk.newStart < newBoundary
      || rawHunk.oldCount > 0 && rawHunk.oldStart === 0 || rawHunk.newCount > 0 && rawHunk.newStart === 0) fail('invalid hunk ranges');
    const hunk = rawHunk as unknown as DiffHunk;
    let oldLine = hunk.oldStart, newLine = hunk.newStart;
    const lines = hunk.lines.map((rawLine): DiffLine => {
      if (++rowCount > 1000000 || !isRecord(rawLine) || typeof rawLine.text !== 'string' || !['context','add','delete','info'].includes(String(rawLine.type))) fail('invalid diff line');
      const line = rawLine as unknown as DiffLine;
      if (line.type === 'info') {
        if (line.oldLine !== undefined || line.newLine !== undefined) fail('invalid info line coordinates');
        return {type: 'info', text: line.text};
      }
      if (line.type !== 'add') {
        if (line.oldLine !== oldLine || oldSource && oldSource[oldLine - 1] !== line.text) fail('old source or line coordinates disagree');
        oldLine++;
      } else if (line.oldLine !== undefined) fail('invalid added line coordinates');
      if (line.type !== 'delete') {
        if (line.newLine !== newLine || newSource && newSource[newLine - 1] !== line.text) fail('new source or line coordinates disagree');
        newLine++;
      } else if (line.newLine !== undefined) fail('invalid deleted line coordinates');
      if (line.type === 'add') additions++;
      if (line.type === 'delete') deletions++;
      return {type: line.type, text: line.text, ...(line.oldLine === undefined ? {} : {oldLine: line.oldLine}), ...(line.newLine === undefined ? {} : {newLine: line.newLine})};
    });
    if (oldLine - hunk.oldStart !== hunk.oldCount || newLine - hunk.newStart !== hunk.newCount) fail('hunk line counts disagree');
    oldBoundary = oldLine; newBoundary = newLine;
    return {header: hunk.header, oldStart: hunk.oldStart, oldCount: hunk.oldCount, newStart: hunk.newStart, newCount: hunk.newCount, lines};
  });
  if (additions !== value.additions || deletions !== value.deletions) fail('file line counts disagree');
  const file: DiffFile = {path: value.path as string, status: value.status as DiffFile['status'], additions, deletions, binary: value.binary as boolean, untracked: value.untracked as boolean, hunks,
    ...(value.oldPath === undefined ? {} : {oldPath: value.oldPath as string}),
    ...(value.oldBlob === undefined ? {} : {oldBlob: value.oldBlob as string}), ...(value.newBlob === undefined ? {} : {newBlob: value.newBlob as string}),
    ...(value.oldMode === undefined ? {} : {oldMode: value.oldMode as string}), ...(value.newMode === undefined ? {} : {newMode: value.newMode as string}),
    ...(value.oldContent === undefined ? {} : {oldContent: value.oldContent as string}), ...(value.newContent === undefined ? {} : {newContent: value.newContent as string}),
    ...(value.truncated === true ? {truncated: true} : {}), ...(value.sourceUnavailable === true ? {sourceUnavailable: true} : {})};
  if (value.fingerprint !== undefined) {
    if (typeof value.fingerprint !== 'string' || value.fingerprint !== fileFingerprint(file)) fail('fingerprint does not match blob metadata');
    file.fingerprint = value.fingerprint;
  } else if ([file.oldBlob,file.newBlob,file.oldMode,file.newMode].some(field => field !== undefined)) fail('missing fingerprint');
  return file;
}

export function parseSavedLayer(raw: unknown): SavedLayer {
  if (!isRecord(raw) || !integer(raw.context) || raw.context > 500 || !Array.isArray(raw.files) || raw.files.length > 10000) fail('invalid saved layer');
  const files = raw.files.map(parseFile), paths = new Set<string>();
  for (const file of files) {if (paths.has(file.path)) fail('duplicate file path in layer'); paths.add(file.path);}
  return {context: raw.context, files};
}

function parseMetadata(raw: unknown): StashMetadata {
  if (!isRecord(raw) || typeof raw.title !== 'string' || typeof raw.description !== 'string' || typeof raw.pinned !== 'boolean'
    || !stringArray(raw.tags) || !stringArray(raw.reviewedFiles) || !Array.isArray(raw.annotations) || raw.annotations.length > 10000) fail('invalid review metadata');
  for (const path of raw.reviewedFiles as string[]) if (!validSavedPath(path)) fail('invalid reviewed file path');
  if (raw.reviewedByLayer !== undefined) {
    if (!isRecord(raw.reviewedByLayer)) fail('invalid progress layer');
    for (const [layer, paths] of Object.entries(raw.reviewedByLayer)) if (!layerSet.has(layer) || !stringArray(paths) || !paths.every(validSavedPath)) fail('invalid progress layer');
  }
  if (raw.continuedFrom !== undefined && (typeof raw.continuedFrom !== 'string' || !hashPattern.test(raw.continuedFrom))) fail('invalid predecessor hash');
  const ids = new Set<string>();
  for (const item of raw.annotations as unknown[]) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !validSavedPath(item.path)
      || typeof item.body !== 'string' || !['old','new'].includes(String(item.side)) || !layerSet.has(String(item.layer))
      || !integer(item.startLine, 1) || !integer(item.endLine, 1) || item.endLine < item.startLine
      || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || typeof item.resolved !== 'boolean'
      || !Array.isArray(item.replies) || item.replies.length > 10000) fail('invalid annotation path, layer or line range');
    ids.add(item.id);
    const replyIds = new Set<string>();
    for (const reply of item.replies as unknown[]) {
      if (!isRecord(reply) || typeof reply.id !== 'string' || !reply.id || replyIds.has(reply.id) || typeof reply.body !== 'string' || typeof reply.createdAt !== 'string') fail('invalid annotation reply');
      replyIds.add(reply.id);
    }
    if (item.excerpt !== undefined && (!isRecord(item.excerpt) || typeof item.excerpt.text !== 'string' || !integer(item.excerpt.startLine, 1))) fail('invalid annotated excerpt');
  }
  const data = loadPluginData({reviews: {portable: {snapshot: raw}}});
  return readMetadata(data, 'portable', 'snapshot');
}

function validateAnnotatedCode(metadata:StashMetadata,layers:Record<DiffLayer,SavedLayer>):void {
  const files=new Map(DIFF_LAYERS.map(layer=>[layer,new Map(layers[layer].files.map(file=>[file.path,file]))]));
  for(const note of metadata.annotations) {
    const excerpt=note.excerpt;
    if(excerpt && (excerpt.startLine!==note.startLine || excerpt.text.split('\n').length>note.endLine-note.startLine+1))fail('annotated excerpt does not match its line range');
    const file=files.get(note.layer)?.get(note.path);
    if(!file || file.binary || file.sourceUnavailable || file.oldMode==='160000' || file.newMode==='160000')continue;
    const source=!file.truncated ? note.side==='old'?file.oldContent:file.newContent : undefined;
    let expected:string|undefined;
    if(source!==undefined) {
      const lines=source.split('\n');if(lines.at(-1)==='')lines.pop();
      if(note.endLine>lines.length)fail('annotation line range exceeds available source');
      expected=lines.slice(note.startLine-1,note.endLine).join('\n');
    } else if(excerpt) {
      const rows=new Map<number,string>();
      for(const hunk of file.hunks)for(const line of hunk.lines){const number=note.side==='old'?line.oldLine:line.newLine;if(number!==undefined)rows.set(number,line.text);}
      const selected:string[]=[];
      for(let number=note.startLine;number<=note.endLine;number++){const text=rows.get(number);if(text===undefined)break;selected.push(text);}
      if(selected.length===note.endLine-note.startLine+1)expected=selected.join('\n');
    }
    if(excerpt && expected!==undefined && (excerpt.truncated?!expected.startsWith(excerpt.text):expected!==excerpt.text))fail('annotated excerpt contradicts captured source');
  }
}

export function parsePortableReview(source: string): PortableReview {
  if (source.length > MAX_PACKAGE_BYTES || new TextEncoder().encode(source).byteLength > MAX_PACKAGE_BYTES) fail('package exceeds the 32 MiB size limit');
  let raw: unknown;
  try {raw = JSON.parse(source);} catch {fail('malformed JSON');}
  if (!isRecord(raw) || raw.format !== 'stash-review' || raw.version !== 1 || !isRecord(raw.repository)
    || !validRepositoryId(raw.repository.id) || typeof raw.repository.name !== 'string' || !isRecord(raw.stash) || !isRecord(raw.layers)) fail('unsupported package format');
  const value = raw as Record<string, unknown>, repository = value.repository as {id: string; name: string}, s = value.stash as Record<string, unknown>;
  if (typeof s.hash !== 'string' || !hashPattern.test(s.hash) || typeof s.baseHash !== 'string' || !hashPattern.test(s.baseHash) || s.hash.length !== s.baseHash.length
    || typeof s.message !== 'string' || typeof s.branch !== 'string' || typeof s.ref !== 'string' || typeof s.createdAt !== 'string') fail('invalid stash identity');
  const layers = Object.fromEntries(DIFF_LAYERS.map(layer => [layer, parseSavedLayer((value.layers as Record<string, unknown>)[layer])])) as Record<DiffLayer, SavedLayer>;
  const metadata=parseMetadata(value.metadata);validateAnnotatedCode(metadata,layers);
  return {format: 'stash-review', version: 1, repository: {id: repository.id, name: repository.name},
    stash: {hash: s.hash, baseHash: s.baseHash, message: s.message, branch: s.branch, ref: s.ref, createdAt: s.createdAt}, metadata, layers};
}

export function serializePortableReview(review: PortableReview): string {
  const normalized = parsePortableReview(JSON.stringify(review));
  const source = JSON.stringify(normalized);
  if (new TextEncoder().encode(source).byteLength > MAX_PACKAGE_BYTES) fail('package exceeds the 32 MiB size limit');
  return source;
}
