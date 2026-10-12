export interface Repository {
  id: string;
  path: string;
  name: string;
  branch: string;
  dirty: boolean;
}

export interface Stash {
  hash: string;
  ref: string;
  message: string;
  branch: string;
  createdAt: string;
  baseHash: string;
}

export type DiffLayer = 'all' | 'staged' | 'unstaged';
export type DiffSide = 'old' | 'new';
export interface ReviewTarget {
  repositoryId: string;
  stashHash: string;
  layer?: DiffLayer;
  file?: string;
}
export interface DiffLine {
  type: 'context' | 'add' | 'delete' | 'info';
  text: string;
  oldLine?: number;
  newLine?: number;
}
export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
  hunks: DiffHunk[];
  oldContent?: string;
  newContent?: string;
  truncated?: boolean;
}

export interface AnnotationReply {
  id: string;
  body: string;
  createdAt: string;
}
export interface Annotation {
  id: string;
  path: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  layer: DiffLayer;
  body: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  replies: AnnotationReply[];
}
export interface StashMetadata {
  title: string;
  description: string;
  tags: string[];
  pinned: boolean;
  reviewedFiles: string[];
  annotations: Annotation[];
}

export const emptyMetadata = (): StashMetadata => ({
  title: '', description: '', tags: [], pinned: false, reviewedFiles: [], annotations: []
});

export interface ReviewSettings {
  repositories: string[];
  gitPath: string;
  contextLines: number;
  refreshInterval: number;
  defaultView: 'unified' | 'split';
}
export const DEFAULT_SETTINGS: ReviewSettings = {
  repositories: [], gitPath: 'git', contextLines: 5, refreshInterval: 30, defaultView: 'unified'
};

export interface PluginData {
  settings: ReviewSettings;
  reviews: Record<string, Record<string, StashMetadata>>;
  version: 1;
}

export interface ReviewHost {
  settings: ReviewSettings;
  vaultName?: string;
  openReview?(target: ReviewTarget): Promise<void>;
  subscribeMetadata?(listener: (repositoryId: string, hash: string) => void): () => void;
  // Apply against shared in-memory metadata synchronously, then persist it.
  updateMetadata?(repositoryId: string, hash: string, change: (previous: StashMetadata) => StashMetadata): {metadata: StashMetadata; saved: Promise<void>};
  listRepositories(): Promise<Repository[]>;
  addRepository(path: string): Promise<Repository>;
  listStashes(repository: Repository): Promise<Stash[]>;
  getDiff(repository: Repository, stash: Stash, layer: DiffLayer, context: number): Promise<DiffFile[]>;
  getFileContents(repository: Repository, stash: Stash, file: DiffFile, layer: DiffLayer): Promise<{oldContent: string; newContent: string; truncated?: boolean}>;
  getMetadata(repositoryId: string, hash: string): StashMetadata;
  saveMetadata(repositoryId: string, hash: string, metadata: StashMetadata): Promise<void>;
  createStash(repository: Repository, message: string, includeUntracked: boolean): Promise<void>;
  applyStash(repository: Repository, stash: Stash, restoreIndex: boolean): Promise<void>;
  dropStash(repository: Repository, stash: Stash): Promise<void>;
  restoreDroppedStash(repository: Repository, stash: Stash): Promise<void>;
  exportReview(repository: Repository, stash: Stash, metadata: StashMetadata): Promise<string>;
  notify(message: string): void;
  openSettings(): void;
}
