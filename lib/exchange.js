/**
 * Exchange facts of a workspace: what actually crossed its border.
 *
 * A fact is direction + placement time + who with whom. Nothing else is read:
 * message bodies stay outside, only the header fields are parsed. A declared
 * folder (folders[].box) reads its own box. A structure without folders keeps
 * the legacy catalog beside the workspace, but that portal belongs to this
 * workspace alone: foreign labels from the profile map never enter it.
 *
 * The customer's classification: one message makes a one-way link (outgoing when
 * the source is the current workspace, incoming when it is the addressee); two or
 * more are split by counterpart, and both directions between the same pair make
 * it two-way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { identityOf } from './identity.js';

/** Header fields that make a message a fact; everything else is ignored. */
const FIELDS = ['From', 'To', 'Date', 'Thread', 'Status', 'Workspace', 'Node', 'Reply-To', 'Ref'];

/**
 * Parse the header block of a message file. Missing From/To/Date is not a fact.
 * @param text - file contents.
 * @returns parsed header or null.
 */
export function parseHeader(text) {
  const source = String(text || '');
  const header = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = /^([A-Za-z][A-Za-z-]*):\s*(.+?)\s*$/u.exec(line);
    if (!match) {
      if (line.trim() === '' && Object.keys(header).length > 0) break;
      continue;
    }
    header[match[1]] = match[2];
    if (Object.keys(header).length > 12) break;
  }
  const from = (header.From || '').trim();
  const to = (header.To || '').trim();
  const date = (header.Date || '').trim();
  if (!from || !to || !date) return null;
  const at = Date.parse(date);
  if (!Number.isFinite(at)) return null;
  return {
    from,
    to,
    at,
    date,
    thread: (header.Thread || '').trim(),
    status: (header.Status || '').trim(),
    /*
     * The workspace field is what lets a message between two nodes (Critic -> coordinator)
     * count as this workspace's fact: neither From nor To names the workspace there, so
     * without it the critic's own reports were silently dropped from its fact package.
     */
    workspace: (header.Workspace || '').trim(),
    node: (header.Node || '').trim(),
    replyTo: (header['Reply-To'] || '').trim(),
    ref: (header.Ref || '').trim(),
    fields: FIELDS.filter((field) => header[field] !== undefined),
  };
}

/** Every *.md file under a directory, newest first; unreadable directories are skipped. */
function filesUnder(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.md$/iu.test(entry.name)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/**
 * ISO date of an instant in the zone of the node, with the offset spelled out.
 *
 * A report used to say `Date: 2026-10-31T21:00:17Z` while the file was named after the
 * local day, and the reader had to guess which day it meant. One rule: the file name
 * is the local date, `Date` is the same instant written with its offset.
 */
export function isoWithOffset(date, timeZone) {
  const zone = typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : 'UTC';
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
  const asUtc = Date.parse(local.replace(' ', 'T') + 'Z');
  const offsetMinutes = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absolute / 60)).padStart(2, '0');
  const mm = String(absolute % 60).padStart(2, '0');
  return local.replace(' ', 'T') + sign + hh + ':' + mm;
}

/** Longest common prefix of two strings, case-insensitive. */
function longestCommonPrefix(left, right) {
  const one = String(left || '').toLowerCase();
  const two = String(right || '').toLowerCase();
  let index = 0;
  while (index < one.length && index < two.length && one[index] === two[index]) index += 1;
  return index;
}

/** Three closest participant labels: common beginning first, then the alphabet. */
function nearestParticipantLabels(value, participants) {
  const entries = participants && typeof participants === 'object' ? Object.entries(participants) : [];
  return entries
    .filter(([label, target]) => typeof label === 'string' && label.trim()
      && typeof target === 'string' && target.trim())
    .map(([label]) => ({ label: label.trim(), prefix: longestCommonPrefix(value, label) }))
    .sort((left, right) => right.prefix - left.prefix || left.label.localeCompare(right.label))
    .slice(0, 3)
    .map((item) => item.label);
}

/**
 * Resolve one addressee token through lib/identity.js (задание 0374).
 *
 * The write-time rule is the same one the scope and the panel use: a participant
 * label, a participant root or a declared workspace is resolved to a label; a
 * known role or node id stays a legacy address (the letter is still written); any
 * other value is a typo that stops the write. The header gets the label for a
 * label or a path, and the value itself for a legacy role — unchanged by 0374.
 */
