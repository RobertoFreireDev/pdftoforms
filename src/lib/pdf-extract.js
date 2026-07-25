/**
 * PDF -> one flat, keyed extraction object.
 *
 * Every AcroForm field and every table cell in the document gets a key. Values
 * carry provenance (page, label, rect) so the Config dropdown can describe them.
 *
 * Key shapes:
 *   field.<sanitized field name>              AcroForm field
 *   table.<tableIndex>.r<row>.c<col>          table cell, positional
 *   table.<tableIndex>.<header>.<row>         table cell, by column header
 *
 * Nothing here touches storage or the network. The returned object is handed
 * straight back to the caller and lives only as long as the caller holds it.
 */

import * as pdfjs from '../../vendor/pdf.mjs';

const WORKER_URL = chrome.runtime.getURL('vendor/pdf.worker.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL;

/* ------------------------------------------------------------------ *
 * Geometry tuning.  All ratios are relative to the median glyph height
 * on the page, so they hold across page sizes and font scales.
 * ------------------------------------------------------------------ */

/** Baselines within this fraction of a line height belong to the same row. */
const ROW_TOLERANCE_RATIO = 0.5;
/** Horizontal gap below this fraction of a line height joins two text runs. */
const CELL_MERGE_GAP_RATIO = 0.6;
/** Two cell starts within this fraction of a line height share a column. */
const COLUMN_BAND_RATIO = 1.2;
/** A vertical gap wider than this many line heights ends a table block. */
const ROW_BREAK_RATIO = 2.5;
/** Fraction of a cell's own width a gap may be before a space is inserted. */
const SPACE_GAP_RATIO = 0.18;
/** Share of cells that must land on a shared column band for a real table. */
const MIN_ALIGNMENT = 0.6;

/* ------------------------------------------------------------------ *
 * pdf.js worker
 * ------------------------------------------------------------------ */

let fakeWorkerReady = null;

/**
 * A dedicated worker keeps parsing off the host page's main thread. Some pages
 * ship a CSP strict enough to block worker construction from the isolated
 * world; when that happens we fall back to pdf.js's main-thread "fake worker",
 * which is slower but always available.
 */
function makeWorkerPort() {
  try {
    return new Worker(WORKER_URL, { type: 'module' });
  } catch {
    return null;
  }
}

async function useFakeWorker() {
  pdfjs.GlobalWorkerOptions.workerPort = null;
  // Importing the worker module registers globalThis.pdfjsWorker, which pdf.js
  // picks up instead of trying to spawn a real Worker.
  fakeWorkerReady ??= import(WORKER_URL);
  await fakeWorkerReady;
}

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

/** "Applicant Name" / "form1[0].name[0]" -> "applicant_name" / "form1_0_name_0" */
export function sanitizeKey(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unnamed';
}

/** Claims `key`, suffixing __2, __3, … until it is free. */
function claimKey(entries, key) {
  if (!(key in entries)) return key;
  let n = 2;
  while (`${key}__${n}` in entries) n += 1;
  return `${key}__${n}`;
}

function put(entries, entry) {
  const key = claimKey(entries, entry.key);
  entries[key] = { ...entry, key };
  return key;
}

/* ------------------------------------------------------------------ *
 * Text geometry
 * ------------------------------------------------------------------ */

/**
 * pdf.js text items -> positioned boxes in PDF user space (y grows upward).
 */
function toBoxes(textContent) {
  const boxes = [];
  for (const item of textContent.items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const t = item.transform;
    const height = Math.abs(item.height) || Math.abs(t[3]) || 10;
    boxes.push({
      str: item.str,
      x0: t[4],
      x1: t[4] + (item.width || 0),
      y: t[5],
      height,
    });
  }
  return boxes;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Groups boxes into visual rows by shared baseline, then merges horizontally
 * adjacent runs into cells. Returns rows ordered top-to-bottom, each with cells
 * ordered left-to-right.
 */
function buildRows(boxes, lineHeight) {
  const rowTol = Math.max(1, lineHeight * ROW_TOLERANCE_RATIO);
  const mergeGap = lineHeight * CELL_MERGE_GAP_RATIO;

  const byBaseline = [...boxes].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const rows = [];
  for (const box of byBaseline) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - box.y) <= rowTol) {
      row.boxes.push(box);
      // Keep the row baseline as a running mean so drifting rows stay together.
      row.y = (row.y * (row.boxes.length - 1) + box.y) / row.boxes.length;
    } else {
      rows.push({ y: box.y, boxes: [box] });
    }
  }

  return rows.map((row) => {
    row.boxes.sort((a, b) => a.x0 - b.x0);
    const cells = [];
    for (const box of row.boxes) {
      const cell = cells[cells.length - 1];
      const gap = cell ? box.x0 - cell.x1 : Infinity;
      if (cell && gap <= mergeGap) {
        const needsSpace = gap > box.height * SPACE_GAP_RATIO && !/\s$/.test(cell.text);
        cell.text += (needsSpace ? ' ' : '') + box.str;
        cell.x1 = Math.max(cell.x1, box.x1);
      } else {
        cells.push({ text: box.str, x0: box.x0, x1: box.x1, y: box.y, height: box.height });
      }
    }
    for (const cell of cells) cell.text = cell.text.replace(/\s+/g, ' ').trim();
    return { y: row.y, cells: cells.filter((c) => c.text) };
  }).filter((row) => row.cells.length);
}

