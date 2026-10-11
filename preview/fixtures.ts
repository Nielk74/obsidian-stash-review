import { emptyMetadata, type DiffFile, type DiffLayer, type DiffLine, type Stash, type StashMetadata } from '../src/types';

export const captureBefore = `import { App, TFile } from 'obsidian';
import { CaptureSettings } from './settings';

export interface CaptureResult {
  path: string;
  created: boolean;
}

/** Keep quick thoughts close to their source. */
export class NoteCapture {
  constructor(
    private readonly app: App,
    private readonly settings: CaptureSettings,
  ) {}

  async capture(text: string): Promise<CaptureResult> {
    const folder = this.settings.inboxFolder;
    const title = this.createTitle(text);
    const path = folder + '/' + title + '.md';

    if (this.app.vault.getAbstractFileByPath(path)) {
      throw new Error('A note with this title already exists');
    }

    await this.app.vault.create(path, text);
    return { path, created: true };
  }

  private createTitle(text: string): string {
    return text.slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, '').trim();
  }

  async open(result: CaptureResult): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
`;

export const captureStaged = captureBefore
  .replace("import { CaptureSettings } from './settings';", "import { CaptureSettings } from './settings';\nimport { normalizePath } from './paths';")
  .replace("const path = folder + '/' + title + '.md';", "const path = normalizePath(folder, title + '.md');")
  .replace("throw new Error('A note with this title already exists');", "return this.appendToExisting(path, text);")
  .replace('  private createTitle(text: string): string {', `  private async appendToExisting(path: string, text: string): Promise<CaptureResult> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      throw new Error('The capture destination is not a note');
    }

    await this.app.vault.append(file, '\\n\\n' + text);
    return { path, created: false };
  }

  private createTitle(text: string): string {`);

export const captureAfter = captureStaged
  .replace('    const title = this.createTitle(text);', `    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Write something before capturing');
    }

    const title = this.createTitle(trimmed);`)
  .replace('return this.appendToExisting(path, text);', 'return this.appendToExisting(path, trimmed);')
  .replace('await this.app.vault.create(path, text);', `const body = this.settings.includeTimestamp
      ? this.withTimestamp(trimmed)
      : trimmed;

    await this.app.vault.create(path, body);`)
  .replace('  private createTitle(text: string): string {', `  private withTimestamp(text: string): string {
    const captured = new Date().toISOString();
    return '---\\ncaptured: ' + captured + '\\n---\\n\\n' + text;
  }

  private createTitle(text: string): string {`);

const stylesBefore = `.capture-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 24px;
  border-radius: 8px;
  background: var(--background-primary);
}

.capture-input {
  min-height: 96px;
  resize: vertical;
  line-height: 1.5;
  border: 1px solid var(--background-modifier-border);
}

.capture-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
`;
const stylesAfter = stylesBefore.replace('gap: 12px;', 'gap: 16px;').replace('border-radius: 8px;', 'border-radius: 12px;').replace('  resize: vertical;', '  resize: vertical;\n  padding: 14px 16px;\n  font-family: var(--font-text);').replace('  justify-content: flex-end;', '  align-items: center;\n  justify-content: space-between;') + `
.capture-hint {
  color: var(--text-muted);
  font-size: 12px;
}

@media (prefers-reduced-motion: no-preference) {
  .capture-panel { animation: capture-enter 160ms ease-out; }
}
`;

const docsBefore = `# Quick capture

Capture a thought without leaving your current note.

## Getting started

1. Open the command palette.
2. Run "Capture a note".
3. Write your thought and press Enter.

Notes are saved in the Inbox folder.

## Configuration

Set the inbox folder in plugin settings.
`;
const docsAfter = docsBefore.replace('# Quick capture', '# Ambient note capture').replace('3. Write your thought and press Enter.', '3. Write your thought and press Cmd+Enter.\n4. Keep writing — your current note stays open.').replace('Notes are saved in the Inbox folder.', 'Notes are saved in the Inbox folder. Captures with the same title\nappend to the existing note, so related thoughts stay together.').replace('Set the inbox folder in plugin settings.', 'Set the inbox folder and optional capture timestamps in plugin settings.\n\nEmpty captures are rejected before any file is created.');

