/**
 * Locate the built extension and its bundles by content, never by filename —
 * upstream re-hashes every chunk on each release.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function buildDir(version = process.env.CLAUDE_ARC_VERSION) {
  const root = join(ROOT, 'build');
  if (!existsSync(root)) throw new Error('no build/ — run node scripts/apply-patches.mjs first');
  const versions = readdirSync(root)
    .filter(d => /^\d+\.\d+\.\d+$/.test(d))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const v = version || versions.at(-1);
  if (!v) throw new Error('build/ has no versions');
  return join(root, v);
}

import { ARC_SCRIPTS } from '../scripts/arc-scripts.mjs';
const ARC_OWN = new Set(ARC_SCRIPTS);

/** The upstream asset whose source contains every one of `markers`. */
export function findBundle(markers, dir = join(buildDir(), 'assets')) {
  const hits = readdirSync(dir)
    .filter(f => f.endsWith('.js') && !ARC_OWN.has(f))
    .filter(f => {
      const src = readFileSync(join(dir, f), 'utf8');
      return markers.every(m => src.includes(m));
    });
  if (hits.length !== 1) {
    throw new Error(`expected 1 bundle matching ${JSON.stringify(markers)}, found ${hits.length}: ${hits}`);
  }
  return join(dir, hits[0]);
}

/** The module holding the TabGroupManager. */
export const tabGroupBundle = () =>
  findBundle(['getOrCreateMcpTabContext', 'createGroup', 'isTabInSameGroup']);

export const shimPath = () => join(ROOT, 'arc', 'arc-tabgroups.js');
