import {memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent} from 'react';
import {Binary, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileMinus2, FilePenLine, FilePlus2, FileQuestion, FileSymlink, Folder, FolderOpen} from 'lucide-react';
import type {DiffFile} from '../types';
import {ancestorFolderPaths, buildFileTree, filterFileTree, flattenFileTree, folderPaths, matchesFileQuery, type FileTreeNode, type FileTreeRow} from './file-tree';
import {DeferredBlock} from './DeferredBlock';

export interface FileTreeProps {
  files: DiffFile[];
  activePath: string;
  reviewedFiles: string[];
  query: string;
  onSelect(path: string): void;
  layout?: 'tree' | 'list';
  scopeKey: string;
  revealKey?: string;
}

const storagePrefix = 'stash-review:file-tree:';

function readCollapsed(scopeKey: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storagePrefix + scopeKey) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
  } catch {return new Set();}
}

function describeFile(file: DiffFile, reviewed: boolean): string {
  return [file.path, file.status, file.oldPath && file.oldPath !== file.path ? `renamed from ${file.oldPath}` : '', file.untracked ? 'untracked' : '', file.binary ? 'binary' : `${file.additions} additions, ${file.deletions} deletions`, reviewed ? 'viewed' : 'not viewed'].filter(Boolean).join(', ');
}

function FileIcon({file}: {file: DiffFile}) {
  const Icon = file.binary ? Binary : file.untracked ? FileQuestion : file.status === 'added' ? FilePlus2 : file.status === 'deleted' ? FileMinus2 : file.status === 'renamed' ? FileSymlink : FilePenLine;
  return <Icon size={14} className={`sr-tree-icon sr-status-${file.status}${file.untracked ? ' sr-status-untracked' : ''}`} aria-hidden="true"/>;
}

function sameNavigation(left: FileTreeProps, right: FileTreeProps): boolean {
  if (left.activePath !== right.activePath || left.query !== right.query || left.layout !== right.layout || left.scopeKey !== right.scopeKey || left.revealKey !== right.revealKey || left.onSelect !== right.onSelect) return false;
  if (left.reviewedFiles !== right.reviewedFiles && (left.reviewedFiles.length !== right.reviewedFiles.length || left.reviewedFiles.some((path, index) => path !== right.reviewedFiles[index]))) return false;
  // Source hydration and hunk changes do not affect navigation. Compare every
  // field used by tree labels, filtering, icons and progress before reusing it.
  return left.files === right.files || left.files.length === right.files.length && left.files.every((file, index) => {
    const next = right.files[index];
    return file.path === next.path && file.oldPath === next.oldPath && file.status === next.status && file.binary === next.binary && file.untracked === next.untracked && file.additions === next.additions && file.deletions === next.deletions;
  });
}