interface Snapshot {
  path: string;
  oldPath?: string;
  base: string;
  staged: string;
  working: string;
  status?: DiffFile['status'];
  untracked?: boolean;
  binary?: boolean;
}

const captureSnapshots: Snapshot[] = [
  { path: 'src/capture.ts', base: captureBefore, staged: captureStaged, working: captureAfter },
  { path: 'styles/capture.css', base: stylesBefore, staged: stylesBefore, working: stylesAfter },
  { path: 'docs/capture.md', oldPath: 'docs/quick-capture.md', base: docsBefore, staged: docsAfter, working: docsAfter, status: 'renamed' },
  { path: 'src/paths.ts', base: '', staged: `/** Join vault paths without creating double separators. */
export function normalizePath(folder: string, filename: string): string {
  const parts = [folder, filename].filter(Boolean);
  return parts.join('/').replace(/\\/{2,}/g, '/');
}
`, working: `/** Join vault paths without creating double separators. */
export function normalizePath(folder: string, filename: string): string {
  const parts = [folder, filename].filter(Boolean);
  return parts.join('/').replace(/\\/{2,}/g, '/');
}
`, status: 'added' },
  { path: 'notes/capture-experiment.md', base: '', staged: '', working: `# Capture experiment

The goal is to make capturing feel like placing a thought on a desk.

- Preserve the active editor selection.
- Capture timestamps should be optional.
- Check the duplicate-title path with a nested inbox folder.

Question: should a duplicate title append to yesterday's note?
`, status: 'added', untracked: true },
  { path: 'assets/capture-preview.png', base: '', staged: '', working: '', status: 'added', untracked: true, binary: true }
];

// Real nested paths make tree navigation, repeated basenames, and directory
// progress visible in the demo without inventing line counts or Git statuses.
const nestedCaptureSnapshots: Array<{ path: string; before: string; after: string }> = [
  {
    path: 'README.md',
    before: '# Fieldbook\n\nA thoughtful workspace for your notes.\n',
    after: '# Fieldbook\n\nA thoughtful workspace for your notes.\n\nCapture ideas into your inbox without leaving the current note.\n'
  },
  {
    path: 'src/capture/append.ts',
    before: `export function appendCapture(existing: string, capture: string): string {
  return existing + '\\n' + capture;
}
`,
    after: `export function appendCapture(existing: string, capture: string): string {
  const body = capture.trim();
  if (!body) return existing;
  return existing.trimEnd() + '\\n\\n' + body;
}
`
  },
  {
    path: 'src/capture/format.ts',
    before: `export function formatCapture(text: string): string {
  return text;
}
`,
    after: `export function formatCapture(text: string): string {
  return text.trim().replace(/\\r\\n/g, '\\n');
}
`
  },
  {
    path: 'src/capture/ui/modal.ts',
    before: `export function openCapture(input: HTMLTextAreaElement): void {
  input.focus();
}
`,
    after: `export function openCapture(input: HTMLTextAreaElement): void {
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
}
`
  },
  {
    path: 'src/utils/format.ts',
    before: `export function formatTimestamp(date: Date): string {
  return date.toLocaleString();
}
`,
    after: `export function formatTimestamp(date: Date): string {
  return date.toISOString();
}
`
  },
  {
    path: 'tests/capture/append.test.ts',
    before: `import { expect, test } from 'vitest';
import { appendCapture } from '../../src/capture/append';

test('appends a captured thought', () => {
  expect(appendCapture('First', 'Second')).toBe('First\\nSecond');
});
`,
    after: `import { expect, test } from 'vitest';
import { appendCapture } from '../../src/capture/append';

test('separates captured thoughts with a blank line', () => {
  expect(appendCapture('First', ' Second ')).toBe('First\\n\\nSecond');
});

test('preserves the note for an empty capture', () => {
  expect(appendCapture('First', '   ')).toBe('First');
});
`
  }
];
captureSnapshots.push(...nestedCaptureSnapshots.map(snapshot => ({
  path: snapshot.path, base: snapshot.before, staged: snapshot.after, working: snapshot.after
})));