function resolveAddresseeToken(token, root, participants, selfLabel) {
  const value = String(token).trim();
  const identity = identityOf(value, { participants, root, selfLabel });
  if (identity.kind === 'label' || identity.kind === 'path') {
    const label = identity.label || value;
    return { kind: identity.kind, label, resolved: true, write: label };
  }
  if (identity.kind === 'legacy') {
    return { kind: 'legacy', label: value, resolved: false, write: value };
  }
  return { kind: 'unresolved', label: value, resolved: false, write: value };
}

/**
 * Resolve the whole addressee field at write time.
 *
 * A caller may pass one address or the comma-separated list the scheduler builds
 * from report edges; each part is resolved on its own. An unresolved part stops the
 * write: the letter must not land in a box with nobody's name on it.
 *
 * @returns {{ addressee: { kind, label, resolved }, write: string }}
 */
function resolveAddressee(raw, root, participants, selfLabel) {
  const provided = typeof raw === 'string' && raw.trim() !== '';
  let parts = provided ? raw.trim().split(/[,;]/u).map((part) => part.trim()).filter(Boolean) : [];
  if (parts.length === 0) parts = [selfLabel];
  const resolvedParts = parts.map((part) => resolveAddresseeToken(part, root, participants, selfLabel));
  const unresolved = resolvedParts.find((part) => part.kind === 'unresolved');
  if (unresolved) {
    const labels = nearestParticipantLabels(unresolved.label, participants);
    const hint = labels.length > 0
      ? 'Ближайшие ярлыки: ' + labels.map((label) => '«' + label + '»').join(', ') + '.'
      : 'Карта участников пуста, подсказать нечего.';
    const error = new Error('адресат «' + unresolved.label + '» не разрешается в воркспейс: '
      + 'нет такого ярлыка участника и такого корня. Письмо не записано. ' + hint);
    error.code = 'addressee-unresolved';
    error.addressee = { kind: 'unresolved', label: unresolved.label, resolved: false };
    error.suggestions = labels;
    throw error;
  }
  const write = resolvedParts.map((part) => part.write).join(', ');
  if (resolvedParts.length === 1) {
    const only = resolvedParts[0];
    return { addressee: { kind: only.kind, label: only.label, resolved: only.resolved }, write };
  }
  const allResolved = resolvedParts.every((part) => part.kind === 'label' || part.kind === 'path');
  return {
    addressee: {
      kind: allResolved ? 'label' : 'legacy',
      label: resolvedParts.map((part) => part.label).join(', '),
      resolved: allResolved,
    },
    write,
  };
}

/**
 * Put one message into the exchange box of this workspace.
 *
 * Delivery is the other half of a report: a file in `docs/critic` is a report on a
 * desk, while a header in the shared box is the relation other participants read.
 * The name follows the convention already used here: `<stamp>--<from>--<NN>.md`.
 *
 * @returns { relative, absolute, addressee } paths of the written message and the
 *   resolved addressee: `kind` is how the value resolved (label | path | legacy),
 *   `label` is the workspace label when known, `resolved` says a workspace was found.
 */
