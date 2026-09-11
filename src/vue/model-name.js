// model-name.js — a model row, in two words.
//
// `supportedModels()` gives each row a `displayName` written for a full-width
// menu — "Default (recommended)", "Opus (1M context)" — and a `resolvedModel`,
// the wire id it actually runs. Neither is what you want in a control bar:
// the display name does not say which model "Default" is, and the wire id is
// twenty-odd characters of kebab-case. Pairing them, which this used to do,
// produced "Default (recommended) · claude-opus-5" — wide enough that the
// native dropdown opened past the edge of the screen.
//
// So the name is derived from the wire id, which is the only field that
// actually identifies the model, and rendered the way the CLI's own picker
// renders it: Opus 5, Sonnet 5, Haiku 4.5, Fable 5.1.

/** A date stamp pinning a snapshot — part of the id, not part of the name. */
const DATE_PART = /^\d{8}$/;

/**
 * `claude-haiku-4-5-20251001` → `Haiku 4.5`.
 *
 * Words become the name and digits become the version, wherever each sits in
 * the id: `claude-3-5-sonnet-…` reads "Sonnet 3.5" for the same reason
 * `claude-sonnet-5` reads "Sonnet 5".
 *
 * @param {string} wireId
 * @returns {string} empty when there is nothing recognisable to show
 */
export function modelName(wireId) {
  const id = String(wireId || '')
    .replace(/\[[^\]]*\]/g, '')      // the [1m] context marker is not a version
    .trim();
  if (!id) return '';

  const words = [];
  const version = [];
  for (const part of id.split('-')) {
    if (!part || part === 'claude') continue;   // the vendor is not the name
    if (DATE_PART.test(part)) continue;
    if (/^\d+$/.test(part)) version.push(part);
    else words.push(part[0].toUpperCase() + part.slice(1));
  }

  return [words.join(' '), version.join('.')].filter(Boolean).join(' ');
}

/** True when this row runs the long-context variant. */
const isLongContext = (model) => /\[1m\]/.test(String(model?.resolvedModel || model?.value || ''));

/**
 * What tells two rows apart when their names collide. `default` and `opus[1m]`
 * resolve to the same wire id, so both read "Opus 5" — true, and useless in a
 * list. The row's own `value` is what differs, and it is already meaningful.
 */
function qualifier(model) {
  const value = String(model?.value || '');
  if (value === 'default') return 'Default';
  if (isLongContext(model)) return '1M';
  return value;
}

/**
 * One label per row, keyed by `value`.
 *
 * Qualifiers are added only where two rows would otherwise read the same, so a
 * list with no duplicates stays as short as the CLI's own — and a future
 * account whose rows all differ never grows the noise.
 *
 * @param {Array<object>} models
 * @returns {Map<string, string>}
 */
export function modelLabels(models) {
  const rows = (Array.isArray(models) ? models : []).filter(m => m && m.value != null);

  const base = rows.map((m) => {
    // `resolvedModel` is the only field guaranteed to name a real model, so it
    // wins. Without it `value` may be an opaque alias, and the CLI's own
    // display name — minus the parenthetical the control bar has no room for —
    // is the better guess than deriving a name from the alias.
    if (m.resolvedModel) {
      const name = modelName(m.resolvedModel);
      if (name) return name;
    }
    const display = String(m.displayName || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    return display || modelName(m.value) || String(m.value);
  });

  const seen = new Map();
  for (const name of base) seen.set(name, (seen.get(name) || 0) + 1);

  const labels = new Map();
  rows.forEach((m, i) => {
    const name = base[i];
    const extra = seen.get(name) > 1 ? qualifier(m) : '';
    labels.set(m.value, extra ? `${name} · ${extra}` : name);
  });
  return labels;
}

/**
 * The row a session runs when nobody has chosen one — what the picker should
 * show on a chat that has not had a turn yet. Until the first `system/init`
 * arrives there is nothing else to go on, and a blank control reads as broken.
 */
export function defaultModelValue(models) {
  const rows = Array.isArray(models) ? models : [];
  const preferred = rows.find(m => m?.value === 'default');
  return (preferred || rows[0])?.value || '';
}
