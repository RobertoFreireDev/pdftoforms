/**
 * The script editor and the evaluator, both inside the sandboxed frame.
 *
 * Traffic with the overlay runs over a MessagePort, not `parent.postMessage`.
 * The frame is inserted into the *host page's* DOM, so its `window.parent` is a
 * window the page shares with the content script: anything posted there is
 * readable by the page, and PDF contents travel this wire. Only the `pfx-ready`
 * announcement — which carries nothing — goes over the window; the overlay
 * answers by transferring a port into this frame, which the page cannot reach,
 * and everything after that is private.
 */

/* eslint-env browser */
/* global ace */

const DEFAULT_SCRIPT = `// \`pdf\` is the extraction object: a flat map of key -> entry.
//
//   entry = { key, value, source: 'acroform' | 'table', page, label, rect }
//   table cells also carry { table, row, col, header }
//
// It is restored from a pristine copy of the PDF before every run, so edits
// never stack up — change the code and press Run again.
//
// Read a field
//   console.log(pdf['field.applicant_name'].value);
//
// Change a field
//   pdf['field.applicant_name'].value = 'Jane Doe';
//
// Read a table cell by position: table.<i>.r<row>.c<col>
//   console.log(pdf['table.1.r3.c3'].value);
//
// Strip the currency sign from every cell of table 1
//   for (const e of Object.values(pdf)) {
//     if (e.source === 'table' && e.table === 1) e.value = e.value.replace('$', '');
//   }
//
// Add a derived key. entry.key must equal its key in the map, or the picker and
// Fill page will disagree about what a mapping row points at.
//   pdf['field.full_name'] = {
//     key: 'field.full_name',
//     value: pdf['field.first'].value + ' ' + pdf['field.last'].value,
//     source: 'acroform', page: 1, label: 'Full name', rect: null,
//   };
//
// Delete a key
//   delete pdf['field.internal_ref'];
//
// await works here, and the whole PDF is yours: Object.entries, filter, map.
`;

/** A runaway loop can log forever; keep the reply postable. */
const MAX_LOGS = 500;
const MAX_LINE = 2000;
const MAX_ITEMS = 20;
const MAX_DEPTH = 2;

/* ------------------------------------------------------------------ *
 * Editor
 * ------------------------------------------------------------------ */

const editor = ace.edit('editor');
editor.session.setMode('ace/mode/javascript');
// No worker: it would need its own URL under an opaque origin, and syntax errors
// already surface in the overlay's console the moment Run is pressed.
editor.session.setUseWorker(false);
editor.setOptions({
  fontSize: '12px',
  tabSize: 2,
  useSoftTabs: true,
  showPrintMargin: false,
  highlightActiveLine: false,
  scrollPastEnd: 0.25,
});

const dark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => editor.setTheme(dark.matches ? 'ace/theme/tomorrow_night' : 'ace/theme/textmate');
applyTheme();
dark.addEventListener('change', applyTheme);

/* ------------------------------------------------------------------ *
 * Console capture
 * ------------------------------------------------------------------ */

/** Renders one console argument without ever throwing, looping or running long. */
function format(value, depth, seen) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const type = typeof value;
  if (type === 'string') return depth === 0 ? value : JSON.stringify(value);
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
  if (type === 'symbol') return value.toString();
  if (type === 'function') return `[Function${value.name ? ` ${value.name}` : ''}]`;

  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (seen.has(value)) return '[Circular]';
  if (depth > MAX_DEPTH) return Array.isArray(value) ? '[Array]' : '[Object]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const shown = value.slice(0, MAX_ITEMS).map((item) => format(item, depth + 1, seen));
      if (value.length > MAX_ITEMS) shown.push(`…${value.length - MAX_ITEMS} more`);
      return `[${shown.join(', ')}]`;
    }

    const keys = Object.keys(value);
    const shown = keys.slice(0, MAX_ITEMS).map((k) => `${k}: ${format(value[k], depth + 1, seen)}`);
    if (keys.length > MAX_ITEMS) shown.push(`…${keys.length - MAX_ITEMS} more`);
    return `{${shown.join(', ')}}`;
  } catch {
    return '[unprintable]';
  } finally {
    seen.delete(value);
  }
}

function line(args) {
  const text = args.map((arg) => format(arg, 0, new Set())).join(' ');
  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text;
}

/** The `console` the user's script sees. Nothing reaches the real one. */
function captureConsole(logs) {
  const push = (level) => (...args) => {
    if (logs.length > MAX_LOGS) return;
    if (logs.length === MAX_LOGS) logs.push({ level: 'warn', text: `…stopped after ${MAX_LOGS} lines.` });
    else logs.push({ level, text: line(args) });
  };

  return { log: push('log'), info: push('log'), debug: push('log'), warn: push('warn'), error: push('error') };
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function run(message) {
  const logs = [];
  const started = performance.now();

  try {
    // AsyncFunction rather than Function so `await` works in a user script.
    const fn = new AsyncFunction('pdf', 'console', editor.getValue());
    // `message.pdf` is already the structured-clone copy the browser made on the
    // way in, so mutating it in place and posting it back is the whole data path.
    await fn(message.pdf, captureConsole(logs));
    return { type: 'pfx-result', id: message.id, pdf: message.pdf, logs, ms: Math.round(performance.now() - started) };
  } catch (err) {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { type: 'pfx-result', id: message.id, pdf: null, logs, error: text, ms: Math.round(performance.now() - started) };
  }
}

/* ------------------------------------------------------------------ *
 * Protocol
 * ------------------------------------------------------------------ */

let port = null;
let changeTimer = 0;
/** Text we were handed is not text the user wrote; it must not read as an edit. */
let seeding = false;

/**
 * The reply crosses a structured clone, so a script that stashed a function, a
 * symbol or a DOM node in an entry makes it unpostable. Say that, rather than
 * throwing into a promise nobody is watching and leaving the overlay to time out.
 */
function reply(result) {
  try {
    port?.postMessage(result);
  } catch (err) {
    port?.postMessage({
      type: 'pfx-result',
      id: result.id,
      pdf: null,
      logs: result.logs,
      error: `Could not hand the result back: ${err.message}. Values have to be plain data — no functions, symbols or DOM nodes.`,
      ms: result.ms,
    });
  }
}

function onParentMessage(event) {
  const message = event.data;

  switch (message?.type) {
    case 'pfx-init':
      seeding = true;
      editor.setValue(message.code ?? DEFAULT_SCRIPT, -1);
      seeding = false;
      editor.session.getUndoManager().reset();
      editor.resize(true);
      break;

    case 'pfx-resize':
      editor.resize(true);
      break;

    case 'pfx-run':
      run(message).then(reply);
      break;

    default:
      break;
  }
}

// Debounced: the overlay only needs this to decide whether Save has work to do
// and to hold the text across a frame reset, not to track every keystroke.
editor.on('change', () => {
  if (seeding) return;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => port?.postMessage({ type: 'pfx-change', code: editor.getValue() }), 250);
});

// The host page could race us with a port of its own; it would only cut itself
// off from the overlay's runs, never see them, so first port wins is enough.
addEventListener('message', (event) => {
  if (port || event.source !== parent || event.data?.type !== 'pfx-port') return;
  port = event.ports[0];
  port.onmessage = onParentMessage;
});

parent.postMessage({ type: 'pfx-ready' }, '*');
