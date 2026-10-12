import { DEFAULT_SETTINGS, emptyMetadata, type Annotation, type DiffLayer, type PluginData, type StashMetadata, type Repository, type Stash, type RepositoryBinding, type ReviewEntry } from './types';
import {createReviewLink, markdownLink} from './markdown';

export const DIFF_LAYERS: DiffLayer[] = ['all', 'staged', 'unstaged'];
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string'))] : [];
const hashes = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function safeFingerprints(value: unknown): Partial<Record<DiffLayer, Record<string, string>>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(DIFF_LAYERS.filter(layer => isRecord(value[layer])).map(layer => [layer,
    Object.fromEntries(Object.entries(value[layer] as Record<string, unknown>).filter(([, fingerprint]) => typeof fingerprint === 'string' && fingerprint.length <= 4096))]));
}

function repositoryCatalog(value: unknown): Record<string, RepositoryBinding> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, binding]) => isRecord(binding) && binding.id === id && typeof binding.name === 'string')
    .map(([id, raw]) => {const binding = raw as unknown as RepositoryBinding; return [id, {id, name: binding.name, paths: strings(binding.paths)}];}));
}

function reviewCatalog(value: unknown): Record<string, Record<string, ReviewEntry>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entries]) => isRecord(entries)).map(([id, entries]) => [id,
    Object.fromEntries(Object.entries(entries as Record<string, unknown>).filter(([hash, entry]) => hashes.test(hash) && isRecord(entry) && isRecord(entry.stash) && entry.stash.hash === hash && typeof entry.stash.baseHash === 'string' && hashes.test(entry.stash.baseHash))
      .map(([hash, raw]) => {
        const entry = raw as unknown as ReviewEntry, stash = entry.stash;
        return [hash, {stash: {hash, baseHash: stash.baseHash, ref: typeof stash.ref === 'string' ? stash.ref : 'Archived', message: typeof stash.message === 'string' ? stash.message : hash.slice(0, 8), branch: typeof stash.branch === 'string' ? stash.branch : '', createdAt: typeof stash.createdAt === 'string' ? stash.createdAt : ''},
          archived: entry.archived === true, snapshotLayers: strings(entry.snapshotLayers).filter((layer): layer is DiffLayer => DIFF_LAYERS.includes(layer as DiffLayer)), fingerprints: safeFingerprints(entry.fingerprints),
          ...(typeof entry.predecessorHash === 'string' && hashes.test(entry.predecessorHash) ? {predecessorHash: entry.predecessorHash} : {})}];
      }))]));
}

export function loadPluginData(raw: unknown): PluginData {
  const data = raw && typeof raw === 'object' ? raw as Partial<PluginData> : {};
  const s = data.settings;
  return {
    version: 2,
    settings: {
      repositories: Array.isArray(s?.repositories) ? s.repositories.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()) : [],
      gitPath: typeof s?.gitPath === 'string' && s.gitPath.trim() ? s.gitPath.trim() : DEFAULT_SETTINGS.gitPath,
      contextLines: Number.isInteger(s?.contextLines) && s!.contextLines >= 0 && s!.contextLines <= 100 ? s!.contextLines : DEFAULT_SETTINGS.contextLines,
      refreshInterval: Number.isInteger(s?.refreshInterval) && s!.refreshInterval >= 0 && s!.refreshInterval <= 3600 ? s!.refreshInterval : DEFAULT_SETTINGS.refreshInterval,
      defaultView: s?.defaultView === 'split' ? 'split' : 'unified'
    },
    reviews: data.reviews && typeof data.reviews === 'object' && !Array.isArray(data.reviews)
      ? Object.fromEntries(Object.entries(data.reviews).filter(([, reviews]) => reviews && typeof reviews === 'object' && !Array.isArray(reviews))) : {},
    repositoryCatalog: repositoryCatalog(data.repositoryCatalog),
    reviewCatalog: reviewCatalog(data.reviewCatalog)
  };
}

function safeAnnotations(raw: unknown): Annotation[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(a => a && typeof a === 'object' && typeof a.id === 'string' && typeof a.body === 'string' && typeof a.path === 'string'
    && (a.side === 'old' || a.side === 'new') && Number.isSafeInteger(a.startLine) && a.startLine > 0
    && Number.isSafeInteger(a.endLine) && a.endLine >= a.startLine
    && ['all', 'staged', 'unstaged'].includes(a.layer)).map(a => ({
    id: a.id, path: a.path, body: a.body, side: a.side, layer: a.layer,
    startLine: a.startLine, endLine: a.endLine, resolved: a.resolved === true,
    createdAt: typeof a.createdAt === 'string' ? a.createdAt : '',
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
    ...(isRecord(a.excerpt) && typeof a.excerpt.text === 'string' && Number.isSafeInteger(a.excerpt.startLine) && (a.excerpt.startLine as number) > 0
      ? {excerpt: {text: a.excerpt.text, startLine: a.excerpt.startLine as number, ...(a.excerpt.truncated === true ? {truncated: true} : {})}} : {}),
    replies: Array.isArray(a.replies) ? a.replies.filter((reply: unknown) => reply && typeof reply === 'object'
      && typeof (reply as {id?: unknown}).id === 'string' && typeof (reply as {body?: unknown}).body === 'string')
      .map((reply: {id: string; body: string; createdAt?: unknown}) => ({id: reply.id, body: reply.body, createdAt: typeof reply.createdAt === 'string' ? reply.createdAt : ''})) : []
  }));
}

