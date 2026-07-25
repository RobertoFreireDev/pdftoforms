/**
 * Flat extraction object -> the inputs on the current page.
 *
 * Each `input`, `select` and `textarea` is scored against every extraction
 * entry, in descending order of confidence:
 *
 *   1. exact `name` / `id` match against the key or the raw PDF field name
 *   2. label / aria-label / placeholder text vs. the entry's label
 *   3. normalized fuzzy match
 *
 * Ambiguous targets are left alone rather than guessed at, and the form is
 * never submitted.
 */

/** Minimum score before a value is written. */
const FILL_THRESHOLD = 0.62;
/** A fuzzy winner must beat the runner-up by this much to count as unambiguous. */
const AMBIGUITY_MARGIN = 0.08;

const EXACT_ID = 1;
const EXACT_LABEL = 0.88;
/** Fuzzy scores are capped below the exact tiers so they can never outrank one. */
const FUZZY_CAP = 0.8;

const SKIP_TYPES = new Set([
  'hidden', 'submit', 'reset', 'button', 'image', 'file', 'password',
]);

const TRUTHY = new Set([
  'true', 'yes', 'y', 'on', 'x', '1', 'checked', 'sim', 'si', 'oui', 'ja',
]);
const FALSY = new Set(['false', 'no', 'n', 'off', '0', 'unchecked', 'nao', 'não', '']);

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

