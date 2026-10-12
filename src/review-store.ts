import { DEFAULT_SETTINGS, emptyMetadata, type Annotation, type PluginData, type StashMetadata, type Repository, type Stash } from './types';
import {createReviewLink, markdownLink} from './markdown';

export function loadPluginData(raw: unknown): PluginData {
  const data = raw && typeof raw === 'object' ? raw as Partial<PluginData> : {};
  const s = data.settings;
  return {
    version: 1,
    settings: {
      repositories: Array.isArray(s?.repositories) ? s.repositories.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()) : [],
      gitPath: typeof s?.gitPath === 'string' && s.gitPath.trim() ? s.gitPath.trim() : DEFAULT_SETTINGS.gitPath,
      contextLines: Number.isInteger(s?.contextLines) && s!.contextLines >= 0 && s!.contextLines <= 100 ? s!.contextLines : DEFAULT_SETTINGS.contextLines,
      refreshInterval: Number.isInteger(s?.refreshInterval) && s!.refreshInterval >= 0 && s!.refreshInterval <= 3600 ? s!.refreshInterval : DEFAULT_SETTINGS.refreshInterval,
      defaultView: s?.defaultView === 'split' ? 'split' : 'unified'
    },
    reviews: data.reviews && typeof data.reviews === 'object' && !Array.isArray(data.reviews)
      ? Object.fromEntries(Object.entries(data.reviews).filter(([, reviews]) => reviews && typeof reviews === 'object' && !Array.isArray(reviews))) : {}
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
    replies: Array.isArray(a.replies) ? a.replies.filter((reply: unknown) => reply && typeof reply === 'object'
      && typeof (reply as {id?: unknown}).id === 'string' && typeof (reply as {body?: unknown}).body === 'string')
      .map((reply: {id: string; body: string; createdAt?: unknown}) => ({id: reply.id, body: reply.body, createdAt: typeof reply.createdAt === 'string' ? reply.createdAt : ''})) : []
  }));
}

export function readMetadata(data: PluginData, repositoryId: string, hash: string): StashMetadata {
  const saved = data.reviews[repositoryId]?.[hash];
  if (!saved) return emptyMetadata();
  return structuredClone({
    title: typeof saved.title === 'string' ? saved.title : '',
    description: typeof saved.description === 'string' ? saved.description : '',
    tags: Array.isArray(saved.tags) ? saved.tags.filter(t => typeof t === 'string') : [],
    pinned: saved.pinned === true,
    reviewedFiles: Array.isArray(saved.reviewedFiles) ? saved.reviewedFiles.filter(p => typeof p === 'string') : [],
    annotations: safeAnnotations(saved.annotations)
  });
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
