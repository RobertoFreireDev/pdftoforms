/**
 * Floating overlay: a draggable arrow that expands into the panel.
 *
 * This module owns the extraction object. It is a plain module-level variable:
 * never written to chrome.storage, localStorage, cookies, IndexedDB or the
 * network, and dropped when the page goes away. Treat any change to that as a
 * bug — it is the whole privacy story of this extension.
 *
 * Field *mappings* are a different thing and do persist (see lib/mappings.js):
 * they are CSS selectors and PDF key names, never values.
 */

import { extractPdf } from '../lib/pdf-extract.js';
import { fillMapped } from '../lib/autofill.js';
import {
  importConfig,
  loadAll,
  loadSite,
  matchCount,
  saveSite,
  selectorsFor,
  siteKey,
} from '../lib/mappings.js';

/** The one and only copy of the current PDF's contents. In memory, nowhere else. */
let extraction = null;

const HOST_ID = 'pdftoformext-overlay-host';
const TOGGLE_SIZE = 30;
const EDGE = 8;
/** Input types that are not sensible mapping targets. */
const UNPICKABLE = new Set(['hidden', 'submit', 'reset', 'button', 'image', 'file', 'password']);

function forget() {
  extraction = null;
}

// Belt and braces: drop the data on navigation even though the whole isolated
// world is torn down anyway.
addEventListener('pagehide', forget);
addEventListener('beforeunload', forget);

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

async function buildOverlay() {
  if (document.getElementById(HOST_ID)) return null;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // The host itself carries no layout beyond position, so it cannot disturb the
  // page; everything else is sealed inside the shadow root.
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = await loadStyles();
  shadow.append(style);

  shadow.append(render());
  (document.body ?? document.documentElement).append(host);
  return { shadow, host };
}

async function loadStyles() {
  try {
    const res = await fetch(chrome.runtime.getURL('src/content/overlay.css'));
    return await res.text();
  } catch {
    return ':host { font-family: sans-serif; }';
  }
}

