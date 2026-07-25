/**
 * Per-URL field mappings: "this CSS selector on this page gets that PDF key".
 *
 * What is stored is deliberately thin: selectors, PDF *key names*, and the
 * overlay button's position. No extracted value ever reaches storage — the PDF's
 * contents stay in the content script's memory, exactly as before. Storage is
 * `chrome.storage.local` rather than the page's `localStorage` precisely because
 * the host page can read and clear the latter.
 */

const STORE_KEY = 'pdftoformext.config';
const VERSION = 1;

/** Fallback when chrome.storage is unreachable (e.g. file:// without access). */
let memoryConfig = null;

function emptyConfig() {
  return { version: VERSION, sites: {} };
}

function storage() {
  try {
    return chrome?.storage?.local ?? null;
  } catch {
    return null;
  }
}

/** Query and hash are ignored: the same form reached two ways is one form. */
export function siteKey() {
  return `${location.origin}${location.pathname}`;
}

export async function loadAll() {
  const area = storage();
  if (!area) return memoryConfig ?? emptyConfig();

  try {
    const stored = await area.get(STORE_KEY);
    const config = stored?.[STORE_KEY];
    if (!config || typeof config !== 'object') return emptyConfig();
    return { version: config.version ?? VERSION, sites: config.sites ?? {} };
  } catch (err) {
    console.warn('[pdftoformext] could not read mappings:', err);
    return memoryConfig ?? emptyConfig();
  }
}

export async function saveAll(config) {
  const next = { version: VERSION, sites: config?.sites ?? {} };
  memoryConfig = next;

  const area = storage();
  if (!area) return false;

  try {
    await area.set({ [STORE_KEY]: next });
    return true;
  } catch (err) {
    console.warn('[pdftoformext] could not save mappings:', err);
    return false;
  }
}

/** @returns {{mappings: {selector: string, key: string}[], toggle: {x: number, y: number} | null}} */
export async function loadSite(key = siteKey()) {
  const config = await loadAll();
  const site = config.sites?.[key] ?? {};
  return {
    mappings: Array.isArray(site.mappings) ? site.mappings.filter(isMapping) : [],
    toggle: isPoint(site.toggle) ? site.toggle : null,
  };
}

/** Shallow-merges `{mappings}` and/or `{toggle}`, leaving other sites alone. */
export async function saveSite(patch, key = siteKey()) {
  const config = await loadAll();
  const site = { ...(config.sites?.[key] ?? {}) };

  if (patch.mappings) site.mappings = patch.mappings.filter(isMapping);
  if (patch.toggle !== undefined) site.toggle = patch.toggle;

  config.sites = { ...config.sites, [key]: site };
  return saveAll(config);
}

function isMapping(entry) {
  return Boolean(entry) && typeof entry.selector === 'string' && typeof entry.key === 'string';
}

function isPoint(value) {
  return Boolean(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
}

/* ------------------------------------------------------------------ *
 * Import / export
 * ------------------------------------------------------------------ */

/**
 * Validates a parsed config file. Throws on anything that is not recognisably
 * one of ours, so a bad import can change nothing.
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || !raw.sites || typeof raw.sites !== 'object') {
    throw new Error('not a pdftoformext mapping file');
  }

  const sites = {};
  for (const [key, site] of Object.entries(raw.sites)) {
    if (!site || typeof site !== 'object') continue;
    const mappings = Array.isArray(site.mappings) ? site.mappings.filter(isMapping) : [];
    const clean = { mappings };
    if (isPoint(site.toggle)) clean.toggle = site.toggle;
    sites[key] = clean;
  }

  if (!Object.keys(sites).length) throw new Error('file contains no mappings');
  return { version: VERSION, sites };
}

/** Site groups present in `incoming` replace the stored ones; the rest survive. */
export async function importConfig(incoming) {
  const valid = validateConfig(incoming);
  const config = await loadAll();
  config.sites = { ...config.sites, ...valid.sites };
  await saveAll(config);
  return Object.keys(valid.sites).length;
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

/**
 * Candidate selectors for an element, most readable first. Only selectors that
 * actually resolve to this one element are kept, so any of them is safe to save;
 * the structural path is the guaranteed fallback for a nameless input.
 */
export function selectorsFor(el, root = document) {
  const candidates = [];
  const tag = el.tagName.toLowerCase();

  const add = (selector) => {
    if (!selector || candidates.includes(selector)) return;
    try {
      const found = root.querySelectorAll(selector);
      if (found.length === 1 && found[0] === el) candidates.push(selector);
    } catch {
      /* generated selector was not valid here; skip it */
    }
  };

  if (el.id) add(`#${CSS.escape(el.id)}`);

  const name = el.getAttribute('name');
  if (name) {
    add(`${tag}[name="${cssString(name)}"]`);

    const scope = formScope(el.closest('form'));
    if (scope) add(`${scope} ${tag}[name="${cssString(name)}"]`);
  }

  if (el.type === 'radio' && name) add(`${tag}[name="${cssString(name)}"][value="${cssString(el.value)}"]`);

  const path = structuralPath(el);
  add(path);
  // Nothing verified — the element is somewhere querySelector cannot reach it
  // from the document root (a page's own shadow DOM, say). Offer the path
  // anyway so there is something to edit rather than a blank row.
  if (!candidates.length && path) candidates.push(path);

  return candidates;
}

function cssString(value) {
  return String(value ?? '').replace(/["\\]/g, '\\$&');
}

/** A selector for the form an input lives in, when the form is addressable. */
function formScope(form) {
  if (!form) return '';
  if (form.id) return `#${CSS.escape(form.id)}`;
  const name = form.getAttribute('name');
  return name ? `form[name="${cssString(name)}"]` : '';
}

/** `#panel > div:nth-of-type(2) > input:nth-of-type(1)`, anchored at the nearest id. */
function structuralPath(el) {
  const parts = [];
  let node = el;

  while (node && node.nodeType === 1 && node !== document.documentElement) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }

    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement
      ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
      : [node];
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    node = node.parentElement;
  }

  return parts.join(' > ');
}