export function writeExchangeMessage(root, options = {}) {
  const resolvedRoot = path.resolve(String(root));
  const dirs = exchangeDirs(resolvedRoot, options.paths);
  const dir = dirs[0] || path.join(path.dirname(resolvedRoot), 'coordination');
  const thread = typeof options.thread === 'string' && options.thread.trim() ? options.thread.trim() : 'critic-report';
  /*
   * From names the workspace that speaks, because that is the label other participants
   * filter by; the node that produced the message goes into its own field. The addressee
   * is resolved by the same rule as its own label: no literal role is written in place
   * of a workspace, and a value that names no workspace stops the write.
   */
  const participants = options && typeof options.participants === 'object' && options.participants ? options.participants : {};
  const workspace = typeof options.workspace === 'string' && options.workspace.trim()
    ? options.workspace.trim()
    : (currentLabel(resolvedRoot, participants) || path.basename(resolvedRoot));
  const from = typeof options.from === 'string' && options.from.trim() ? options.from.trim() : workspace;
  const address = resolveAddressee(options.to, resolvedRoot, participants, workspace);
  const to = address.write;
  const status = typeof options.status === 'string' && options.status.trim() ? options.status.trim() : 'report';
  const at = options.at instanceof Date ? options.at : new Date();
  const body = String(options.body || '').trim();
  const folder = path.join(dir, 'threads', thread);
  fs.mkdirSync(folder, { recursive: true });
  let existing = [];
  try {
    existing = fs.readdirSync(folder).filter((name) => /\.md$/iu.test(name));
  } catch {
    existing = [];
  }
  const stamp = isoWithOffset(at, options.timeZone).split(':').join('-');
  /*
   * Two agents can write in the same second. A name built only from the file count
   * would collide and the second write would silently replace the first (the box showed
   * three letters numbered --06 in one afternoon), so take the next FREE index.
   */
  const taken = new Set(existing);
  let counter = existing.length + 1;
  let name = stamp + '--' + from + '--' + String(counter).padStart(2, '0') + '.md';
  while (taken.has(name) || fs.existsSync(path.join(folder, name))) {
    counter += 1;
    name = stamp + '--' + from + '--' + String(counter).padStart(2, '0') + '.md';
  }
  const head = [
    'From: ' + from,
    'To: ' + to,
    ...(options && typeof options.boxUid === 'string' && options.boxUid.trim() ? ['Box: ' + String(options.boxUid).trim()] : []),
    'Date: ' + isoWithOffset(at, options.timeZone),
    'Thread: ' + thread,
    'Status: ' + status,
    ...(options.node ? ['Node: ' + options.node] : []),
    'Workspace: ' + workspace,
    ...(options.file ? ['File: ' + options.file] : []),
    ...(options.subject ? ['Subject: ' + options.subject] : []),
    '',
  ].join('\n');
  const absolute = path.join(folder, name);
  fs.writeFileSync(absolute, head + body + '\n', 'utf8');
  return {
    relative: path.relative(dir, absolute).split(path.sep).join('/'),
    absolute,
    addressee: address.addressee,
  };
}

/**
 * Exchange folders for this workspace: declared boxes, plus the legacy channel.
 *
 * The legacy auto-discovery — a `coordination` directory next to the workspace —
 * is kept: a structure that declares no folder still has the old single portal.
 * What changed is who that portal belongs to: it is read with the workspace's
 * OWN name only (see readExchange), so foreign participants and their letters are
 * not shown. A caller that works strictly from declared folders passes
 * `{ discover: false }` and gets only the boxes it named (folders[].box).
 */
export function exchangeDirs(root, configured, options = {}) {
  const dirs = [];
  const push = (candidate) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const resolved = path.resolve(candidate.trim());
    if (!dirs.includes(resolved)) dirs.push(resolved);
  };
  for (const item of Array.isArray(configured) ? configured : []) {
    if (typeof item === 'string') push(item);
    else if (item && typeof item === 'object') push(item.path);
  }
  /* The legacy channel: a catalog beside the workspace, no declaration needed. */
  if (options.discover !== false) push(path.join(path.dirname(root), 'coordination'));
  return dirs.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Label of the current workspace: mapping by path first, then its own name. */
export function currentLabel(root, participants) {
  const entries = participants && typeof participants === 'object' ? Object.entries(participants) : [];
  for (const [label, target] of entries) {
    if (typeof target !== 'string' || !target.trim()) continue;
    if (path.resolve(target.trim()).toLowerCase() === path.resolve(root).toLowerCase()) return label;
  }
  const base = path.basename(path.resolve(root)).toLowerCase();
  for (const [label] of entries) {
    if (label.toLowerCase() === base) return label;
  }
  return null;
}

/**
 * Read and classify exchange facts for one workspace.
 *
 * A legacy channel (no declared paths) belongs to the workspace it sits in: it is
 * read under the workspace's own name, never under a label from the global
 * participants map. That is the customer's rule — a folder created for a new
 * workspace has exactly one participant, this workspace — and it is what keeps
 * structure↔workflow letters out of a third workspace's portal. Declared folders
 * keep their declared participant labels and their own `me`.
 *
 * @param root - workspace root.
 * @param options - `paths` (configured folders), `participants` (label → path),
 *   `me` (label), `discover` (legacy channel, default true), `selfOnly`
 *   (force the workspace's own name, default for a path-less legacy read).
 */
