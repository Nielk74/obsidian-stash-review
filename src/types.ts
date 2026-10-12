export interface Repository {
  id: string;
  path: string;
  name: string;
  branch: string;
  dirty: boolean;
  offline?: boolean;
}

export interface Stash {
  hash: string;
  ref: string;
  message: string;
  branch: string;
  createdAt: string;
  baseHash: string;
  archived?: boolean;
  recoverable?: boolean;
  inStashList?: boolean;
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
  fingerprint?: string;
  oldBlob?: string;
  newBlob?: string;
  oldMode?: string;
  newMode?: string;
  sourceUnavailable?: boolean;
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
  excerpt?: {text: string; startLine: number; truncated?: boolean};
}
export interface StashMetadata {
  title: string;
  description: string;
  tags: string[];
  pinned: boolean;
  reviewedFiles: string[];
  annotations: Annotation[];
  reviewedByLayer?: Partial<Record<DiffLayer, string[]>>;
  fileFingerprints?: Partial<Record<DiffLayer, Record<string, string>>>;
  continuedFrom?: string;
}

export interface RepositoryBinding {id: string; name: string; paths: string[]; gitId?:string}
export interface ReviewSummary {title:string;description:string;tags:string[];pinned:boolean;openAnnotations:number}
export interface ReviewEntry {
  stash: Stash;
  archived: boolean;
  snapshotLayers: DiffLayer[];
  fingerprints: Partial<Record<DiffLayer, Record<string, string>>>;
  predecessorHash?: string;
}
export interface SavedLayer {context: number; files: DiffFile[]}

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
  version: 1 | 2;
  repositoryCatalog?: Record<string, RepositoryBinding>;
  reviewCatalog?: Record<string, Record<string, ReviewEntry>>;
}

export interface ReviewHost {
  settings: ReviewSettings;
  vaultName?: string;
  markdownSourcePath?:string;
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
  getReviewSummary?(repositoryId:string,hash:string):ReviewSummary;
  saveMetadata(repositoryId: string, hash: string, metadata: StashMetadata): Promise<void>;
  createStash(repository: Repository, message: string, includeUntracked: boolean): Promise<void>;
  applyStash(repository: Repository, stash: Stash, restoreIndex: boolean): Promise<void>;
  dropStash(repository: Repository, stash: Stash): Promise<void>;
  restoreDroppedStash(repository: Repository, stash: Stash): Promise<void>;
  exportReview(repository: Repository, stash: Stash, metadata: StashMetadata): Promise<string>;
  notify(message: string): void;
  openSettings(): void;
  listArchivedReviews?(repository: Repository): Promise<Stash[]>;
  archiveReview?(repository: Repository, stash: Stash, archived: boolean): Promise<void>;
  continueReview?(repository: Repository, stash: Stash, predecessorHash: string): Promise<void>;
  relocateRepository?(repositoryId: string, path: string): Promise<Repository>;
  exportReviewData?(repository: Repository, stash: Stash): Promise<string>;
  importReviewData?(source: string, repositoryId?: string): Promise<ReviewTarget>;
  renderMarkdown?(source: string, element: HTMLElement, sourcePath?:string): () => void;
  invalidateReads?(): void;
}
