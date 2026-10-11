import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'docs/images');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto('http://127.0.0.1:4173/');
  await page.getByRole('button', { name: 'Open stash Ambient note capture', exact: true }).click();
  await page.locator('[data-file-path="src/capture.ts"] .sr-code').first().waitFor();
  await page.screenshot({ path: resolve(output, 'stash-review-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
  await page.locator('body.theme-light').waitFor();
  await page.screenshot({ path: resolve(output, 'stash-review-light.png'), fullPage: true });
  console.log('Updated docs/images/stash-review-dark.png and stash-review-light.png from fictional demo data.');
} finally { await browser.close(); }
