/**
 * Reading a release without installing it.
 *
 * The panel offers to update only when the build is really outdated, so it has
 * to know what the released tarball contains: the plugin version from
 * `package/package.json` and the engine version from `package/vendor/VERSION`.
 * The archive is small (a few hundred kilobytes) and fetched only on an explicit
 * check, never on page load.
 */
import zlib from 'node:zlib';

/** Entries of a tar archive: name → bytes. */
function untar(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\u0000.*$/s, '');
    if (!name) break;
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\u0000.*$/s, '').trim();
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    if (!Number.isFinite(size) || size < 0) break;
    const start = offset + 512;
    files.set(name, buffer.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * Version pair of a release tarball, or nulls for entries the archive lacks.
 * @param gz - gzipped tarball bytes.
 */
export function versionsFromTarball(gz) {
  const files = untar(zlib.gunzipSync(gz));
  let plugin = null;
  let engine = null;
  const manifest = files.get('package/package.json');
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest.toString('utf8'));
      plugin = typeof parsed.version === 'string' ? parsed.version.trim() : null;
    } catch {
      plugin = null;
    }
  }
  const versionFile = files.get('package/vendor/VERSION');
  if (versionFile) {
    const text = versionFile.toString('utf8').trim();
    engine = text || null;
  }
  return { plugin, engine };
}

/**
 * Fetch the released tarball and read its versions. Redirects are followed —
 * the stable link is a redirect to the current asset.
 * @param url - release asset URL.
 * @param options - timeout in milliseconds.
 */
export async function fetchRelease(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { Accept: 'application/gzip, application/octet-stream' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    return versionsFromTarball(buffer);
  } finally {
    clearTimeout(timer);
  }
}

/** Trimmed version text, or null: an empty string is not a version. */
function versionText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Can the panel's button update this installation, and why not?
 *
 * The version comparison is the same exact-string rule as {@link isOutdated}:
 * only a known pair is compared, and an unknown side never wins. What differs
 * is the install mode. A package install is replaced from the release, so the
 * button is offered exactly when the build is behind. A `link:` install is a
 * folder the person edits: reinstalling from the release would detach it and
 * replace a live development copy, so the button is never offered and the
 * status carries a reason that names the repository — the update happens there,
 * not here.
 *
 * @param options - `{ current, latest, mode, publishedAt }`; mode is 'package' or 'link'.
 * @returns `{ current, latest, outdated, canUpdate, reason?, publishedAt? }`.
 */
export function releaseStatus(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const current = versionText(input.current);
  const latest = versionText(input.latest);
  const mode = typeof input.mode === 'string' && input.mode.trim() ? input.mode.trim() : 'package';
  const publishedAt = versionText(input.publishedAt);
  const outdated = Boolean(current && latest && current !== latest);
  const link = mode === 'link';
  const status = { current, latest, outdated, canUpdate: !link && outdated };
  if (publishedAt) status.publishedAt = publishedAt;
  if (link) {
    status.reason = 'структура установлена ссылкой на каталог: кнопка не ставит пакет — обновите репозиторий и перезапустите DSH';
  }
  return status;
}

/** Is the installed pair behind the released one? Exact strings; unknown never wins. */
export function isOutdated(current, latest) {
  const behind = (have, want) => Boolean(want && have && want !== have);
  return { plugin: behind(current && current.plugin, latest && latest.plugin), engine: behind(current && current.engine, latest && latest.engine) };
}