/**
 * Splits rows into blocks of vertically contiguous lines. A wide vertical gap
 * ends a block — that is where one table stops and unrelated content begins.
 */
function splitBlocks(rows, lineHeight) {
  const maxGap = lineHeight * ROW_BREAK_RATIO;
  const blocks = [];
  let current = [];
  let prevY = null;
  for (const row of rows) {
    if (prevY !== null && prevY - row.y > maxGap && current.length) {
      blocks.push(current);
      current = [];
    }
    current.push(row);
    prevY = row.y;
  }
  if (current.length) blocks.push(current);
  return blocks;
}

/**
 * Clusters the left edges of every cell in a block into column bands, then
 * assigns each cell a column index. Returns null when the block has no
 * recognisable column structure.
 */
function assignColumns(block, lineHeight, { minColumns }) {
  const tol = Math.max(2, lineHeight * COLUMN_BAND_RATIO);
  const starts = block.flatMap((row) => row.cells.map((c) => c.x0)).sort((a, b) => a - b);

  const bands = [];
  for (const x of starts) {
    const band = bands[bands.length - 1];
    if (band && x - band.x <= tol) {
      band.count += 1;
      band.x = (band.x * (band.count - 1) + x) / band.count;
    } else {
      bands.push({ x, count: 1 });
    }
  }
  if (bands.length < minColumns) return null;

  let placed = 0;
  let total = 0;
  const grid = block.map((row) => {
    const used = new Set();
    return row.cells.map((cell) => {
      total += 1;
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < bands.length; i += 1) {
        const dist = Math.abs(cell.x0 - bands[i].x);
        if (dist < bestDist && !used.has(i)) {
          bestDist = dist;
          best = i;
        }
      }
      // A cell that lands nowhere near a band still needs a slot; give it the
      // next free one so nothing is dropped.
      if (best === -1) best = bands.length + used.size;
      else if (bestDist <= tol) placed += 1;
      used.add(best);
      return { ...cell, col: best };
    });
  });

  const alignment = total ? placed / total : 0;
  return { grid, columns: bands.length, alignment };
}

const looksLikeLabel = (text) => text.length <= 60 && !/^[\d.,%$€£\-+/\s]+$/.test(text);

/**
 * Finds the header row: the first row of three or more non-numeric text cells
 * that has data rows beneath it. Single-cell rows above it are a caption or
 * title, not part of the grid, so the search steps over them.
 *
 * Three columns is the bar because a two-column block is far more often a
 * "Label   value" list than a headed table, and reading its first row as
 * headers would label every value with the first row's value.
 *
 * @returns {{headers: Map<number, string>, rowIndex: number} | null}
 */
