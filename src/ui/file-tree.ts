import type {DiffFile} from '../types';

export interface FileTreeFile {
  kind: 'file';
  key: string;
  name: string;
  path: string;
  parentPath: string;
  file: DiffFile;
  fileCount: 1;
  reviewedCount: number;
  additions: number;
  deletions: number;
}

export interface FileTreeFolder {
  kind: 'folder';
  key: string;
  name: string;
  path: string;
  parentPath: string;
  children: FileTreeNode[];
  fileCount: number;
  reviewedCount: number;
  additions: number;
  deletions: number;
}

export type FileTreeNode = FileTreeFile | FileTreeFolder;
export interface FileTreeRow {
  node: FileTreeNode;
  depth: number;
  position: number;
  siblings: number;
}

// Avoid locale-dependent ordering so the same stash has the same tree on every
// machine. Original spelling is the tiebreaker; Git paths stay case-sensitive.
export function compareFileTreeNodes(left: FileTreeNode, right: FileTreeNode): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  const a = left.name.toLowerCase();
  const b = right.name.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function summarize(folder: FileTreeFolder): FileTreeFolder {
  folder.fileCount = folder.children.reduce((total, child) => total + child.fileCount, 0);
  folder.reviewedCount = folder.children.reduce((total, child) => total + child.reviewedCount, 0);
  folder.additions = folder.children.reduce((total, child) => total + child.additions, 0);
  folder.deletions = folder.children.reduce((total, child) => total + child.deletions, 0);
  return folder;
}

export function ancestorFolderPaths(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

export function matchesFileQuery(file: DiffFile, query: string): boolean {
  const term = query.trim().toLowerCase();
  return !term || file.path.toLowerCase().includes(term) || Boolean(file.oldPath?.toLowerCase().includes(term));
}

export function buildFileTree(files: DiffFile[], reviewedFiles: readonly string[] = []): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const folders = new Map<string, FileTreeFolder>();
  const reviewed = new Set(reviewedFiles);
  for (const file of files) {
    const ancestors = ancestorFolderPaths(file.path);
    let children = roots;
    for (let index = 0; index < ancestors.length; index++) {
      const path = ancestors[index];
      let folder = folders.get(path);
      if (!folder) {
        folder = {kind: 'folder', key: `folder:${path}`, path, name: path.slice(path.lastIndexOf('/') + 1), parentPath: ancestors[index - 1] ?? '', children: [], fileCount: 0, reviewedCount: 0, additions: 0, deletions: 0};
        folders.set(path, folder);
        children.push(folder);
      }
      children = folder.children;
    }
    children.push({kind: 'file', key: `file:${file.path}`, name: file.path.slice(file.path.lastIndexOf('/') + 1), path: file.path, parentPath: ancestors.at(-1) ?? '', file, fileCount: 1, reviewedCount: Number(reviewed.has(file.path)), additions: file.additions, deletions: file.deletions});
  }
  const sortAndSummarize = (nodes: FileTreeNode[]) => {
    nodes.sort(compareFileTreeNodes);
    for (const node of nodes) if (node.kind === 'folder') {sortAndSummarize(node.children); summarize(node);}
  };
  sortAndSummarize(roots);
  return roots;
}

export function filterFileTree(nodes: readonly FileTreeNode[], query: string): FileTreeNode[] {
  if (!query.trim()) return [...nodes];
  return nodes.flatMap<FileTreeNode>(node => {
    if (node.kind === 'file') return matchesFileQuery(node.file, query) ? [node] : [];
    const children = filterFileTree(node.children, query);
    return children.length ? [summarize({...node, children})] : [];
  });
}

export function folderPaths(nodes: readonly FileTreeNode[]): string[] {
  return nodes.flatMap(node => node.kind === 'folder' ? [node.path, ...folderPaths(node.children)] : []);
}

export function flattenFileTree(nodes: readonly FileTreeNode[], collapsed: ReadonlySet<string> = new Set(), revealAll = false): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const visit = (siblings: readonly FileTreeNode[], depth: number) => siblings.forEach((node, index) => {
    rows.push({node, depth, position: index + 1, siblings: siblings.length});
    if (node.kind === 'folder' && (revealAll || !collapsed.has(node.path))) visit(node.children, depth + 1);
  });
  visit(nodes, 0);
  return rows;
}
