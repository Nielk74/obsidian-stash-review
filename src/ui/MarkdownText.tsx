import {useEffect, useRef} from 'react';
import type {ReviewHost} from '../types';

export function MarkdownText({source,renderer,className=''}: {source: string; renderer?: ReviewHost['renderMarkdown']; className?: string}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!renderer || !element.current) return;
    const dispose = renderer(source,element.current);
    return () => {dispose(); element.current?.replaceChildren();};
  },[source,renderer]);
  return <div ref={element} className={`sr-markdown ${className}`}>{renderer ? undefined : source}</div>;
}

/** Small safe preview adapter; native Obsidian owns the complete Markdown syntax. */
export function renderPreviewMarkdown(source: string, element: HTMLElement): () => void {
  const document = element.ownerDocument;
  element.replaceChildren();
  const inline = (parent: HTMLElement, text: string) => {
    const tokens = /\[\[([^\]\n]+)\]\]|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
    let from = 0;
    for (const token of text.matchAll(tokens)) {
      parent.append(document.createTextNode(text.slice(from,token.index)));
      if (token[1]) {
        const [note,label] = token[1].split('|'); const link = document.createElement('a');
        link.textContent = label || note; link.href = `#note=${encodeURIComponent(note)}`; link.className = 'internal-link'; parent.append(link);
      } else if (token[2] || token[3]) {
        const child = document.createElement(token[2] ? 'code' : 'strong'); child.textContent = token[2] || token[3]; parent.append(child);
      } else {
        const link = document.createElement('a'); link.textContent = token[4];
        link.href = /^https?:\/\//i.test(token[5]) ? token[5] : '#'; link.rel = 'noopener noreferrer'; parent.append(link);
      }
      from = token.index! + token[0].length;
    }
    parent.append(document.createTextNode(text.slice(from)));
  };
  const lines = source.split('\n');
  let list: HTMLUListElement | undefined;
  for (let index = 0; index < lines.length; index++) {
    const fence = lines[index].match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const content: string[] = [], marker = fence[1];
      while (++index < lines.length && !(lines[index].trim().startsWith(marker[0].repeat(marker.length)) && /^\s*[`~]+\s*$/.test(lines[index]))) content.push(lines[index]);
      const pre = document.createElement('pre'), code = document.createElement('code'); code.textContent = content.join('\n');
      pre.append(code); element.append(pre); list = undefined; continue;
    }
    const item = lines[index].match(/^\s*[-*]\s+(.+)$/);
    if (item) {
      if (!list) {list = document.createElement('ul'); element.append(list);}
      const li = document.createElement('li'); inline(li,item[1]); list.append(li); continue;
    }
    list = undefined;
    if (!lines[index].trim()) continue;
    const heading = lines[index].match(/^(#{1,6})\s+(.+)$/), paragraph = document.createElement(heading ? `h${heading[1].length}` : 'p');
    inline(paragraph,heading ? heading[2] : lines[index]); element.append(paragraph);
  }
  return () => element.replaceChildren();
}
