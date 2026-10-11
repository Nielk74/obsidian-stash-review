import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const versions = JSON.parse(readFileSync(resolve(root, 'versions.json'), 'utf8'));
if (manifest.version !== pkg.version || versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error('package.json, manifest.json, and versions.json must agree before a release.');
}
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== manifest.version) {
  throw new Error(`Release tag ${process.env.RELEASE_TAG} does not match manifest version ${manifest.version}. Use an Obsidian version tag without a v prefix.`);
}
const output = resolve(root, 'dist-release');
rmSync(output, { recursive: true, force: true });
mkdirSync(resolve(output, manifest.id), { recursive: true });
for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
  copyFileSync(resolve(root, filename), resolve(output, filename));
  copyFileSync(resolve(root, filename), resolve(output, manifest.id, filename));
}
const zipName = `${manifest.id}-${manifest.version}.zip`;
execFileSync('zip', ['-qr', zipName, manifest.id], { cwd: output, stdio: 'inherit' });
const assets = ['main.js', 'manifest.json', 'styles.css', zipName];
writeFileSync(resolve(output, 'SHA256SUMS'), assets.map(filename => {
  const digest = createHash('sha256').update(readFileSync(resolve(output, filename))).digest('hex');
  return `${digest}  ${filename}`;
}).join('\n') + '\n');
console.log(`Packaged ${manifest.name} ${manifest.version}: ${assets.join(', ')}, SHA256SUMS`);
