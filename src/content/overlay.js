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

import { extractPdf, tablesOf } from '../lib/pdf-extract.js';
import { fillMapped } from '../lib/autofill.js';
import {
  importConfig,
  loadAll,
  loadSite,
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
/** A search this broad is a bad search; say so rather than render thousands of rows. */
const SEARCH_LIMIT = 200;

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
          <div class="pfx-config-main">
            <p class="pfx-config-hint"></p>
            <div class="pfx-map-list"></div>
            <p class="pfx-map-empty">No mappings for this page yet.</p>
            <div class="pfx-config-actions">
              <button class="pfx-map-save" type="button" disabled>Save</button>
              <button class="pfx-map-export" type="button" disabled>Export</button>
              <button class="pfx-map-import" type="button">Import</button>
            </div>
          </div>
          <div class="pfx-picker" role="group" aria-label="Choose a PDF value" hidden>
            <div class="pfx-picker-head">
              <span class="pfx-picker-title"></span>
              <button class="pfx-picker-clear" type="button">Clear</button>
              <button class="pfx-picker-cancel" type="button" aria-label="Cancel">×</button>
            </div>
            <div class="pfx-picker-tabs" role="group" aria-label="Value source"></div>
            <input class="pfx-picker-filter" type="search" placeholder="Search values…" spellcheck="false">
            <div class="pfx-picker-body"></div>
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
  const configMain = $('.pfx-config-main');
  const configHint = $('.pfx-config-hint');
  const mapList = $('.pfx-map-list');
  const mapEmpty = $('.pfx-map-empty');
  const picker = $('.pfx-picker');
  const pickerTitle = $('.pfx-picker-title');
  const pickerTabs = $('.pfx-picker-tabs');
  const pickerFilter = $('.pfx-picker-filter');
  const pickerBody = $('.pfx-picker-body');

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
    // The previous PDF is stale the moment another one is chosen, and so is
    // anything the picker is showing from it.
    closePicker();
    forget();
    tablesCache = null;
    setLoaded();

    try {
      const buffer = await file.arrayBuffer();
      extraction = await extractPdf(buffer);
      tablesCache = null;
      const counts = summarize(extraction);
      setStatus(`${counts.total} values from ${file.name} (${counts.fields} fields, ${counts.cells} table cells).`, 'ok');
      setLoaded();
      // Loading no longer fills anything; it only makes values available.
      relabelRowKeys();
    } catch (err) {
      forget();
      tablesCache = null;
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
        key: row.dataset.key ?? '',
      }))
      .filter((entry) => entry.selector && entry.key);
  }

  /**
   * Points a row at a key. The key itself lives on the row's dataset — the
   * button only shows what it resolves to, since a key is the thing nobody can
   * read and the value is the thing everybody can.
   */
  function setRowKey(row, key) {
    row.dataset.key = key ?? '';
    const { text, known } = describeKey(extraction, row.dataset.key);
    const button = row.querySelector('.pfx-map-key');
    button.textContent = text;
    // The raw key is what gets saved and exported, so keep it inspectable now
    // that it is no longer the visible text.
    button.title = row.dataset.key || 'Choose a value from the PDF';
    button.toggleAttribute('data-orphan', !known);
    refreshControls();
  }

  /** A newly loaded PDF can resolve keys that were only names a moment ago. */
  function relabelRowKeys() {
    for (const row of rows()) setRowKey(row, row.dataset.key ?? '');
  }

  function addRow({ selector = '', key = '', candidates = [] } = {}) {
    const listId = `pfx-selectors-${(rowSeq += 1)}`;
    const row = document.createElement('div');
    row.className = 'pfx-map-row';
    row.innerHTML = `
      <input class="pfx-map-selector" type="text" list="${listId}" placeholder="CSS selector" spellcheck="false">
      <datalist id="${listId}"></datalist>
      <button class="pfx-map-key" type="button" aria-haspopup="true" aria-expanded="false"></button>
      <button class="pfx-map-del" type="button" aria-label="Delete mapping">×</button>
    `;

    const selectorInput = row.querySelector('.pfx-map-selector');
    selectorInput.value = selector;

    setCandidates(row, candidates);
    setRowKey(row, key);

    selectorInput.addEventListener('input', refreshControls);
    row.querySelector('.pfx-map-key').addEventListener('click', () => openPicker(row));
    row.querySelector('.pfx-map-del').addEventListener('click', () => {
      if (pickerRow === row) closePicker();
      row.remove();
      updateEmptyState();
      refreshControls();
    });

    mapList.append(row);
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
    // Every row is about to be replaced, so a picker still open would be
    // pointing at a detached one.
    closePicker();
    mapList.replaceChildren();
    for (const { selector, key } of list) addRow({ selector, key });
    updateEmptyState();
  }

  /* ---------------------------------------------------- value picker */

  /** The row the picker is choosing for, or null when it is closed. */
  let pickerRow = null;
  /** 'fields', or a table index. */
  let pickerTab = 'fields';
  /** tablesOf() is pure and the PDF does not change under us; rebuild per load. */
  let tablesCache = null;

  const tables = () => (tablesCache ??= tablesOf(extraction ?? {}));
  const acroFields = () => Object.values(extraction ?? {}).filter((e) => e.source === 'acroform');

  /**
   * Everything the picker can offer, each table cell exactly once — searching
   * the raw extraction object would list every headered cell twice, under both
   * of its keys, which is the noise the grid exists to get rid of.
   */
  const allValues = () => [
    ...acroFields(),
    ...tables().flatMap((table) => table.rows.flatMap((row) => [...row.cells.values()])),
  ];

  /** Open on whichever tab already holds the row's key, so it can be seen in place. */
  function defaultTabFor(key) {
    const entry = extraction?.[key];
    if (entry?.source === 'table') return entry.table;
    if (acroFields().length) return 'fields';
    return tables()[0]?.index ?? 'fields';
  }

  function openPicker(row) {
    // Same rule as Config itself: without a PDF there is nothing to pick.
    if (!extraction) return;
    pickerRow = row;
    pickerFilter.value = '';
    pickerTab = defaultTabFor(row.dataset.key);
    row.querySelector('.pfx-map-key').setAttribute('aria-expanded', 'true');
    configMain.hidden = true;
    picker.hidden = false;
    renderPicker();
    pickerFilter.focus();
  }

  function closePicker() {
    if (picker.hidden) return;
    picker.hidden = true;
    configMain.hidden = false;
    const button = pickerRow?.querySelector('.pfx-map-key');
    pickerRow = null;
    button?.setAttribute('aria-expanded', 'false');
    // Only chase the focus back if there is something visible to chase it to.
    if (button?.isConnected && !panel.hidden && !config.hidden) button.focus();
  }

  /** The one and only place the picker writes a key. Cancelling must not. */
  function chooseKey(key) {
    const row = pickerRow;
    if (!row) return;
    setRowKey(row, key);
    closePicker();
    row.classList.add('pfx-map-row-flash');
    setTimeout(() => row.classList.remove('pfx-map-row-flash'), 600);
  }

  function renderPicker() {
    const selector = pickerRow?.querySelector('.pfx-map-selector').value.trim();
    pickerTitle.textContent = selector ? `Value for ${truncate(selector, 44)}` : 'Choose a PDF value';

    renderPickerTabs();

    const query = pickerFilter.value.trim().toLowerCase();
    if (query) {
      // Searching is deliberately global, ignoring the tab: people remember the
      // value, not which block of the page it landed in.
      const matches = allValues().filter((entry) => matchesQuery(entry, query));
      pickerBody.replaceChildren(renderEntryList(matches, `Nothing matches “${pickerFilter.value.trim()}”.`));
      return;
    }

    // A PDF can extract to nothing at all — a scanned page with no text layer.
    const empty = allValues().length ? 'This PDF has no form fields.' : 'This PDF has no extractable values.';
    const table = pickerTab === 'fields' ? null : tables().find((entry) => entry.index === pickerTab);
    pickerBody.replaceChildren(
      table ? renderGrid(table) : renderEntryList(pickerTab === 'fields' ? acroFields() : [], empty),
    );
  }

  function renderPickerTabs() {
    const groups = [];
    if (acroFields().length) groups.push({ id: 'fields', label: 'Fields' });
    for (const table of tables()) groups.push({ id: table.index, label: `Table ${table.index} · p${table.page}` });

    // One group is not a choice, and no groups is an empty PDF.
    pickerTabs.hidden = groups.length < 2;
    const fragment = document.createDocumentFragment();
    for (const { id, label } of groups) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pfx-picker-tab';
      button.dataset.tab = String(id);
      button.setAttribute('aria-pressed', String(id === pickerTab));
      button.textContent = label;
      fragment.append(button);
    }
    pickerTabs.replaceChildren(fragment);
  }

  /** Flat list of entries — the Fields tab, and every search result. */
  function renderEntryList(entries, emptyText) {
    const fragment = document.createDocumentFragment();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'pfx-picker-empty';
      empty.textContent = emptyText;
      fragment.append(empty);
      return fragment;
    }

    const list = document.createElement('div');
    list.className = 'pfx-picker-list';
    for (const entry of entries.slice(0, SEARCH_LIMIT)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.key = entry.key;
      button.title = entry.key;
      if (entry.key === pickerRow?.dataset.key) button.dataset.selected = '';
      button.textContent = describeEntry(entry);
      list.append(button);
    }
    fragment.append(list);

    if (entries.length > SEARCH_LIMIT) {
      const note = document.createElement('p');
      note.className = 'pfx-picker-empty';
      note.textContent = `Showing the first ${SEARCH_LIMIT} of ${entries.length} — narrow the search.`;
      fragment.append(note);
    }
    return fragment;
  }

  /**
   * A table, as a table. Every row of the grid is rendered as a body row,
   * including the one the header text came from: which row that was is not
   * recorded, its cells are real keys somebody may want, and the sticky label
   * strip above already says what each column means.
   */
  function renderGrid(table) {
    const selected = extraction?.[pickerRow?.dataset.key ?? ''];
    const isSelected = (entry) => selected?.source === 'table'
      && selected.table === entry.table
      && selected.row === entry.row
      && selected.col === entry.col;

    const grid = document.createElement('table');
    grid.className = 'pfx-picker-grid';

    const head = grid.createTHead().insertRow();
    head.append(document.createElement('th')); // corner, above the row gutter
    for (const col of table.cols) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = table.headers.get(col) ?? `C${col}`;
      th.title = th.textContent;
      head.append(th);
    }

    const body = grid.createTBody();
    let roved = false;
    for (const { index, cells } of table.rows) {
      const tr = body.insertRow();
      const gutter = document.createElement('th');
      gutter.scope = 'row';
      gutter.textContent = String(index);
      tr.append(gutter);

      for (const col of table.cols) {
        const td = tr.insertCell();
        const entry = cells.get(col);
        if (!entry) {
          td.className = 'pfx-cell-blank';
          continue;
        }
        td.dataset.key = entry.key;
        td.title = String(entry.value ?? '');
        td.textContent = td.title;
        if (isSelected(entry)) {
          td.dataset.selected = '';
          td.tabIndex = 0;
          roved = true;
        } else {
          td.tabIndex = -1;
        }
      }
    }

    // Exactly one cell is tabbable; the arrow keys move which one.
    if (!roved) {
      const first = body.querySelector('td[data-key]');
      if (first) first.tabIndex = 0;
    }
    return grid;
  }

  pickerFilter.addEventListener('input', renderPicker);

  pickerTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.pfx-picker-tab');
    if (!tab) return;
    pickerTab = tab.dataset.tab === 'fields' ? 'fields' : Number(tab.dataset.tab);
    renderPicker();
  });

  // One listener, not one per cell: a full-page table is easily 900 of them.
  pickerBody.addEventListener('click', (event) => {
    const target = event.target.closest('[data-key]');
    if (target) chooseKey(target.dataset.key);
  });

  // Blanking a key parks a row without deleting it — the empty option of the
  // dropdown this replaced was the only way to do that.
  $('.pfx-picker-clear').addEventListener('click', () => chooseKey(''));
  $('.pfx-picker-cancel').addEventListener('click', () => closePicker());

  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // The host page may have an Escape handler of its own; this one is not for it.
      event.stopPropagation();
      closePicker();
      return;
    }

    const cell = event.target.closest?.('td[data-key]');
    if (!cell) return;

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chooseKey(cell.dataset.key);
      return;
    }

    const next = neighbourCell(cell, event.key);
    if (!next) return;
    event.preventDefault();
    cell.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });

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

    // The map list is hidden while the picker is up, so the row about to be
    // added and flashed would be added and flashed out of sight.
    closePicker();

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
    if (!open) closePicker();

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

