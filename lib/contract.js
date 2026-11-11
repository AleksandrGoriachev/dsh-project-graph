/**
 * The structure is the source of truth for who accepts whose work.
 *
 * A task contract names an executor and an acceptor as free text, so a hand-written
 * contract can quietly contradict the graph — exactly what happened with the design
 * tasks: the graph returns the designer's result to the coordinator, while the
 * contracts named the judge. Nothing checked the two against each other.
 *
 * These functions are the check: given the graph, the expected acceptor is derived
 * from the executor's outgoing edges — a reviewer if there is one, otherwise the
 * owner the result returns to. A mismatch is refused, not warned about.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Strip the `subagent:` prefix the contracts use for roles. */
export function bareName(value) {
  return String(value || '').trim().replace(/^subagent:/iu, '');
}

/** Корень структуры: задание агента его не пишет (0204). */
const STRUCTURE_ROOT = 'structure';

/** Шаблон allowedPaths в виде пути от корня: прямые слэши, без ./, нижний регистр. */
function pathPatternKey(value) {
  return String(value || '')
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '')
    .replace(/^\/+/u, '')
    .replace(/\/+$/u, '')
    .toLowerCase();
}

/** Совпадение пути с шаблоном allowedPaths: * — сегмент, ** — любая глубина. */
function globMatches(relative, pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
      continue;
    }
    if (char === '*') { source += '[^/]*'; continue; }
    if (char === '?') { source += '[^/]'; continue; }
    source += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  source += '$';
  try {
    return new RegExp(source, 'u').test(relative);
  } catch {
    return false;
  }
}

/**
 * Пересекает ли путь allowedPaths каталог structure/** (0204)?
 *
 * Проверяются и буквальные записи (`structure`, `structure/graph.json`), и
 * шаблоны: representative-путь structure/graph.json прогоняется через тот же
 * glob, что у allowedPaths (двойная звезда, `structure/*.json`, вложенная
 * structure после двойной звезды со слэшем).
 * Регистр не важен: путь структуры один и тот же на Windows и в контракте.
 *
 * @param value - элемент allowedPaths.
 * @returns true, если запись разрешает путь внутри structure/**.
 */
export function crossesStructurePath(value) {
  const raw = pathPatternKey(value);
  if (!raw) return false;
  if (raw === STRUCTURE_ROOT || raw.startsWith(STRUCTURE_ROOT + '/')) return true;
  return globMatches('structure/graph.json', raw);
}

/**
 * Parse the TASK-META JSON block from a task file.
 *
 * The block is returned as written, and the reviewer fields are read too (0168):
 * reviewer holds the role-style name the contracts use (`subagent:reviewer-1`),
 * reviewerNode the bare node id. Both are optional; the gate that requires their
 * review.json normalizes them through declaredReviewer, so a stray space in the
 * declaration cannot decide whether the review step exists.
 *
 * @param text - task.md contents.
 * @returns metadata object or null.
 */
