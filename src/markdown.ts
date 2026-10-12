import type {DiffLayer, ReviewTarget} from './types';

export function parseReviewParameters(parameters: Record<string, unknown>): ReviewTarget {
  const {repo, stash, layer = 'all', file} = parameters;
  if (typeof repo !== 'string' || !repo.trim() || repo.length > 256 || repo.includes('\0')) throw new Error('Specify a repository ID. Copy a link from Stash Review.');
  if (typeof stash !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(stash)) throw new Error('Specify the full stash commit hash, rather than stash@{n}.');
  if (!['all', 'staged', 'unstaged'].includes(String(layer))) throw new Error('Choose a diff layer: all, staged, or unstaged.');
  if (file !== undefined && (typeof file !== 'string' || !file || file.includes('\0'))) throw new Error('Specify a valid file path.');
  return {repositoryId: repo, stashHash: stash.toLowerCase(), layer: layer as DiffLayer, ...(typeof file === 'string' ? {file} : {})};
}

export function createReviewLink(vaultName: string, target: ReviewTarget): string {
  const validated = parseReviewParameters({repo: target.repositoryId, stash: target.stashHash, layer: target.layer ?? 'all', ...(target.file ? {file: target.file} : {})});
  const parameters = new URLSearchParams({vault: vaultName, repo: validated.repositoryId, stash: validated.stashHash, layer: validated.layer ?? 'all'});
  if (validated.file) parameters.set('file', validated.file);
  return `obsidian://stash-review?${parameters}`;
}

export function markdownLink(title: string, link: string): string {
  const label = title.replace(/[\\`*_\[\]<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  return `[${label}](${link})`;
}

export function markdownEmbed(link: string): string {
  return `\`\`\`stash-review\n${link}\n\`\`\``;
}

export function parseReviewBlock(source: string): ReviewTarget {
  const text = source.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    const url = new URL(text);
    if (url.protocol !== 'obsidian:' || url.hostname !== 'stash-review' || url.pathname && url.pathname !== '/' || url.hash) throw new Error('Use a Stash Review link copied from the review workspace.');
    const parameters: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!['vault', 'repo', 'stash', 'layer', 'file'].includes(key) || Object.hasOwn(parameters, key)) throw new Error(`Invalid or repeated embed field: ${key}`);
      parameters[key] = value;
    }
    return parseReviewParameters(parameters);
  }
  const parameters: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
    const match = line.match(/^\s*(repo|stash|layer|file)\s*:\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(parameters, match[1])) throw new Error('Use a copied Stash Review link or unique repo, stash, layer, and file fields.');
    parameters[match[1]] = match[2];
  }
  return parseReviewParameters(parameters);
}
