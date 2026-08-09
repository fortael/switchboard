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

// Parse a wootonpad:// URL into { projectPath, continueSession }, or null when it
// carries no path. Never throws: the string comes from outside the app — a shell,
// a registry entry, another program's idea of escaping — and a malformed one has
// to be ignored rather than take the process down.
function parseLaunchUrl(url) {
  if (!isLaunchUrl(url)) return null;
  let rest = url.slice(SCHEME.length);
  const continueSession = rest.startsWith(CONTINUE_MARKER);
  if (continueSession) rest = rest.slice(CONTINUE_MARKER.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // A stray '%' is not an escape sequence; the raw text is still a usable path.
  }
  rest = stripTrailingSeparators(rest);
  if (!rest) return null;
  return { projectPath: rest, continueSession };
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
    if (projectPath) return { projectPath, continueSession: false };
  }
  for (const arg of argv) {
    const parsed = parseLaunchUrl(arg);
    if (parsed) return parsed;
  }
  return null;
}

module.exports = {
  parseLaunchUrl, parseLaunchArgv, isLaunchUrl,
  LAUNCH_URL_SCHEME: SCHEME, LAUNCH_PROTOCOL: PROTOCOL,
};