export function parseTaskMeta(text) {
  const match = /<!--\s*TASK-META\s*([\s\S]*?)-->/u.exec(String(text || ''));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== 'object') return null;
    for (const key of ['reviewer', 'reviewerNode']) {
      if (typeof parsed[key] === 'string') parsed[key] = parsed[key].trim();
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Reviewer declared by a task contract (0168).
 *
 * A task that names a reviewer cannot be accepted without that reviewer's
 * review.json, so the gate needs one canonical answer: which node must sign the
 * file. reviewerNode is the node id and wins; reviewer is the role-style name and
 * loses the `subagent:` prefix, so `subagent:reviewer-1` and `reviewer-1` mean
 * the same node. Absent or empty fields mean "no reviewer" — the old behaviour.
 *
 * @param meta - parsed TASK-META (parseTaskMeta) or any object.
 * @returns {{ reviewer: string, node: string } | null}
 */
export function declaredReviewer(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const reviewer = typeof meta.reviewer === 'string' ? meta.reviewer.trim() : '';
  const reviewerNode = typeof meta.reviewerNode === 'string' ? meta.reviewerNode.trim() : '';
  if (!reviewer && !reviewerNode) return null;
  return { reviewer, node: reviewerNode || bareName(reviewer) };
}

/** Roles that mean "reviewer": the node checks the work but does not sign it. */
const REVIEWER_ROLES = new Set(['ревьюер', 'reviewer', 'review']);

/** The structure names reviewers reviewer-1, reviewer-2, … — the id is a signal too. */
const REVIEWER_ID = /^reviewer/iu;

/**
 * Is this node a reviewer?
 *
 * The chain worker → reviewer-1 → judge is the customer's: the reviewer reads the
 * diff, the judge signs. A reviewer has no key, so it never accepts; the work is
 * accepted by the node the reviewer answers to. The role is compared normalized
 * (trimmed, lower-cased); the id prefix reviewer* is the second signal, because
 * the structure already names these nodes reviewer-1, reviewer-2, …
 *
 * @param node - graph node object.
 * @returns true when the node is an intermediate reviewer.
 */
function isReviewer(node) {
  if (!node || typeof node !== 'object') return false;
  const role = String(node.role === undefined || node.role === null ? '' : node.role).trim().toLowerCase();
  if (REVIEWER_ROLES.has(role)) return true;
  const id = String(node.id === undefined || node.id === null ? '' : node.id).trim();
  return REVIEWER_ID.test(id);
}

/** The edge that names the acceptor: a reviewer wins over an owner. */
function acceptEdge(edges) {
  return edges.find((edge) => edge.kind === 'review') || edges.find((edge) => edge.kind === 'report') || null;
}

/**
 * Expected acceptor of a node's work, from the graph alone.
 *
 * A reviewer wins when declared (that is a real separate check); otherwise the
 * result returns to its owner, and the owner is the acceptor. A node with neither
 * has no one to accept it, which is a structural hole, not a free choice.
 *
 * A reviewer is an intermediate check, not a signer: when the chosen edge leads to
 * a reviewer, the acceptor is the node that reviewer answers to (its own first
 * review/report edge). The chain is followed while it leads through reviewers; a
 * reviewer with no such edge leaves the previous answer — the reviewer itself.
 * Nodes of any other role are never skipped.
 *
 * @param graph - built graph with nodes and edges.
 * @param executor - node id.
 * @returns { ok, acceptor, kind, message }
 */
export function expectedAcceptor(graph, executor) {
  const list = (graph && Array.isArray(graph.nodes) ? graph.nodes : [])
    .filter((node) => node && typeof node === 'object' && node.id !== undefined);
  const byId = new Map(list.map((node) => [node.id, node]));
  if (!byId.has(executor)) {
    return { ok: false, message: 'в структуре нет узла «' + executor + '»' };
  }
  const allEdges = (graph && Array.isArray(graph.edges) ? graph.edges : [])
    .filter((edge) => edge && typeof edge === 'object');
  const edgesOf = (id) => allEdges.filter((edge) => edge.from === id);
  const edge = acceptEdge(edgesOf(executor));
  if (!edge) {
    return {
      ok: false,
      message: 'у узла «' + executor + '» нет ни проверяющего (review), ни владельца (report): приёмка не назначена структурой',
    };
  }
  /*
   * Follow the chain while it leads through reviewers. The seen set also holds the
   * executor: a misconfigured ring of reviewers must stop instead of hanging.
   */
  let acceptor = edge.to;
  const seen = new Set([executor]);
  while (byId.has(acceptor) && !seen.has(acceptor) && isReviewer(byId.get(acceptor))) {
    seen.add(acceptor);
    const next = acceptEdge(edgesOf(acceptor));
    if (!next) break; // no one to answer to: the reviewer stays the acceptor
    acceptor = next.to;
  }
  return { ok: true, acceptor, kind: edge.kind };
}

/**
 * Validate one task contract against the graph.
 *
 * 0204: с options.enforceStructure задание, выданное агентом (`issuedBy.kind`
 * `agent`), не может разрешать путь structure/**: структуру меняет только
 * владелец, поэтому проблема называется `agent-structure-path`. Человеческое
 * задание (`issuedBy.kind` `human`) правило не трогает. По умолчанию проверка
 * выключена: исторические задания читаются прежним контрактом.
 *
 * @param graph - built graph.
 * @param meta - TASK-META of the task.
 * @param options - { enforceStructure?: boolean }.
 * @returns list of problems, empty when the contract matches the structure.
 */
export function validateContract(graph, meta, options = {}) {
  const problems = [];
  if (!meta || typeof meta !== 'object') return ['нет TASK-META: задание не объявляет исполнителя и приёмщика'];
  const input = options && typeof options === 'object' ? options : {};
  if (input.enforceStructure === true) {
    const issuedBy = meta.issuedBy && typeof meta.issuedBy === 'object' && !Array.isArray(meta.issuedBy)
      ? meta.issuedBy
      : null;
    const kind = issuedBy && typeof issuedBy.kind === 'string' ? issuedBy.kind.trim().toLowerCase() : '';
    if (kind === 'agent') {
      const allowed = Array.isArray(meta.allowedPaths) ? meta.allowedPaths : [];
      const structurePaths = allowed.filter((item) => typeof item === 'string' && crossesStructurePath(item));
      if (structurePaths.length > 0) {
        problems.push('agent-structure-path: задание агента не пишет structure/**: allowedPaths '
          + structurePaths.map((item) => '«' + item + '»').join(', ')
          + ' — структуру меняет только владелец');
      }
    }
  }
  const executor = bareName(meta.executor);
  if (!executor) return ['в TASK-META нет executor'];
  const acceptor = bareName(meta.acceptor);
  if (!acceptor) problems.push('в TASK-META нет acceptor');
  const expected = expectedAcceptor(graph, executor);
  if (!expected.ok) {
    problems.push(expected.message);
    return problems;
  }
  if (acceptor && acceptor !== expected.acceptor) {
    problems.push('контракт говорит acceptor=' + acceptor + ', структура — ' + expected.acceptor
      + ' (' + (expected.kind === 'review' ? 'проверяет работу' : 'владелец, которому возвращается результат') + ')');
  }
  return problems;
}

/**
 * Validate a task file on disk; a missing node or unreadable file is a problem.
 * @param graph - built graph.
 * @param file - absolute path to task.md.
 */
export function validateTaskFile(graph, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return ['не удалось прочитать ' + file];
  }
  return validateContract(graph, parseTaskMeta(text));
}

/** All task contracts of a repository: one task.md per task directory. */
export function contractFiles(root) {
  return taskFiles(root);
}

/** All task directories of a repository that carry a task.md. */
export function taskFiles(root) {
  const dir = path.join(root, 'docs', 'tasks');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, 'task.md'))
    .filter((file) => fs.existsSync(file));
}
