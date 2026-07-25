/**
 * Flat extraction object -> the inputs on the current page.
 *
 * Nothing here guesses. The only way a value reaches an input is an explicit
 * `selector -> key` mapping the user configured for this page: `fillMapped`
 * resolves the selector, coerces the value to the input's kind, and writes it.
 * The form is never submitted.
 *
 * Similarity scoring survives for one narrow job — deciding which `<option>` or
 * radio button of a mapped field the PDF's value refers to.
 */

/** Minimum similarity before a select option or radio button counts as the match. */
const FILL_THRESHOLD = 0.62;

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
  return { el, elements, kind: targetKind(el) };
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

/** A radio's own label describes the option, not the field. */
function addRadio(group, el) {
  group.elements.push(el);
  for (const text of labelTextFor(el)) {
    group.optionLabels ??= [];
    group.optionLabels.push({ el, text });
  }
}

/**
 * One element -> one target, pulling in the rest of its radio group so a
 * mapping that points at a single button can still pick any option.
 */
function targetFor(el, root = el.ownerDocument) {
  if (el.type !== 'radio') return describeTarget(el);

  const group = describeTarget(el, []);
  const buttons = el.name
    ? root.querySelectorAll(`input[type="radio"][name="${el.name.replace(/["\\]/g, '\\$&')}"]`)
    : [el];
  for (const radio of buttons) addRadio(group, radio);
  return group;
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
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Fill from an explicit selector -> key list. This is the only way anything on
 * the page gets written.
 *
 * A mapping is an instruction, not a guess: no threshold, no ambiguity check,
 * and existing values are overwritten. Past the lookup comes coercion,
 * select/radio option matching, the prototype setter and the input/change
 * events — all of `applyValue`.
 *
 * @param {Record<string, object>} extraction flat object from pdf-extract
 * @param {{selector: string, key: string}[]} mappings
 * @param {object} [options]
 * @param {ParentNode} [options.root=document]
 * @returns {{filled: object[], skipped: object[], targets: number}}
 */
export function fillMapped(extraction, mappings, options = {}) {
  const { root = document } = options;
  const dayFirst = !(navigator.language || '').toLowerCase().startsWith('en-us');

  const filled = [];
  const skipped = [];

  for (const { selector, key } of mappings) {
    if (!selector || !key) continue;

    let el = null;
    try {
      el = root.querySelector(selector);
    } catch {
      skipped.push({ target: selector, key, reason: 'invalid selector' });
      continue;
    }

    if (!el) {
      skipped.push({ target: selector, key, reason: 'selector matched nothing' });
      continue;
    }
    if (el.disabled || el.readOnly) {
      skipped.push({ target: selector, key, reason: 'input is not writable' });
      continue;
    }

    const entry = extraction[key];
    if (!entry || entry.value === '' || entry.value === null || entry.value === undefined) {
      skipped.push({ target: selector, key, reason: 'key not in PDF' });
      continue;
    }

    const target = targetFor(el, el.ownerDocument);
    if (applyValue(target, entry, dayFirst)) {
      filled.push({ target: selector, key, value: entry.value, score: 1 });
    } else {
      skipped.push({ target: selector, key, reason: 'value did not fit' });
    }
  }

  return { filled, skipped, targets: mappings.length };
}