/** One line naming what an entry is, in the terms the PDF shows it in. */
function describeEntry(entry) {
  const value = truncate(String(entry.value ?? ''), 48);
  if (entry.source === 'table') {
    return `T${entry.table} · ${entry.header || `C${entry.col}`} · row ${entry.row} — ${value}`;
  }
  return `${entry.label || entry.name || entry.key} — ${value}`;
}

/** Button text for a key, and whether the loaded PDF actually has it. */
function describeKey(extracted, key) {
  if (!key) return { text: '— PDF value —', known: true };
  const entry = extracted?.[key];
  if (entry) return { text: describeEntry(entry), known: true };
  // A mapping saved against a PDF that is not loaded right now must survive.
  return { text: `${key} — (not in loaded PDF)`, known: false };
}

function matchesQuery(entry, needle) {
  return [entry.key, entry.label, entry.header, entry.name, entry.value]
    .some((field) => field != null && String(field).toLowerCase().includes(needle));
}

/**
 * The cell an arrow key from `cell` lands on. Empty slots are real `<td>`s with
 * no key, so both axes step over them rather than stopping on a dead cell.
 */
function neighbourCell(cell, key) {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[key];
  if (step === undefined) return null;
  const back = step < 0;
  const sideways = key === 'ArrowLeft' || key === 'ArrowRight';

  if (sideways) {
    let next = cell;
    while ((next = back ? next.previousElementSibling : next.nextElementSibling)) {
      if (next.dataset.key !== undefined) return next;
    }
    return null;
  }

  // cellIndex counts the row-number <th> too, and every row has one, so the
  // same index is the same column on every row.
  const column = cell.cellIndex;
  let row = cell.parentElement;
  while ((row = back ? row.previousElementSibling : row.nextElementSibling)) {
    const candidate = row.cells[column];
    if (candidate?.dataset.key !== undefined) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

buildOverlay()
  .then((mounted) => mounted && wire(mounted.shadow, mounted.host))
  .catch((err) => console.error('[pdftoformext] overlay failed to mount:', err));