export function readMetadata(data: PluginData, repositoryId: string, hash: string): StashMetadata {
  const saved = data.reviews[repositoryId]?.[hash];
  if (!saved) return emptyMetadata();
  const layers = isRecord(saved.reviewedByLayer) ? Object.fromEntries(DIFF_LAYERS.filter(layer => Array.isArray(saved.reviewedByLayer?.[layer])).map(layer => [layer, strings(saved.reviewedByLayer?.[layer])])) : undefined;
  const all = layers?.all ?? strings(saved.reviewedFiles);
  return structuredClone({
    title: typeof saved.title === 'string' ? saved.title : '',
    description: typeof saved.description === 'string' ? saved.description : '',
    tags: Array.isArray(saved.tags) ? saved.tags.filter(t => typeof t === 'string') : [],
    pinned: saved.pinned === true,
    reviewedFiles: all,
    annotations: safeAnnotations(saved.annotations),
    ...(layers ? {reviewedByLayer: layers} : {}),
    ...(isRecord(saved.fileFingerprints) ? {fileFingerprints: safeFingerprints(saved.fileFingerprints)} : {}),
    ...(typeof saved.continuedFrom === 'string' && hashes.test(saved.continuedFrom) ? {continuedFrom: saved.continuedFrom} : {})
  });
}

export function reviewedPaths(metadata: StashMetadata, layer: DiffLayer): string[] {
  return metadata.reviewedByLayer?.[layer] ?? (layer === 'all' ? metadata.reviewedFiles : []);
}

export function withReviewedPath(metadata: StashMetadata, layer: DiffLayer, path: string, viewed: boolean): StashMetadata {
  const paths = new Set(reviewedPaths(metadata, layer));
  if (viewed) paths.add(path); else paths.delete(path);
  const next = [...paths];
  return {...metadata, reviewedByLayer: {...metadata.reviewedByLayer, [layer]: next}, reviewedFiles: layer === 'all' ? next : metadata.reviewedFiles};
}

/** Matching paths must have been verified against both immutable blob/mode pairs. */
export function continueMetadata(previous: StashMetadata, current: StashMetadata, matching: Partial<Record<DiffLayer, ReadonlySet<string>>>, predecessorHash: string): StashMetadata {
  const layers = Object.fromEntries(DIFF_LAYERS.map(layer => [layer, [...new Set([...reviewedPaths(current, layer), ...reviewedPaths(previous, layer).filter(path => matching[layer]?.has(path))])]])) as Record<DiffLayer, string[]>;
  const ids = new Set(current.annotations.map(annotation => annotation.id));
  const copied = previous.annotations.filter(annotation => !ids.has(annotation.id) && matching[annotation.layer]?.has(annotation.path));
  return {...current, title: current.title || previous.title, description: current.description || previous.description,
    tags: [...new Set([...current.tags, ...previous.tags])], pinned: current.pinned || previous.pinned,
    reviewedFiles: layers.all, reviewedByLayer: layers, continuedFrom: predecessorHash,
    annotations: [...current.annotations, ...structuredClone(copied)]};
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_\[\]<>#|]/g, '\\$&').replace(/[\r\n]/g, ' ');
}

export function reviewMarkdown(repository: Repository, stash: Stash, metadata: StashMetadata, vaultName?: string): string {
  const lines = [
    `# ${escapeMarkdown(metadata.title || stash.message)}`,
    '',
    `Repository: ${escapeMarkdown(repository.name)}`,
    `Branch at capture: ${escapeMarkdown(stash.branch)}`,
    `Stash commit: \`${stash.hash}\``,
    `Captured: ${stash.createdAt}`,
    ...(vaultName !== undefined ? ['', markdownLink('Open live stash review', createReviewLink(vaultName, {repositoryId: repository.id, stashHash: stash.hash}))] : []),
    '',
    ...(metadata.tags.length ? [`Tags: ${metadata.tags.map(escapeMarkdown).join(', ')}`, ''] : []),
    metadata.description,
    '',
    '## Reviewed files',
    '',
    ...(metadata.reviewedFiles.length ? metadata.reviewedFiles.map(p => `- [x] ${escapeMarkdown(p)}`) : ['No files marked as viewed.']),
    '',
    '## Code annotations',
    ''
  ];
  for (const annotation of metadata.annotations) {
    const range = annotation.startLine === annotation.endLine ? `${annotation.startLine}` : `${annotation.startLine}-${annotation.endLine}`;
    lines.push(
      `### ${escapeMarkdown(annotation.path)} · ${annotation.side} lines ${range}`,
      '',
      `Status: ${annotation.resolved ? 'Resolved' : 'Open'} · Layer: ${annotation.layer}`,
      '', annotation.body, ''
    );
    for (const reply of annotation.replies) lines.push(`Reply (${reply.createdAt}):`, '', reply.body, '');
  }
  if (!metadata.annotations.length) lines.push('No code annotations yet.', '');
  return lines.join('\n');
}