export function readExchange(root, options = {}) {
  const resolvedRoot = path.resolve(String(root));
  const configured = Array.isArray(options.paths)
    ? options.paths.filter((item) => (typeof item === 'string'
      ? Boolean(item.trim())
      : Boolean(item && item.path && String(item.path).trim())))
    : [];
  const discover = options.discover !== false;
  /*
   * The legacy portal speaks only for its own workspace. An explicit `selfOnly`
   * or the absence of declared paths both select that mode; a declared folder
   * keeps the profile-map label, because the structure itself named the sides.
   */
  const selfOnly = options.selfOnly === true || (discover && configured.length === 0);
  const participants = !selfOnly && options.participants && typeof options.participants === 'object'
    ? options.participants
    : {};
  const me = selfOnly
    ? path.basename(resolvedRoot)
    : (typeof options.me === 'string' && options.me.trim() ? options.me.trim() : currentLabel(resolvedRoot, participants));
  const dirs = exchangeDirs(resolvedRoot, options.paths, { discover });
  const result = {
    root: resolvedRoot,
    label: me,
    /* The legacy portal has exactly one side: this workspace. */
    participants: me ? [me] : [],
    sources: dirs.map((dir) => ({ path: dir, exists: true })),
    total: 0,
    unparsed: 0,
    facts: [],
    links: [],
  };
  if (!me) {
    result.reason = 'не объявлено, какое имя принадлежит этому воркспейсу: задайте exchange.me или participants';
    return result;
  }
  const facts = [];
  for (const dir of dirs) {
    /*
     * Messages live under `threads`; README and schema files next to it are not
     * messages and must not inflate the "unparsed" counter.
     */
    const threads = path.join(dir, 'threads');
    let scan = dir;
    try {
      if (fs.statSync(threads).isDirectory()) scan = threads;
    } catch {
      scan = dir;
    }
    for (const file of filesUnder(scan)) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        result.unparsed += 1;
        continue;
      }
      const parsed = parseHeader(text);
      if (!parsed) {
        result.unparsed += 1;
        continue;
      }
      /*
       * The box is shared, the correspondence is not: a workspace reads only the
       * messages it takes part in. A conversation between two other participants is
       * not ours to read, even when the files are reachable.
       */
      const mine = String(parsed.from).toLowerCase() === me.toLowerCase()
        || String(parsed.to).toLowerCase() === me.toLowerCase()
        || String(parsed.workspace || '').toLowerCase() === me.toLowerCase();
      if (!mine) continue;
      facts.push({ ...parsed, file: path.relative(root, file) });
    }
  }
  facts.sort((left, right) => right.at - left.at || String(right.file).localeCompare(String(left.file)));
  result.facts = facts;
  result.total = facts.length;
  const groups = new Map();
  for (const fact of facts) {
    let counterpart = null;
    let direction = null;
    if (fact.from === me && fact.to === me) continue;
    if (fact.from === me) { counterpart = fact.to; direction = 'outgoing'; } else if (fact.to === me) { counterpart = fact.from; direction = 'incoming'; } else continue;
    if (!groups.has(counterpart)) groups.set(counterpart, { counterpart, outgoing: [], incoming: [] });
    groups.get(counterpart)[direction].push(fact);
  }
  result.links = [...groups.values()]
    .map((group) => ({
      counterpart: group.counterpart,
      kind: group.outgoing.length > 0 && group.incoming.length > 0 ? 'two-way' : (group.outgoing.length > 0 ? 'outgoing' : 'incoming'),
      outgoing: group.outgoing.length,
      incoming: group.incoming.length,
      lastOutgoing: group.outgoing[0] ? group.outgoing[0].at : null,
      lastIncoming: group.incoming[0] ? group.incoming[0].at : null,
      last: Math.max(group.outgoing[0] ? group.outgoing[0].at : 0, group.incoming[0] ? group.incoming[0].at : 0),
      facts: group.outgoing.concat(group.incoming).sort((left, right) => right.at - left.at),
    }))
    .sort((left, right) => right.last - left.last);
  return result;
}