function detectHeader(grid) {
  for (let rowIndex = 0; rowIndex < grid.length - 1; rowIndex += 1) {
    const row = grid[rowIndex];
    if (row.length < 3) continue; // a title or a label/value pair — keep looking
    if (!row.every((cell) => looksLikeLabel(cell.text))) return null;

    const headers = new Map();
    for (const cell of row) headers.set(cell.col, cell.text);
    return { headers, rowIndex };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

/**
 * Nearest visible text for a widget: prefer a run ending to the left of the
 * field on the same line, otherwise the closest run sitting above it.
 */
function nearestLabel(rect, rows) {
  const [x0, y0, x1, y1] = rect;
  const midY = (y0 + y1) / 2;
  const height = Math.max(1, y1 - y0);

  let left = null;
  let above = null;
  for (const row of rows) {
    for (const cell of row.cells) {
      const onLine = Math.abs(cell.y - midY) <= height;
      if (onLine && cell.x1 <= x0 + height * 0.5) {
        const dist = x0 - cell.x1;
        if (!left || dist < left.dist) left = { dist, text: cell.text };
      } else if (cell.y > y1 && cell.x1 > x0 - height * 4 && cell.x0 < x1 + height * 4) {
        const dist = cell.y - y1;
        if (!above || dist < above.dist) above = { dist, text: cell.text };
      }
    }
  }

  const pick = left ?? above;
  return pick ? pick.text.replace(/[:*\s]+$/, '') : '';
}

/* ------------------------------------------------------------------ *
 * AcroForm fields
 * ------------------------------------------------------------------ */

const TRUE_STATES = new Set(['on', 'yes', 'true', '1', 'x']);

function widgetValue(widgets) {
  const first = widgets[0];
  const raw = first.fieldValue ?? first.defaultFieldValue ?? '';

  if (first.radioButton) {
    // One field, many widgets; the field's value is the selected button value.
    const selected = widgets.find((w) => w.fieldValue && w.fieldValue === w.buttonValue);
    return { value: selected ? selected.buttonValue : String(raw ?? ''), type: 'radio' };
  }
  if (first.checkBox) {
    const state = String(raw ?? '').toLowerCase();
    const on = first.exportValue
      ? String(raw ?? '') === first.exportValue
      : Boolean(state) && state !== 'off' && (TRUE_STATES.has(state) || state !== '');
    return { value: on, type: 'checkbox' };
  }
  if (first.pushButton) return { value: '', type: 'button' };

  if (Array.isArray(raw)) return { value: raw.join(', '), type: first.fieldType === 'Ch' ? 'select' : 'text' };
  return { value: String(raw ?? ''), type: first.fieldType === 'Ch' ? 'select' : 'text' };
}

function optionsOf(annotation) {
  if (!Array.isArray(annotation.options) || !annotation.options.length) return undefined;
  return annotation.options.map((o) => ({
    value: o.exportValue ?? o.displayValue ?? '',
    label: o.displayValue ?? o.exportValue ?? '',
  }));
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

function readDocument(data) {
  const task = pdfjs.getDocument({
    data,
    // MV3 forbids eval, and everything the extension needs is bundled locally.
    isEvalSupported: false,
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  return task.promise;
}

/**
 * @param {ArrayBuffer} buffer Raw PDF bytes. Consumed (detached) by pdf.js.
 * @returns {Promise<Record<string, object>>} the flat extraction object
 */
export async function extractPdf(buffer) {
  // pdf.js transfers the buffer to the worker, detaching it. Keep a spare copy
  // so a worker failure can be retried on the main thread.
  const retryCopy = buffer.slice(0);
  try {
    return await extractWith(buffer, true);
  } catch (err) {
    console.warn('[pdftoformext] worker parse failed, retrying on main thread:', err);
    return extractWith(retryCopy, false);
  }
}

async function extractWith(buffer, useRealWorker) {
  // pdf.js only terminates workers it created itself, so a port handed to it via
  // workerPort is ours to clean up. Leaving it running would keep a parsed copy
  // of the PDF alive in the worker for the life of the page.
  const port = useRealWorker ? makeWorkerPort() : null;
  if (port) pdfjs.GlobalWorkerOptions.workerPort = port;
  else await useFakeWorker();

  const doc = await readDocument(new Uint8Array(buffer));
  try {
    return await collect(doc);
  } finally {
    await doc.destroy();
    port?.terminate();
    pdfjs.GlobalWorkerOptions.workerPort = null;
  }
}

async function collect(doc) {
  const entries = {};
  const pages = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const [textContent, annotations] = await Promise.all([
      page.getTextContent(),
      page.getAnnotations({ intent: 'any' }),
    ]);
    const boxes = toBoxes(textContent);
    const lineHeight = median(boxes.map((b) => b.height)) || 10;
    pages.push({
      pageNum,
      rows: buildRows(boxes, lineHeight),
      lineHeight,
      widgets: annotations.filter((a) => a.subtype === 'Widget'),
    });
    page.cleanup();
  }

  const seenFieldNames = emitFields(entries, pages);
  await emitOrphanFields(entries, doc, seenFieldNames);
  emitTables(entries, pages, { liberal: seenFieldNames.size === 0 });

  return entries;
}

/** Widgets sharing a field name are one field, so group before emitting. */
function emitFields(entries, pages) {
  const groups = new Map();
  for (const page of pages) {
    for (const widget of page.widgets) {
      const name = widget.fieldName || widget.id || '';
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, { name, page, widgets: [] });
      groups.get(name).widgets.push(widget);
    }
  }

  for (const { name, page, widgets } of groups.values()) {
    const primary = widgets[0];
    const { value, type } = widgetValue(widgets);
    if (type === 'button') continue; // push buttons hold nothing to fill with

    put(entries, {
      key: `field.${sanitizeKey(name)}`,
      value,
      source: 'acroform',
      page: page.pageNum,
      label: primary.alternativeText?.trim() || nearestLabel(primary.rect, page.rows),
      rect: primary.rect,
      name,
      type,
      options: optionsOf(primary),
      readOnly: Boolean(primary.readOnly),
    });
  }

  return new Set(groups.keys());
}

/**
 * Fields that exist in the AcroForm dictionary but have no widget on any page
 * (hidden fields, fields on pages pdf.js skipped). Coverage says they still
 * have to appear.
 */
async function emitOrphanFields(entries, doc, seenFieldNames) {
  let fieldObjects = null;
  try {
    fieldObjects = await doc.getFieldObjects();
  } catch {
    return;
  }
  if (!fieldObjects) return;

  for (const [name, objects] of Object.entries(fieldObjects)) {
    if (seenFieldNames.has(name) || !objects?.length) continue;
    const obj = objects[0];
    const raw = obj.value ?? obj.defaultValue ?? '';
    put(entries, {
      key: `field.${sanitizeKey(name)}`,
      value: Array.isArray(raw) ? raw.join(', ') : String(raw ?? ''),
      source: 'acroform',
      page: (obj.page ?? 0) + 1,
      label: '',
      rect: obj.rect ?? null,
      name,
      type: obj.type || 'text',
      readOnly: Boolean(obj.readOnly),
    });
    seenFieldNames.add(name);
  }
}

/**
 * @param {boolean} liberal When the PDF carries no AcroForm at all, every block
 *   of text is emitted as a table so the document is still fully represented.
 */
function emitTables(entries, pages, { liberal }) {
  let tableIndex = 0;

  for (const page of pages) {
    for (const block of splitBlocks(page.rows, page.lineHeight)) {
      const minColumns = liberal ? 1 : 2;
      if (block.length < 2 && !liberal) continue;

      const layout = assignColumns(block, page.lineHeight, { minColumns });
      if (!layout) continue;
      if (!liberal && (layout.columns < 2 || layout.alignment < MIN_ALIGNMENT)) continue;

      const head = detectHeader(layout.grid);
      const index = tableIndex;
      tableIndex += 1;

      layout.grid.forEach((row, rowIdx) => {
        const isDataRow = head ? rowIdx > head.rowIndex : true;
        for (const cell of row) {
          const header = isDataRow ? head?.headers.get(cell.col) : undefined;
          // Fall back to the row's own leading cell, which is what carries the
          // meaning in a two-column "Label: value" layout.
          const label = header || (isDataRow ? row[0]?.text : '') || '';

          const key = put(entries, {
            key: `table.${index}.r${rowIdx}.c${cell.col}`,
            value: cell.text,
            source: 'table',
            page: page.pageNum,
            label: label === cell.text ? '' : label,
            rect: [cell.x0, cell.y, cell.x1, cell.y + cell.height],
            table: index,
            row: rowIdx,
            col: cell.col,
            header: header ?? '',
          });

          // Same cell, second addressable key: table.<i>.<header>.<row>
          if (header) {
            put(entries, { ...entries[key], key: `table.${index}.${sanitizeKey(header)}.${rowIdx}` });
          }
        }
      });
    }
  }
}
