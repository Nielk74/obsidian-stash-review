import {describe, expect, it} from 'vitest';
import {annotationSearchText, findChanges, indexChanges, whitespacePresentation} from '../src/ui/change-search';
import {markChangedText} from '../src/ui/word-diff';
import {codeFence} from '../src/review-store';
import type {Annotation, DiffFile, DiffLine} from '../src/types';

const file: DiffFile = {path:'src/é.ts',status:'modified',additions:1,deletions:1,binary:false,untracked:false,
  hunks:[{header:'@@ -7 +7 @@',oldStart:7,oldCount:1,newStart:7,newCount:1,lines:[
    {type:'delete',oldLine:7,text:'const old = ".*";'}, {type:'add',newLine:7,text:'const next = ".*";'}]}]};

describe('search and whitespace presentation', () => {
  it('finds literal matches with original sides and coordinates without treating input as a regex', () => {
    expect(findChanges(indexChanges([file]),'.*').map(match => [match.path,match.side,match.line,match.start,match.end]))
      .toEqual([['src/é.ts','old',7,13,15],['src/é.ts','new',7,14,16]]);
    expect(findChanges(indexChanges([file]),'CONST').map(match => match.start)).toEqual([0,0]);
    expect(findChanges(indexChanges([file]),'')).toEqual([]);
  });
  it('keeps UTF-16 source offsets when lowercasing expands a Unicode character', () => {
    const value = {...file,hunks:[{...file.hunks[0],lines:[{type:'add' as const,newLine:7,text:'İ + VALUE value'}]}]};
    expect(findChanges(indexChanges([value]),'value').map(match => [match.start,match.end])).toEqual([[4,9],[10,15]]);
  });
  it('hides whitespace-only pairs while retaining real additions and original line numbers', () => {
    const rows: DiffLine[] = [{type:'delete',oldLine:2,text:'a = 1;'}, {type:'add',newLine:2,text:'a  =  1;'}, {type:'add',newLine:3,text:'realChange();'}];
    const before = structuredClone(rows);
    expect(whitespacePresentation(rows)).toEqual([{type:'add',newLine:3,text:'realChange();'}]);
    expect(rows).toEqual(before);
  });
  it('handles indentation, CRLF and blank-line noise without hiding meaningful reordering', () => {
    const rows: DiffLine[] = [{type:'delete',oldLine:1,text:' A\r'}, {type:'delete',oldLine:2,text:'B'},
      {type:'add',newLine:1,text:'B'}, {type:'add',newLine:2,text:'\tA'}, {type:'add',newLine:3,text:'   '}];
    expect(whitespacePresentation(rows)).toEqual([{type:'delete',oldLine:2,text:'B'},{type:'add',newLine:1,text:'B'}]);
    expect(whitespacePresentation([{type:'delete',oldLine:1,text:'\t x'}, {type:'add',newLine:1,text:'x  '}])).toEqual([]);
  });
  it('indexes annotation paths and replies as well as the original body', () => {
    const annotation: Annotation = {id:'note',path:'src/App.ts',side:'new',layer:'all',startLine:1,endLine:1,body:'Original thought',createdAt:'',updatedAt:'',resolved:false,replies:[{id:'reply',body:'Try debounce',createdAt:''}]};
    const text = annotationSearchText(annotation);
    expect(text).toContain('src/app.ts'); expect(text).toContain('original thought'); expect(text).toContain('try debounce');
  });
  it('highlights escaped syntax output with a separate search class without changing source', () => {
    const html = '<span class="hljs-string">&lt;safe&gt;</span>';
    expect(markChangedText(html,{start:1,end:5},'sr-search-match')).toBe('<span class="hljs-string">&lt;<mark class="sr-search-match">safe</mark>&gt;</span>');
  });
  it('uses a safe Markdown fence for code containing both common delimiters', () => {
    const source = '```ts\n<literal>\n```\n~~~\nend';
    const fenced = codeFence(source,'typescript');
    expect(fenced).toBe('````typescript\n```ts\n<literal>\n```\n~~~\nend\n````');
  });
});
