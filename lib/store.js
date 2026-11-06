/**
 * Where a project's structure lives.
 *
 * The panel used to keep the declaration inside the repository
 * (`structure/graph.json`), which made every project's git status dirty and
 * tripped the task gate. The structure is a local setting of one workspace, not
 * a source file, so by default it lives outside the repository:
 *
 *   - legacy projects keep it where it already is: `<root>/<structureDir>`;
 *   - every other project keeps it in the store:
 *       `$DSH_PROJECT_GRAPH_STORE`, otherwise
 *       `~/.dsh/project-graph/<basename(root)>-<sha1(root)[0..8]>/`
 *     with `graph.json`, `links.json` and `critic/spec.md`.
 *
 * The legacy marker is the structure folder itself: a project with
 * `structure/graph.json` (or with split fragments such as
 * `structure/nodes.json`) already declares its structure in the repository, and
 * moving it behind the person's back would hide it. A fresh project has no such
 * folder and gets the store.
 *
 * Fragment names stay in the same shape in both modes (`<structureDir>/<rel>`),
 * so the graph reader, the panel and every writer work with logical names and
 * never need to know which mode is on. `resolveStructure` maps a logical name
 * back to the real file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Environment variable that overrides the default store folder. */
export const STORE_ENV = 'DSH_PROJECT_GRAPH_STORE';

/** Files the store holds, relative to its folder. */
export const STORE_FILES = {
  graph: 'graph.json',
  links: 'links.json',
  criticSpec: path.join('critic', 'spec.md'),
};

/** Structure folder name without surrounding separators; `structure` by default. */
export function normalizeStructureDir(value) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : 'structure';
  const slashed = text.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
  return slashed || 'structure';
}

/** Absolute project root; a relative or empty value resolves against cwd. */
function absoluteRoot(root) {
  return path.resolve(String(root || process.cwd()));
}

/**
 * Folder name of one root inside the default store.
 *
 * The readable part is the project name, the stable part is the first 8 hex of
 * sha1 of the absolute root: two workspaces named `app` must not share a graph,
 * and the same workspace must find its graph after a restart.
 */
export function storeName(root) {
  const absolute = absoluteRoot(root);
  const base = path.basename(absolute) || 'root';
  const digest = crypto.createHash('sha1').update(absolute).digest('hex').slice(0, 8);
  return base + '-' + digest;
}

/**
 * Absolute store folder of one root: the environment override, or the default
 * `~/.dsh/project-graph/<name>-<sha1[0..8]>`.
 */
export function storeDir(root) {
  const override = process.env && typeof process.env[STORE_ENV] === 'string'
    ? process.env[STORE_ENV].trim()
    : '';
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.dsh', 'project-graph', storeName(root));
}

/** Deepest structure sub-folder inspected for a fragment (the reader's limit). */
const LEGACY_SCAN_DEPTH = 3;

/**
 * Does the repository already declare this project's structure?
 *
 * `<structureDir>/graph.json` is the legacy marker named by the contract. A
 * folder with any other JSON fragment (a split structure such as `nodes.json` +
 * `links.json`, or `teams/code.json`) is the same declaration and counts too:
 * reading it from the store instead would silently show an empty graph in a
 * working project. An empty folder declares nothing and does not turn a project
 * into a legacy one — a fresh project must not get `structure/` back.
 */
function declaredInRepo(root, structureDir) {
  const dir = path.join(root, structureDir);
  if (fs.existsSync(path.join(dir, 'graph.json'))) return true;
  const walk = (current, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        if (depth < LEGACY_SCAN_DEPTH && walk(path.join(current, entry.name), depth + 1)) return true;
        continue;
      }
      if (entry.name.toLowerCase().endsWith('.json')) return true;
    }
    return false;
  };
  return walk(dir, 0);
}

/**
 * Resolve the real folder and files of one project's structure.
 *
 * @param root - project root (absolute, or resolved against cwd).
 * @param structureDir - logical folder name inside the project (default `structure`).
 * @returns `{ mode, root, structureDir, dir, graphFile, linksFile, criticSpecFile }`.
 *   `mode` is `repo` for a legacy project and `store` for the external store.
 */
export function resolveStructure(root, structureDir = 'structure') {
  const base = absoluteRoot(root);
  const dirName = normalizeStructureDir(structureDir);
  if (declaredInRepo(base, dirName)) {
    const dir = path.join(base, dirName);
    return {
      mode: 'repo',
      root: base,
      structureDir: dirName,
      dir,
      graphFile: path.join(dir, 'graph.json'),
      linksFile: path.join(dir, 'links.json'),
      criticSpecFile: path.join(base, 'docs', 'critic', 'spec.md'),
    };
  }
  const dir = storeDir(base);
  return {
    mode: 'store',
    root: base,
    structureDir: dirName,
    dir,
    graphFile: path.join(dir, STORE_FILES.graph),
    linksFile: path.join(dir, STORE_FILES.links),
    criticSpecFile: path.join(dir, STORE_FILES.criticSpec),
  };
}

/** `repo` or `store` for one project. */
export function mode(root, structureDir = 'structure') {
  return resolveStructure(root, structureDir).mode;
}

/** Real path of the graph file (`structure/graph.json` or the store's copy). */
export function graphFile(root, structureDir = 'structure') {
  return resolveStructure(root, structureDir).graphFile;
}

/** Real path of the links fragment. */
export function linksFile(root, structureDir = 'structure') {
  return resolveStructure(root, structureDir).linksFile;
}

/** Real path of the critic's base spec. */
export function criticSpecFile(root, structureDir = 'structure') {
  return resolveStructure(root, structureDir).criticSpecFile;
}