function stripDiacritics(text) {
  return String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/** Lowercase, diacritics and every non-alphanumeric character removed. */
function norm(text) {
  return stripDiacritics(text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokens(text) {
  return stripDiacritics(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function bigrams(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

function diceCoefficient(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * 0..1 similarity blending whole-string equality, token overlap, containment
 * and character bigrams, so both "applicantName" vs "Applicant Name" and
 * "dob" vs "date_of_birth"-style near misses land sensibly.
 */
function similarity(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const tokenScore = diceCoefficient(new Set(tokens(a)), new Set(tokens(b)));

  let containment = 0;
  if (na.includes(nb) || nb.includes(na)) {
    containment = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  }

  const bigramScore = diceCoefficient(bigrams(na), bigrams(nb)) * 0.9;

  return Math.max(tokenScore, containment, bigramScore);
}

/* ------------------------------------------------------------------ *
 * Page targets
 * ------------------------------------------------------------------ */

function isVisible(el) {
  if (el.getClientRects().length > 0) return true;
  // Off-screen-but-focusable inputs are still legitimate fill targets; only a
  // genuinely un-rendered subtree is worth skipping.
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden');
}

function labelTextFor(el) {
  const parts = [];
  const doc = el.ownerDocument;

  if (el.id) {
    for (const label of doc.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)) {
      parts.push(label.textContent);
    }
  }
  const wrapping = el.closest('label');
  if (wrapping) parts.push(wrapping.textContent);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      parts.push(doc.getElementById(id)?.textContent ?? '');
    }
  }

  parts.push(el.getAttribute('aria-label') ?? '');
  parts.push(el.placeholder ?? '');
  parts.push(el.title ?? '');

  return parts
    .map((part) => String(part).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * A single fill target. Radio groups collapse into one target whose `elements`
 * are the individual buttons.
 */
function describeTarget(el, elements = [el]) {
  return {
    el,
    elements,
    kind: targetKind(el),
    identifiers: [el.name, el.id].filter(Boolean),
    labels: labelTextFor(el),
    describe: () => `${el.tagName.toLowerCase()}${el.name ? `[name="${el.name}"]` : ''}${el.id ? `#${el.id}` : ''}`,
  };
}

function targetKind(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') return el.multiple ? 'select-multiple' : 'select';
  if (tag === 'textarea') return 'text';
  const type = (el.type || 'text').toLowerCase();
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (type === 'number' || type === 'range') return 'number';
  if (['date', 'month', 'week', 'time', 'datetime-local'].includes(type)) return type;
  return 'text';
}

function collectTargets(root) {
  const targets = [];
  const radioGroups = new Map();

  for (const el of root.querySelectorAll('input, select, textarea')) {
    if (el.disabled || el.readOnly) continue;
    if (el.tagName === 'INPUT' && SKIP_TYPES.has((el.type || '').toLowerCase())) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (!isVisible(el)) continue;

    if (el.type === 'radio') {
      // The whole group is one logical field; the matched value picks a button.
      const groupKey = el.name || `__anonymous_${targets.length}`;
      if (!radioGroups.has(groupKey)) {
        const group = describeTarget(el, []);
        radioGroups.set(groupKey, group);
        targets.push(group);
      }
      const group = radioGroups.get(groupKey);
      group.elements.push(el);
      for (const text of labelTextFor(el)) {
        // A radio's own label describes the option, not the field — keep it for
        // option matching but do not let it pollute the field's own labels.
        group.optionLabels ??= [];
        group.optionLabels.push({ el, text });
      }
      continue;
    }

    targets.push(describeTarget(el));
  }

  // A radio group's field-level label lives on its fieldset or its container.
  for (const group of radioGroups.values()) {
    const legend = group.el.closest('fieldset')?.querySelector('legend');
    if (legend) group.labels.unshift(legend.textContent.replace(/\s+/g, ' ').trim());
  }

  return targets;
}

/* ------------------------------------------------------------------ *
 * Value coercion
 * ------------------------------------------------------------------ */

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  const text = norm(value);
  if (TRUTHY.has(text)) return true;
  if (FALSY.has(text)) return false;
  return Boolean(text);
}

/** "R$ 1.234,56" / "$1,234.56" -> "1234.56" */
function toNumber(value) {
  const text = String(value).replace(/[^\d.,\-]/g, '');
  if (!text) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  let normalized = text;
  if (lastComma > lastDot) {
    normalized = text.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = text.replace(/,/g, '');
  }
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) ? String(num) : null;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9,
  oct: 10, nov: 11, dec: 12, fev: 2, abr: 4, mai: 5, ago: 8, set: 9, out: 10, dez: 12,
};

/**
 * Best-effort date -> yyyy-mm-dd. `dayFirst` breaks the 03/04/2024 tie; it
 * follows the browser locale, since a PDF's convention usually matches the
 * user's.
 */
function toISODate(value, dayFirst) {
  const text = String(value).trim();

  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return pad(iso[1], iso[2], iso[3]);

  const named = text.match(/\b(\d{1,2})[\s\-/]*([a-zA-Z]{3,})[\s\-/,]*(\d{4})\b/);
  if (named) {
    const month = MONTHS[stripDiacritics(named[2]).slice(0, 3).toLowerCase()];
    if (month) return pad(named[3], month, named[1]);
  }

  const numeric = text.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/);
  if (numeric) {
    let [, a, b, year] = numeric;
    if (year.length === 2) year = String(Number(year) + (Number(year) > 50 ? 1900 : 2000));
    let day = Number(a);
    let month = Number(b);
    if (Number(a) > 12) [day, month] = [Number(a), Number(b)];
    else if (Number(b) > 12) [day, month] = [Number(b), Number(a)];
    else if (!dayFirst) [day, month] = [Number(b), Number(a)];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return pad(year, month, day);
  }

  return null;
}

function pad(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function coerce(kind, value, dayFirst) {
  const text = typeof value === 'boolean' ? String(value) : String(value ?? '').trim();

  switch (kind) {
    case 'checkbox':
    case 'radio':
      return toBoolean(value);
    case 'number':
      return toNumber(text);
    case 'date':
      return toISODate(text, dayFirst);
    case 'month': {
      const iso = toISODate(text, dayFirst);
      return iso ? iso.slice(0, 7) : null;
    }
    case 'time': {
      const match = text.match(/\b(\d{1,2}):(\d{2})\b/);
      return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
    }
    case 'datetime-local': {
      const iso = toISODate(text, dayFirst);
      const time = text.match(/\b(\d{1,2}):(\d{2})\b/);
      return iso ? `${iso}T${time ? `${time[1].padStart(2, '0')}:${time[2]}` : '00:00'}` : null;
    }
    default:
      return text;
  }
}

/* ------------------------------------------------------------------ *
 * Writing values
 * ------------------------------------------------------------------ */

/**
 * Frameworks like React intercept the instance `value` property to track
 * changes; going through the prototype setter is what makes them notice.
 */
function setNativeProperty(el, prop, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
  if (descriptor?.set) descriptor.set.call(el, value);
  else el[prop] = value;
}

function notify(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillSelect(el, value) {
  const wanted = norm(value);
  if (!wanted) return false;

  let best = null;
  for (const option of el.options) {
    const score = Math.max(
      similarity(option.value, value),
      similarity(option.textContent, value),
    );
    if (!best || score > best.score) best = { option, score };
  }
  if (!best || best.score < FILL_THRESHOLD) return false;

  setNativeProperty(el, 'value', best.option.value);
  if (el.value !== best.option.value) el.selectedIndex = best.option.index;
  notify(el);
  return true;
}

function fillRadioGroup(target, value) {
  const wanted = String(value ?? '');
  if (!wanted) return false;

  let best = null;
  for (const radio of target.elements) {
    const label = target.optionLabels?.find((entry) => entry.el === radio)?.text ?? '';
    const score = Math.max(similarity(radio.value, wanted), similarity(label, wanted));
    if (!best || score > best.score) best = { radio, score };
  }
  if (!best || best.score < FILL_THRESHOLD) return false;

  setNativeProperty(best.radio, 'checked', true);
  notify(best.radio);
  return true;
}

function applyValue(target, entry, dayFirst) {
  const { kind } = target;

  if (kind === 'radio') return fillRadioGroup(target, entry.value);
  if (kind === 'select' || kind === 'select-multiple') return fillSelect(target.el, entry.value);

  if (kind === 'checkbox') {
    const checked = coerce('checkbox', entry.value, dayFirst);
    if (target.el.checked === checked) return true;
    setNativeProperty(target.el, 'checked', checked);
    notify(target.el);
    return true;
  }

  const value = coerce(kind, entry.value, dayFirst);
  if (value === null || value === '') return false;

  setNativeProperty(target.el, 'value', value);
  notify(target.el);
  return target.el.value !== '';
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/** The parts of an entry worth matching an input's name/id against. */
function identifiersOf(entry) {
  const ids = [];
  if (entry.name) ids.push(entry.name);
  if (entry.key?.startsWith('field.')) ids.push(entry.key.slice('field.'.length));
  if (entry.header) ids.push(entry.header);
  ids.push(entry.key);
  return ids.filter(Boolean);
}

function labelsOf(entry) {
  return [entry.label, entry.header].filter(Boolean);
}

function scorePair(target, candidate) {
  const { identifiers, labels } = candidate;

  for (const a of target.identifiers) {
    for (const b of identifiers) {
      if (norm(a) && norm(a) === norm(b)) return EXACT_ID;
    }
  }

  for (const a of target.labels) {
    for (const b of [...labels, ...identifiers]) {
      if (norm(a) && norm(a) === norm(b)) return EXACT_LABEL;
    }
  }

  let best = 0;
  for (const a of [...target.identifiers, ...target.labels]) {
    for (const b of [...identifiers, ...labels]) {
      best = Math.max(best, similarity(a, b));
    }
  }
  return best * FUZZY_CAP;
}

/**
 * What an entry actually points at. A headed table cell is emitted under two
 * keys (`table.0.r3.c1` and `table.0.total.3`), and those two are one cell, not
 * two competing answers — the ambiguity check has to see them as the same thing.
 */
function identityOf(entry) {
  if (entry.source === 'table') return `cell:${entry.table}.${entry.row}.${entry.col}`;
  return `key:${entry.key}`;
}

/** Entries whose value could not sensibly land in this kind of input. */
function isCompatible(kind, entry, dayFirst) {
  if (kind === 'checkbox' || kind === 'radio') return true;
  if (typeof entry.value === 'boolean') return false;
  const value = coerce(kind, entry.value, dayFirst);
  return value !== null && value !== '';
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * @param {Record<string, object>} extraction flat object from pdf-extract
 * @param {object} [options]
 * @param {ParentNode} [options.root=document] subtree to fill
 * @param {boolean} [options.overwrite=false] replace values already present
 * @param {boolean} [options.dryRun=false] score everything, write nothing
 * @returns {{filled: object[], skipped: object[], targets: number}}
 */
export function autofill(extraction, options = {}) {
  const {
    root = document,
    overwrite = false,
    dryRun = false,
  } = options;

  const dayFirst = !(navigator.language || '').toLowerCase().startsWith('en-us');

  const candidates = Object.values(extraction)
    .filter((entry) => entry.value !== '' && entry.value !== null && entry.value !== undefined)
    .filter((entry) => !entry.readOnly)
    .map((entry) => ({
      entry,
      identifiers: identifiersOf(entry),
      labels: labelsOf(entry),
    }));

  const targets = collectTargets(root);
  const filled = [];
  const skipped = [];
  const used = new Set();

  for (const target of targets) {
    if (!overwrite && hasValue(target)) {
      skipped.push({ target: target.describe(), reason: 'already filled' });
      continue;
    }

    const scored = [];
    for (const candidate of candidates) {
      if (used.has(identityOf(candidate.entry))) continue;
      if (!isCompatible(target.kind, candidate.entry, dayFirst)) continue;
      const score = scorePair(target, candidate);
      if (score > 0) scored.push({ candidate, score });
    }
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < FILL_THRESHOLD) {
      skipped.push({ target: target.describe(), reason: 'no match', score: best?.score ?? 0 });
      continue;
    }

    // The runner-up is the best candidate pointing somewhere *else*; the same
    // cell reached through its other key is not competition.
    const bestIdentity = identityOf(best.candidate.entry);
    const runnerUp = scored.find((item) => identityOf(item.candidate.entry) !== bestIdentity);

    if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) {
      // Two different values fit equally well — leave it alone rather than
      // guess. This catches an input named "total" against a table column of
      // three totals, where any single answer would be arbitrary.
      skipped.push({ target: target.describe(), reason: 'ambiguous', score: best.score });
      continue;
    }

    const { entry } = best.candidate;
    const record = { target: target.describe(), key: entry.key, value: entry.value, score: best.score };

    if (dryRun || applyValue(target, entry, dayFirst)) {
      filled.push(record);
      used.add(bestIdentity);
    } else {
      skipped.push({ target: target.describe(), reason: 'value did not fit', score: best.score });
    }
  }

  return { filled, skipped, targets: targets.length };
}

function hasValue(target) {
  if (target.kind === 'radio') return target.elements.some((el) => el.checked);
  if (target.kind === 'checkbox') return target.el.checked;
  return Boolean(target.el.value);
}