export const FileTree = memo(function FileTree({files, activePath, reviewedFiles, query, onSelect, layout = 'tree', scopeKey, revealKey = ''}: FileTreeProps) {
  const [expansion, setExpansion] = useState(() => ({scopeKey, collapsed: readCollapsed(scopeKey)}));
  const [focusedKey, setFocusedKey] = useState(`file:${activePath}`);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousActive = useRef({scopeKey, path: activePath, revealKey: ''});
  const tree = useMemo(() => buildFileTree(files, reviewedFiles), [files, reviewedFiles]);
  const filteredTree = useMemo(() => filterFileTree(tree, query), [tree, query]);
  const allFolders = useMemo(() => folderPaths(tree), [tree]);
  const collapsed = expansion.scopeKey === scopeKey ? expansion.collapsed : readCollapsed(scopeKey);
  const searching = Boolean(query.trim());
  const rows = useMemo<FileTreeRow[]>(() => layout === 'tree' ? flattenFileTree(filteredTree, collapsed, searching) : files.filter(file => matchesFileQuery(file, query)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0).map((file, index, all) => ({node: {kind: 'file', key: `file:${file.path}`, name: file.path.slice(file.path.lastIndexOf('/') + 1), path: file.path, parentPath: file.path.slice(0, Math.max(0, file.path.lastIndexOf('/'))), file, fileCount: 1, reviewedCount: Number(reviewedFiles.includes(file.path)), additions: file.additions, deletions: file.deletions}, depth: 0, position: index + 1, siblings: all.length})), [layout, filteredTree, collapsed, searching, files, query, reviewedFiles]);
  const effectiveFocus = rows.some(row => row.node.key === focusedKey) ? focusedKey : rows.find(row => row.node.path === activePath && row.node.kind === 'file')?.node.key ?? rows[0]?.node.key;

  useEffect(() => {
    setExpansion(previous => previous.scopeKey === scopeKey ? previous : {scopeKey, collapsed: readCollapsed(scopeKey)});
  }, [scopeKey]);

  useEffect(() => {
    if (expansion.scopeKey !== scopeKey) return;
    try {window.localStorage.setItem(storagePrefix + scopeKey, JSON.stringify([...expansion.collapsed]));} catch { /* Obsidian/browser storage may be unavailable. Navigation still works. */ }
  }, [expansion, scopeKey]);

  // A thread can select a file from outside this navigator. Reveal its folders
  // once when the target changes, while keeping later manual collapses intact.
  useEffect(() => {
    // Filter previews can temporarily point at a different file. They must not
    // overwrite the folder state restored when the search is cleared.
    if (searching) return;
    const previous = previousActive.current;
    previousActive.current = {scopeKey, path: activePath, revealKey};
    if (previous.scopeKey !== scopeKey && !revealKey) return;
    if (previous.path === activePath && (!revealKey || previous.revealKey === revealKey)) return;
    setFocusedKey(`file:${activePath}`);
    setExpansion(current => {
      const next = new Set(current.scopeKey === scopeKey ? current.collapsed : readCollapsed(scopeKey));
      for (const path of ancestorFolderPaths(activePath)) next.delete(path);
      return {scopeKey, collapsed: next};
    });
  }, [activePath, scopeKey, searching, revealKey]);

  const updateCollapsed = (change: (value: Set<string>) => void) => setExpansion(previous => {
    const next = new Set(previous.scopeKey === scopeKey ? previous.collapsed : readCollapsed(scopeKey));
    change(next);
    return {scopeKey, collapsed: next};
  });
  const toggleFolder = (path: string) => updateCollapsed(next => next.has(path) ? next.delete(path) : next.add(path));
  const focusRow = (key: string) => {setFocusedKey(key); rowRefs.current.get(key)?.focus();};
  const activate = (node: FileTreeNode) => {
    setFocusedKey(node.key);
    if (node.kind === 'folder') {if (!searching) toggleFolder(node.path);}
    else onSelect(node.path);
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const row = rows[index];
    if (!row || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') focusRow(rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].node.key);
    else if (event.key === 'Home' || event.key === 'End') focusRow(rows[event.key === 'Home' ? 0 : rows.length - 1].node.key);
    else if (event.key === 'Enter' || event.key === ' ') activate(row.node);
    else if (layout === 'tree' && event.key === 'ArrowRight' && row.node.kind === 'folder') {
      if (collapsed.has(row.node.path) && !searching) updateCollapsed(next => next.delete(row.node.path));
      else if (rows[index + 1]?.depth > row.depth) focusRow(rows[index + 1].node.key);
    } else if (layout === 'tree' && event.key === 'ArrowLeft') {
      if (row.node.kind === 'folder' && !collapsed.has(row.node.path) && !searching) updateCollapsed(next => next.add(row.node.path));
      else if (row.node.parentPath) focusRow(`folder:${row.node.parentPath}`);
    }
  };

  return <div className={`sr-file-tree sr-file-tree-${layout}`}>
    {layout === 'tree' && allFolders.length > 0 && <div className="sr-tree-tools"><span>{searching ? 'Matching paths expanded' : 'Changed files only'}</span><div><button type="button" aria-label="Expand all folders" title="Expand all folders" disabled={searching || !allFolders.some(path => collapsed.has(path))} onClick={() => updateCollapsed(next => allFolders.forEach(path => next.delete(path)))}><ChevronsUpDown size={13}/></button><button type="button" aria-label="Collapse all folders" title="Collapse all folders" disabled={searching || allFolders.every(path => collapsed.has(path))} onClick={() => {setFocusedKey(rows[0]?.node.key ?? ''); updateCollapsed(next => allFolders.forEach(path => next.add(path)));}}><ChevronsDownUp size={13}/></button></div></div>}
    <div className="sr-tree-items" role="tree" aria-label="Changed files">
      {rows.map((row, index) => {
        const node = row.node;
        const expanded = node.kind === 'folder' && (searching || !collapsed.has(node.path));
        const viewed = node.reviewedCount === node.fileCount;
        return <button type="button" key={node.key}
          ref={element => {if (element) rowRefs.current.set(node.key, element); else rowRefs.current.delete(node.key);}}
          role="treeitem" aria-level={row.depth + 1} aria-posinset={row.position} aria-setsize={row.siblings}
          aria-expanded={node.kind === 'folder' ? expanded : undefined}
          aria-selected={node.kind === 'file' ? activePath === node.path : undefined}
          aria-disabled={node.kind === 'folder' && searching ? true : undefined}
          aria-label={node.kind === 'folder' ? `${node.path}, ${node.fileCount} changed ${node.fileCount === 1 ? 'file' : 'files'}, ${node.reviewedCount} viewed` : describeFile(node.file, viewed)}
          tabIndex={effectiveFocus === node.key ? 0 : -1} data-path={node.path} data-tree-path={node.path} data-kind={node.kind}
          className={`sr-tree-item sr-tree-${node.kind}${node.kind === 'file' && activePath === node.path ? ' sr-active' : ''}${viewed ? ' sr-tree-reviewed' : ''}`}
          style={{'--sr-tree-depth': row.depth} as CSSProperties}
          onFocus={() => setFocusedKey(node.key)} onClick={() => activate(node)} onKeyDown={event => onKey(event, index)}
          title={node.kind === 'file' && node.file.oldPath && node.file.oldPath !== node.path ? `${node.file.oldPath} → ${node.path}` : node.path}>
          <DeferredBlock height={21} className="sr-tree-item-body" force={rows.length <= 100 || node.key === effectiveFocus || node.kind === 'file' && node.path === activePath} render={() => <>
          <span className="sr-tree-chevron" aria-hidden="true">{node.kind === 'folder' ? expanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/> : null}</span>
          {node.kind === 'folder' ? expanded ? <FolderOpen size={14} className="sr-tree-icon" aria-hidden="true"/> : <Folder size={14} className="sr-tree-icon" aria-hidden="true"/> : <FileIcon file={node.file}/>}
          <span className="sr-tree-name"><span>{node.name}</span>{layout === 'list' && node.parentPath && <small className="sr-tree-parent">{node.parentPath}</small>}</span>
          {node.kind === 'folder' ? <span className="sr-tree-folder-count">{node.fileCount}</span> : node.file.binary ? <span className="sr-tree-binary">Binary</span> : <span className="sr-tree-stats"><span className="sr-additions">+{node.additions}</span><span className="sr-deletions">−{node.deletions}</span></span>}
          <span className="sr-tree-viewed" title={node.kind === 'folder' ? `${node.reviewedCount}/${node.fileCount} viewed` : viewed ? 'Viewed' : 'Not viewed'}>{viewed ? <Check size={12} aria-hidden="true"/> : node.kind === 'folder' && node.reviewedCount > 0 ? <span>{node.reviewedCount}/{node.fileCount}</span> : null}</span>
          </>}/>
        </button>;
      })}
      {!rows.length && <p className="sr-tree-empty">{searching ? 'No matching changed files' : 'No changed files'}</p>}
    </div>
  </div>;
}, sameNavigation);