function render() {
  const root = document.createElement('div');
  root.className = 'pfx-root';
  root.innerHTML = `
    <button class="pfx-toggle" type="button" aria-expanded="false" title="PDF autofill — drag to move">
      <span class="pfx-arrow" aria-hidden="true">▾</span>
    </button>
    <section class="pfx-panel" hidden>
      <div class="pfx-body">
        <p class="pfx-status">No PDF loaded.</p>
        <div class="pfx-actions">
          <button class="pfx-choose" type="button">Load PDF…</button>
          <button class="pfx-fill" type="button" disabled>Fill page</button>
          <button class="pfx-config-toggle" type="button" aria-expanded="false" disabled>Config</button>
        </div>
        <section class="pfx-config" hidden>
          <p class="pfx-config-hint"></p>
          <div class="pfx-map-list"></div>
          <p class="pfx-map-empty">No mappings for this page yet.</p>
          <div class="pfx-config-actions">
            <button class="pfx-map-save" type="button" disabled>Save</button>
            <button class="pfx-map-export" type="button" disabled>Export</button>
            <button class="pfx-map-import" type="button">Import</button>
          </div>
        </section>
        <p class="pfx-note">PDF contents stay in this tab's memory only.</p>
      </div>
      <input class="pfx-file" type="file" accept="application/pdf,.pdf" hidden>
      <input class="pfx-import-file" type="file" accept="application/json,.json" hidden>
    </section>
  `;
  return root;
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

async function wire(shadow, host) {
  const $ = (selector) => shadow.querySelector(selector);

  const root = $('.pfx-root');
  const toggle = $('.pfx-toggle');
  const arrow = $('.pfx-arrow');
  const panel = $('.pfx-panel');
  const status = $('.pfx-status');
  const fileInput = $('.pfx-file');
  const importInput = $('.pfx-import-file');
  const fillButton = $('.pfx-fill');
  const configButton = $('.pfx-config-toggle');
  const saveButton = $('.pfx-map-save');
  const exportButton = $('.pfx-map-export');
  const config = $('.pfx-config');
  const configHint = $('.pfx-config-hint');
  const mapList = $('.pfx-map-list');
  const mapEmpty = $('.pfx-map-empty');

  /** Mappings as last committed to storage — what the rows are restored from. */
  let savedMappings = [];
  let rowSeq = 0;

  const setStatus = (text, tone = '') => {
    status.textContent = text;
    status.dataset.tone = tone;
  };

  /**
   * Every button is enabled only when it can actually do something. Nothing
   * fills without a mapping, and nothing is mapped without a PDF to map from.
   *
   * Filling reads the rows on screen, not what storage holds, so it stays live
   * while Config is open — editing a row and filling is how a mapping gets
   * tried before it is committed.
   */
  const refreshControls = () => {
    const loaded = Boolean(extraction);
    fillButton.disabled = !loaded || currentRowMappings().length === 0;
    configButton.disabled = !loaded;
    // An empty list is still worth saving when there is something to clear.
    saveButton.disabled = currentRowMappings().length === 0 && savedMappings.length === 0;
    if (configButton.disabled && !config.hidden) openConfig(false);
  };

  /** Export writes the whole config file, so it needs a mapping *somewhere*. */
  const refreshExportState = async () => {
    const stored = await loadAll().catch(() => null);
    exportButton.disabled = !Object.values(stored?.sites ?? {}).some((site) => site.mappings?.length);
  };

  /** Reflect whatever `extraction` currently is — never a caller's idea of it. */
  const setLoaded = () => {
    toggle.classList.toggle('pfx-loaded', Boolean(extraction));
    refreshControls();
  };

  /* ------------------------------------------------------ position */

  let pos = { x: innerWidth - TOGGLE_SIZE - 16, y: 16 };

  const clamp = (point) => ({
    x: Math.min(Math.max(point.x, EDGE), Math.max(EDGE, innerWidth - TOGGLE_SIZE - EDGE)),
    y: Math.min(Math.max(point.y, EDGE), Math.max(EDGE, innerHeight - TOGGLE_SIZE - EDGE)),
  });

  const applyPosition = () => {
    root.style.left = `${pos.x}px`;
    root.style.top = `${pos.y}px`;
    // The panel hangs off the button, so it has to flip away from whichever
    // edges the button was dropped near.
    root.classList.toggle('pfx-up', pos.y > innerHeight / 2);
    root.classList.toggle('pfx-left', pos.x < innerWidth / 2);
  };

  const moveTo = (point) => {
    pos = clamp(point);
    applyPosition();
  };

  // Place it before anything is awaited, so the button never flashes at the
  // stylesheet's default corner while storage is read.
  moveTo(pos);
  addEventListener('resize', () => moveTo(pos));

  /* ---------------------------------------------------------- drag */

  let dragStart = null;
  let dragOrigin = null;
  let dragged = false;
  let suppressClick = false;

  toggle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragStart = { x: event.clientX, y: event.clientY };
    dragOrigin = { ...pos };
    dragged = false;
    // A cancelled pointer never produces the click that would clear this.
    suppressClick = false;
    toggle.setPointerCapture(event.pointerId);
  });

  toggle.addEventListener('pointermove', (event) => {
    if (!dragStart) return;
    const dx = event.clientX - dragStart.x;
    const dy = event.clientY - dragStart.y;
    // A few pixels of slop, so a slightly shaky click is still a click.
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    dragged = true;
    root.classList.add('pfx-dragging');
    moveTo({ x: dragOrigin.x + dx, y: dragOrigin.y + dy });
  });

  const endDrag = (event) => {
    if (!dragStart) return;
    try {
      toggle.releasePointerCapture(event.pointerId);
    } catch { /* pointer already gone */ }
    dragStart = null;
    root.classList.remove('pfx-dragging');
    if (dragged) {
      suppressClick = true;
      saveSite({ toggle: pos }).catch(() => {});
    }
  };

  toggle.addEventListener('pointerup', endDrag);
  toggle.addEventListener('pointercancel', endDrag);

  /* --------------------------------------------------------- panel */

  const openPanel = (open) => {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    arrow.textContent = open ? '▴' : '▾';
    if (!open) openConfig(false);
  };

  toggle.addEventListener('click', () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    openPanel(panel.hidden);
  });

  /* ------------------------------------------------------------ pdf */

  $('.pfx-choose').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;

    setStatus(`Reading ${file.name}…`);
    // The previous PDF is stale the moment another one is chosen.
    forget();
    setLoaded();

    try {
      const buffer = await file.arrayBuffer();
      extraction = await extractPdf(buffer);
      const counts = summarize(extraction);
      setStatus(`${counts.total} values from ${file.name} (${counts.fields} fields, ${counts.cells} table cells).`, 'ok');
      setLoaded();
      // Loading no longer fills anything; it only makes values available.
      refreshKeyOptions();
    } catch (err) {
      forget();
      setLoaded();
      setStatus(`Could not read that PDF: ${err?.message ?? err}`, 'error');
      console.error('[pdftoformext] extraction failed:', err);
    }
  });

  // The rows on screen are the whole story: an input nobody mapped is an input
  // nobody wanted filled. They are what is on screen rather than what is in
  // storage so that Save is about *keeping* a mapping, not about arming it.
  fillButton.addEventListener('click', () => {
    const list = currentRowMappings();
    if (!extraction || !list.length) return;

    const result = fillMapped(extraction, list, { root: document });
    // Rows survive closing Config, so what just filled the page can be a list
    // the user is not looking at. Say when it was not the saved one.
    const pending = sameMappings(list, savedMappings) ? '' : ' Unsaved mappings.';
    setStatus(
      `Filled ${result.filled.length} of ${result.targets} mapped field(s).${pending}`,
      result.filled.length ? 'ok' : 'warn',
    );
  });

  /* ------------------------------------------------------- mapping */

  const rows = () => [...mapList.querySelectorAll('.pfx-map-row')];

  function currentRowMappings() {
    return rows()
      .map((row) => ({
        selector: row.querySelector('.pfx-map-selector').value.trim(),
        key: row.querySelector('.pfx-map-key').value,
      }))
      .filter((entry) => entry.selector && entry.key);
  }

  /** Rebuilds one row's key dropdown, keeping whatever it already points at. */
  function fillKeyOptions(select, wanted = select.value) {
    select.replaceChildren();
    select.append(new Option('— PDF value —', ''));

    const entries = Object.values(extraction ?? {});
    const fields = entries.filter((entry) => entry.source === 'acroform');
    const tables = new Map();
    for (const entry of entries) {
      if (entry.source !== 'table') continue;
      const bucket = tables.get(entry.table) ?? [];
      bucket.push(entry);
      tables.set(entry.table, bucket);
    }

    const group = (label, list) => {
      if (!list.length) return;
      const optgroup = document.createElement('optgroup');
      optgroup.label = label;
      for (const entry of list) {
        const option = new Option(`${entry.key} — ${truncate(String(entry.value ?? ''), 36)}`, entry.key);
        optgroup.append(option);
      }
      select.append(optgroup);
    };

    group('Fields', fields);
    for (const [index, cells] of [...tables.entries()].sort((a, b) => a[0] - b[0])) {
      group(`Table ${index}`, cells);
    }

    // A mapping saved against a PDF that is not loaded right now must survive
    // being re-rendered, so keep its key as an option of its own.
    if (wanted && !extraction?.[wanted]) {
      const orphan = document.createElement('optgroup');
      orphan.label = 'Saved';
      orphan.append(new Option(`${wanted} — (not in loaded PDF)`, wanted));
      select.append(orphan);
    }
    select.value = wanted ?? '';
  }

  function refreshKeyOptions() {
    for (const row of rows()) fillKeyOptions(row.querySelector('.pfx-map-key'));
  }

  function updateRowState(row) {
    const selector = row.querySelector('.pfx-map-selector').value.trim();
    const state = row.querySelector('.pfx-map-state');
    const count = selector ? matchCount(selector) : 0;
    const ok = count === 1;

    state.textContent = selector ? (ok ? '✓' : '✕') : '';
    state.dataset.ok = String(ok);
    state.title = !selector ? ''
      : count === -1 ? 'Not a valid CSS selector'
        : count === 0 ? 'Matches nothing on this page'
          : count === 1 ? 'Matches one field'
            : `Matches ${count} elements — needs to be more specific`;
  }

  function addRow({ selector = '', key = '', candidates = [] } = {}) {
    const listId = `pfx-selectors-${(rowSeq += 1)}`;
    const row = document.createElement('div');
    row.className = 'pfx-map-row';
    row.innerHTML = `
      <input class="pfx-map-selector" type="text" list="${listId}" placeholder="CSS selector" spellcheck="false">
      <datalist id="${listId}"></datalist>
      <select class="pfx-map-key"></select>
      <span class="pfx-map-state"></span>
      <button class="pfx-map-del" type="button" aria-label="Delete mapping">×</button>
    `;

    const selectorInput = row.querySelector('.pfx-map-selector');
    selectorInput.value = selector;

    setCandidates(row, candidates);
    fillKeyOptions(row.querySelector('.pfx-map-key'), key);

    selectorInput.addEventListener('input', () => {
      updateRowState(row);
      refreshControls();
    });
    row.querySelector('.pfx-map-key').addEventListener('change', refreshControls);
    row.querySelector('.pfx-map-del').addEventListener('click', () => {
      row.remove();
      updateEmptyState();
      refreshControls();
    });

    mapList.append(row);
    updateRowState(row);
    updateEmptyState();
    refreshControls();
    return row;
  }

  /** The row's dropdown of ready-made selectors for the element it was picked from. */
  function setCandidates(row, candidates) {
    const datalist = row.querySelector('datalist');
    datalist.replaceChildren();
    for (const candidate of candidates) {
      const option = document.createElement('option');
      option.value = candidate;
      datalist.append(option);
    }
  }

  function updateEmptyState() {
    mapEmpty.hidden = rows().length > 0;
  }

  function renderRows(list) {
    mapList.replaceChildren();
    for (const { selector, key } of list) addRow({ selector, key });
    updateEmptyState();
  }

  /* ------------------------------------------------------ pick mode */

  /** The field a page event points at, or null if it is not a pickable one. */
  function pickable(event) {
    const path = event.composedPath?.() ?? [event.target];
    if (path.includes(host)) return null;

    const el = path.find(
      (node) => node instanceof HTMLElement && /^(input|select|textarea)$/i.test(node.tagName),
    );
    if (!el) return null;
    if (el.tagName === 'INPUT' && UNPICKABLE.has((el.type || '').toLowerCase())) return null;
    return el;
  }

  // A select opens its dropdown on mousedown, and focus moves there too — both
  // are page changes the user did not ask for by picking a field.
  const onPagePress = (event) => {
    if (!pickable(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onPagePick = (event) => {
    const el = pickable(event);
    if (!el) return;

    // Picking must not change the page: a checkbox click would otherwise toggle.
    event.preventDefault();
    event.stopPropagation();

    const candidates = selectorsFor(el);
    const existing = rows().find((row) => {
      const value = row.querySelector('.pfx-map-selector').value.trim();
      return value && candidates.includes(value);
    });

    // Re-offer the candidates on an existing row in case the page changed shape.
    const row = existing ?? addRow({ selector: candidates[0] ?? '', candidates });
    if (existing) setCandidates(existing, candidates);

    row.classList.add('pfx-map-row-flash');
    setTimeout(() => row.classList.remove('pfx-map-row-flash'), 600);
    row.querySelector('.pfx-map-key').focus();
  };

  function openConfig(open) {
    // Mapping means picking a PDF key; without a PDF there is nothing to pick.
    if (open && !extraction) return;

    config.hidden = !open;
    configButton.setAttribute('aria-expanded', String(open));
    configButton.classList.toggle('pfx-active', open);
    if (open) {
      document.addEventListener('mousedown', onPagePress, true);
      document.addEventListener('click', onPagePick, true);
    } else {
      document.removeEventListener('mousedown', onPagePress, true);
      document.removeEventListener('click', onPagePick, true);
    }
    // Opening or closing Config is itself one of the conditions now.
    refreshControls();
  }

  configButton.addEventListener('click', () => openConfig(config.hidden));

  /* -------------------------------------------------- config actions */

  saveButton.addEventListener('click', async () => {
    const list = currentRowMappings();
    const ok = await saveSite({ mappings: list });
    savedMappings = list;
    setStatus(
      ok
        ? `Saved ${list.length} mapping(s) for ${truncate(siteKey(), 40)}.`
        : 'Could not reach extension storage — mappings kept for this tab only.',
      ok ? 'ok' : 'warn',
    );
    refreshControls();
    refreshExportState();
  });

  exportButton.addEventListener('click', async () => {
    const stored = await loadAll();
    const blob = new Blob([JSON.stringify(stored, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'pdftoformext-mappings.json';
    shadow.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    // Sites holding only a toggle position are along for the ride, not the point.
    const mapped = Object.values(stored.sites ?? {}).filter((entry) => entry.mappings?.length).length;
    setStatus(`Exported mappings for ${mapped} page(s).`, 'ok');
  });

  $('.pfx-map-import').addEventListener('click', () => importInput.click());

  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;

    try {
      const count = await importConfig(JSON.parse(await file.text()));
      const site = await loadSite();
      savedMappings = site.mappings;
      renderRows(savedMappings);
      refreshControls();
      refreshExportState();
      setStatus(`Imported mappings for ${count} page(s).`, 'ok');
    } catch (err) {
      setStatus(`Could not import that file: ${err?.message ?? err}`, 'error');
    }
  });

  /* ---------------------------------------------------------- boot */

  configHint.textContent = 'Click a field on the page to add it.';

  const site = await loadSite();
  savedMappings = site.mappings;
  renderRows(savedMappings);
  refreshControls();
  refreshExportState();
  moveTo(site.toggle ?? pos);
}

function summarize(entries) {
  const values = Object.values(entries);
  return {
    total: values.length,
    fields: values.filter((entry) => entry.source === 'acroform').length,
    cells: values.filter((entry) => entry.source === 'table').length,
  };
}

/** Order matters: the rows are a list the user arranged, not a set. */
function sameMappings(a, b) {
  return a.length === b.length
    && a.every((entry, i) => entry.selector === b[i].selector && entry.key === b[i].key);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

buildOverlay()
  .then((mounted) => mounted && wire(mounted.shadow, mounted.host))
  .catch((err) => console.error('[pdftoformext] overlay failed to mount:', err));
