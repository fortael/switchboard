// How an external launcher asks for a project, in the two forms the app accepts:
// `--project <path>` on the command line, and a `wootonpad://` URL.
//
// macOS delivers the URL through the `open-url` event; every other platform hands
// it to the process as a plain argument — of a first launch, or of the second
// instance whose argv the single-instance lock forwards to the running one. Both
// roads end in this module so the platforms cannot drift apart, which is exactly
// what had happened: the URL was understood on macOS and silently dropped
// everywhere else.
//
// The path inside the URL is the one Claude itself records, i.e. POSIX for a
// project inside a WSL distribution. It is never translated here — the app keys
// projects by that form, and translation belongs at the filesystem boundary.

// The protocol as the OS knows it, and the scheme prefix built from it. Both are
// exported so registering the handler and recognising a URL cannot drift apart.
const PROTOCOL = 'wootonpad';
const SCHEME = `${PROTOCOL}://`;

// Prefix meaning "resume the most recent session" rather than "start a new one":
// wootonpad://+/path/to/project. It sits before the path rather than in a query
// so the whole link stays typeable and shell-safe.
const CONTINUE_MARKER = '+';

function isLaunchUrl(value) {
  return typeof value === 'string' && value.slice(0, SCHEME.length).toLowerCase() === SCHEME;
}

// A URL dispatcher, and a shell completing a directory name, both hand back a
// path with a trailing separator; a project path is stored without one and the
// two would not compare equal. Either separator, because a Windows-shaped path
// reaches this module as readily as a POSIX one. A root is left alone: `/` and
// `C:\` are whole paths, not a path followed by a separator.
function stripTrailingSeparators(p) {
  while (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p)) {
    p = p.slice(0, -1);
  }
  return p;
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    // A stray '%' is not an escape sequence; the raw text is still usable.
    return text;
  }
}

// The `?account=` value: which Claude account to open the project under. An
// account's identity is the config directory it reads, so that is what travels —
// environment variables do not cross from a WSL distribution to a Windows app,
// which is the whole reason this is in the URL at all. The distribution may
// precede it, because one POSIX directory means different homes in different
// distributions:
//
//     ?account=Ubuntu:/home/you/.claude-work
//     ?account=/home/you/.claude-work        (any distribution)
//     ?account=Ubuntu                        (that distribution's own home)
//
// A drive-lettered path is a whole value, never a distribution followed by a
// directory — `C:\Users\you\.claude` has a colon of its own.
// `decode` is false for a command-line argument, which carries no escapes and
// whose literal '%20' would be corrupted by decoding it — the same rule
// `--project` follows.
function parseAccountHint(raw, decode = true) {
  const value = raw ? (decode ? safeDecode(raw) : raw) : '';
  if (!value) return null;
  const cut = value.indexOf(':');
  if (cut === -1 || value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) {
    return /[\\/]/.test(value)
      ? { distro: null, configDir: stripTrailingSeparators(value) }
      : { distro: value, configDir: null };
  }
  // A template that interpolated two unset variables produces a bare ':', which
  // names nothing — the same answer as no value at all, rather than a hint object
  // with both halves empty that every reader would then have to guard against.
  const distro = value.slice(0, cut) || null;
  const configDir = stripTrailingSeparators(value.slice(cut + 1)) || null;
  return distro || configDir ? { distro, configDir } : null;
}

// Parse a wootonpad:// URL into { projectPath, continueSession, account }, or null
// when it carries no path. Never throws: the string comes from outside the app — a
// shell, a registry entry, another program's idea of escaping — and a malformed
// one has to be ignored rather than take the process down.
function parseLaunchUrl(url) {
  if (!isLaunchUrl(url)) return null;
  let rest = url.slice(SCHEME.length);
  const continueSession = rest.startsWith(CONTINUE_MARKER);
  if (continueSession) rest = rest.slice(CONTINUE_MARKER.length);
  // Split before decoding, or a percent-encoded '?' inside the path would become
  // a separator and cut the path in half.
  const cut = rest.indexOf('?');
  const query = cut === -1 ? '' : rest.slice(cut + 1);
  const path = stripTrailingSeparators(safeDecode(cut === -1 ? rest : rest.slice(0, cut)));
  if (!path) return null;
  let account = null;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    // The first usable value wins, so a second pair — a template that appends one
    // of its own from an unset variable — cannot wipe a hint that was already read.
    if (eq !== -1 && pair.slice(0, eq) === 'account') account = account || parseAccountHint(pair.slice(eq + 1));
  }
  return { projectPath: path, continueSession, account };
}

// `--account <config dir>` is the flag form of the URL's `?account=`, so a
// launcher that cannot build a URL can still name the account. Read out of the
// argv on its own rather than inside the `--project` branch: it qualifies the
// launch, not one of the two ways of spelling the path, and a launcher passing a
// URL alongside it means it just as much.
function accountFromArgv(argv) {
  const at = argv.indexOf('--account');
  // Percent-decoding is deliberately *not* applied, for the same reason
  // `--project` is not: a command-line argument carries no escapes.
  return at !== -1 && argv[at + 1] ? parseAccountHint(argv[at + 1], false) : null;
}

// The same request as it arrives on the command line. `--project` wins over a URL:
// it is the explicit, unambiguous form, and a launcher that passes both means the
// flag. Returns null when the argv asks for no project at all, which is the
// ordinary case of the app being started by hand.
function parseLaunchArgv(argv) {
  if (!Array.isArray(argv)) return null;
  const idx = argv.indexOf('--project');
  if (idx !== -1 && argv[idx + 1]) {
    // The same trailing-separator normalisation the URL form gets — a shell
    // completing a directory name supplies one just as readily as a dispatcher.
    // Percent-decoding is deliberately *not* applied: a command-line argument is
    // not escaped, and decoding one would corrupt a path containing a literal
    // '%20'.
    const projectPath = stripTrailingSeparators(argv[idx + 1]);
    if (projectPath) return { projectPath, continueSession: false, account: accountFromArgv(argv) };
  }
  for (const arg of argv) {
    const parsed = parseLaunchUrl(arg);
    // The URL's own `?account=` wins: it travelled with the path it qualifies.
    if (parsed) return { ...parsed, account: parsed.account || accountFromArgv(argv) };
  }
  return null;
}

module.exports = {
  parseLaunchUrl, parseLaunchArgv, isLaunchUrl,
  LAUNCH_URL_SCHEME: SCHEME, LAUNCH_PROTOCOL: PROTOCOL,
};