export const demoStashes: Stash[] = [
  { hash: '8d7be6a901afe7794ed9a6f1a3cb0318409876da', ref: 'stash@{0}', message: 'On main: feat: ambient note capture', branch: 'main', createdAt: '2026-10-12T08:42:00.000Z', baseHash: '14bcb71161eb10b1404db78e06f98e1b7fb45601' },
  { hash: 'b45ac04f374a236e7410b2ef592b65a0d7d2f603', ref: 'stash@{1}', message: 'On main: experiment: command palette refresh', branch: 'main', createdAt: '2026-10-11T15:16:00.000Z', baseHash: '14bcb71161eb10b1404db78e06f98e1b7fb45601' },
  { hash: 'ecd4d9f332d372cab2391e3ecf15cc0b22ac9e47', ref: 'stash@{2}', message: 'On main: mobile reading spacing', branch: 'main', createdAt: '2026-10-10T10:20:00.000Z', baseHash: '8bd5a6cd7547ed28a7f8dcd634452a52a67ae234' },
  { hash: 'd3c88fe2a2ef85167717e4ceca01d3e3e9af4b77', ref: 'stash@{3}', message: 'On main: settings cleanup', branch: 'main', createdAt: '2026-10-08T18:05:00.000Z', baseHash: '8bd5a6cd7547ed28a7f8dcd634452a52a67ae234' },
  { hash: '3a91a980bb974a0a233f703d9a42e2e06d84cf39', ref: 'stash@{4}', message: 'On main: add a daily note shortcut', branch: 'main', createdAt: '2026-10-06T09:38:00.000Z', baseHash: '79c0b322c4117612329f989e3b1039416145abcfe' },
  { hash: 'c09d9da933a8bbcf9ce37c9cc93a73d18c8cda5a', ref: 'stash@{5}', message: 'On main: WIP metadata extraction', branch: 'main', createdAt: '2026-10-02T16:52:00.000Z', baseHash: '79c0b322c4117612329f989e3b1039416145abcfe' }
];

export const initialMetadata: Record<string, StashMetadata> = {
  [demoStashes[0].hash]: {
    ...emptyMetadata(), title: 'Ambient note capture', description: 'A quieter way to capture ideas without losing your place. Still exploring how duplicate titles should behave.', tags: ['experiment', 'capture'],
    annotations: [{ id: 'demo-question', path: 'src/capture.ts', side: 'new', startLine: 28, endLine: 28, layer: 'all', body: 'Should captures with the same title always append? We might want a date suffix for separate thoughts.', createdAt: '2026-10-12T09:15:00.000Z', updatedAt: '2026-10-12T09:15:00.000Z', resolved: false, replies: [] }]
  },
  [demoStashes[1].hash]: { ...emptyMetadata(), title: 'Command palette refresh', description: 'Try a calmer grouping for commands. Keep the keyboard flow fast.', tags: ['ui', 'worth revisiting'], pinned: true, reviewedFiles: ['src/palette.ts'] },
  [demoStashes[2].hash]: { ...emptyMetadata(), title: 'Mobile reading spacing', description: 'More breathing room for long notes on small screens.', tags: ['css', 'mobile'] },
  [demoStashes[3].hash]: { ...emptyMetadata(), title: 'Settings cleanup', tags: ['maintenance'] },
  [demoStashes[4].hash]: { ...emptyMetadata(), title: 'Daily note shortcut', tags: ['idea'] },
  [demoStashes[5].hash]: { ...emptyMetadata(), title: 'Metadata extraction', description: 'An early sketch. Pick up after the capture work.', tags: ['parked'] }
};

function snapshotsFor(hash: string): Snapshot[] {
  if (hash === demoStashes[1].hash) return [{ path: 'src/palette.ts', base: `export const commandGroups = [
  { label: 'All commands', commands: getCommands() },
];
`, staged: `export const commandGroups = [
  { label: 'Writing', commands: getWritingCommands() },
  { label: 'Navigation', commands: getNavigationCommands() },
  { label: 'Everything else', commands: getOtherCommands() },
];
`, working: `export const commandGroups = [
  { label: 'Writing', commands: getWritingCommands() },
  { label: 'Navigation', commands: getNavigationCommands() },
  { label: 'Everything else', commands: getOtherCommands() },
];
` }];
  if (hash === demoStashes[2].hash) return [{ path: 'styles/reading.css', base: '.markdown-preview-view {\n  line-height: 1.5;\n  padding: 16px;\n}\n', staged: '.markdown-preview-view {\n  line-height: 1.5;\n  padding: 16px;\n}\n', working: '.markdown-preview-view {\n  line-height: 1.7;\n  padding: 24px;\n  max-width: 72ch;\n}\n' }];
  if (demoStashes.slice(3).some(stash => stash.hash === hash)) return [{ path: 'README.md', base: '# Fieldbook\n\nA thoughtful workspace for your notes.\n', staged: '# Fieldbook\n\nA thoughtful workspace for your notes.\n', working: '# Fieldbook\n\nA thoughtful workspace for your notes.\n\n## Work in progress\n\nExplore a smaller, calmer workflow.\n' }];
  return captureSnapshots;
}

function linesOf(content: string): string[] {
  return content === '' ? [] : content.replace(/\n$/, '').split('\n');
}

// Small LCS fixture builder: snapshots stay immutable while context changes.
function lineDiff(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = linesOf(oldContent);
  const newLines = linesOf(newContent);
  const table = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      table[i][j] = oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      lines.push({ type: 'context', text: oldLines[i], oldLine: ++i, newLine: ++j });
    } else if (i < oldLines.length && (j === newLines.length || table[i + 1][j] >= table[i][j + 1])) {
      lines.push({ type: 'delete', text: oldLines[i], oldLine: ++i });
    } else {
      lines.push({ type: 'add', text: newLines[j], newLine: ++j });
    }
  }
  return lines;
}

export function fixtureDiff(hash: string, layer: DiffLayer, context: number, includeUntracked = true): DiffFile[] {
  return snapshotsFor(hash).flatMap(snapshot => {
    if (snapshot.untracked && (!includeUntracked || layer === 'staged')) return [];
    const oldContent = layer === 'unstaged' ? snapshot.staged : snapshot.base;
    const newContent = layer === 'staged' ? snapshot.staged : snapshot.working;
    if (!snapshot.binary && oldContent === newContent && (snapshot.status !== 'renamed' || layer === 'unstaged')) return [];
    const lines = lineDiff(oldContent, newContent);
    const changes = lines.flatMap((line, index) => line.type === 'context' ? [] : [index]);
    const ranges: Array<{ start: number; end: number }> = [];
    for (const index of changes) {
      const start = Math.max(0, index - context);
      const end = Math.min(lines.length, index + context + 1);
      const previous = ranges[ranges.length - 1];
      if (previous && start <= previous.end) previous.end = Math.max(end, previous.end);
      else ranges.push({ start, end });
    }
    return [{
      path: snapshot.path,
      oldPath: snapshot.oldPath,
      status: layer === 'unstaged' && snapshot.status === 'renamed' ? 'modified' : snapshot.status ?? 'modified',
      additions: lines.filter(line => line.type === 'add').length,
      deletions: lines.filter(line => line.type === 'delete').length,
      binary: Boolean(snapshot.binary),
      untracked: Boolean(snapshot.untracked),
      oldContent,
      newContent,
      hunks: ranges.map(({ start, end }) => {
        const segment = lines.slice(start, end);
        const oldStart = segment.find(line => line.oldLine !== undefined)?.oldLine ?? 0;
        const newStart = segment.find(line => line.newLine !== undefined)?.newLine ?? 0;
        const oldCount = segment.filter(line => line.oldLine !== undefined).length;
        const newCount = segment.filter(line => line.newLine !== undefined).length;
        return { oldStart, newStart, oldCount, newCount, header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, lines: segment };
      })
    }];
  });
}
