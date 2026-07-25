/**
 * Writes example/test-form.pdf — the fixture the manual harness fills from.
 *
 * Run with `node example/make-test-pdf.mjs`. This is a one-off authoring tool,
 * not part of the extension: the extension itself has no build step and no
 * dependencies, and this script has none either.
 *
 * The PDF carries both things the extractor has to handle: an AcroForm (text,
 * checkbox, radio and choice fields, each with visible label text beside it)
 * and a plain drawn table with aligned columns and a header row.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Field fixtures. Names are deliberately unlike the HTML input names in
 * test-form.html so the fuzzy matcher actually has work to do.
 * ------------------------------------------------------------------ */

const TEXT_FIELDS = [
  { name: 'applicant_name', alt: 'Applicant Name', label: 'Applicant name', value: 'Ana Ferreira Lima' },
  { name: 'email_address', alt: 'Email Address', label: 'Email address', value: 'ana.lima@example.com' },
  { name: 'phone_number', alt: 'Phone Number', label: 'Phone number', value: '+55 21 98765-4321' },
  { name: 'date_of_birth', alt: 'Date of Birth', label: 'Date of birth', value: '14/03/1988' },
  { name: 'annual_income', alt: 'Annual Income', label: 'Annual income', value: '87500.00' },
  { name: 'postal_code', alt: 'Postal Code', label: 'Postal code', value: '22450-050' },
  { name: 'additional_notes', alt: 'Additional Notes', label: 'Additional notes', value: 'Prefers contact after 6pm.' },
  { name: 'empty_reference', alt: 'Reference Number', label: 'Reference number', value: '' },
];

const CHOICE_FIELD = {
  name: 'country_of_residence',
  alt: 'Country of Residence',
  label: 'Country of residence',
  value: 'Brazil',
  options: ['Brazil', 'Canada', 'Portugal', 'United States'],
};

const CHECKBOX_FIELD = {
  name: 'newsletter_opt_in',
  alt: 'Newsletter Opt In',
  label: 'Subscribe to newsletter',
  on: 'Yes',
  checked: true,
};

const RADIO_FIELD = {
  name: 'contact_preference',
  alt: 'Contact Preference',
  label: 'Preferred contact',
  value: 'Email',
  options: ['Email', 'Phone'],
};

/**
 * A two-column "label   value" list — the shape most non-AcroForm PDFs use to
 * present form data. There is no header row here; each value's label is the
 * cell to its left.
 */
const DETAILS = {
  title: 'Policy details',
  rows: [
    ['Policy number', 'POL-99823'],
    // Day > 12, so the date is unambiguous whatever the reader's locale.
    ['Issue date', '23/09/2023'],
    ['Coverage tier', 'Gold'],
  ],
  columns: [72, 250],
};

const TABLE = {
  title: 'Order summary',
  header: ['Item', 'Quantity', 'Unit Price', 'Total'],
  rows: [
    ['Widget A', '2', '19.90', '39.80'],
    ['Widget B', '1', '5.00', '5.00'],
    ['Service fee', '1', '12.50', '12.50'],
  ],
  columns: [72, 250, 350, 450],
};

/* ------------------------------------------------------------------ *
 * Minimal PDF writer
 * ------------------------------------------------------------------ */

/** Escapes a string for a PDF literal `(...)`. */
function lit(text) {
  return `(${String(text).replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

class Pdf {
  constructor() {
    /** @type {(string|null)[]} 1-indexed; null marks a reserved-but-unwritten slot. */
    this.objects = [null];
  }

  /** Reserves an object number so it can be referenced before it is written. */
  reserve() {
    this.objects.push(null);
    return this.objects.length - 1;
  }

  set(id, body) {
    this.objects[id] = body;
    return id;
  }

  add(body) {
    return this.set(this.reserve(), body);
  }

  stream(dict, content) {
    const bytes = Buffer.byteLength(content, 'latin1');
    return this.add(`<< ${dict} /Length ${bytes} >>\nstream\n${content}\nendstream`);
  }

  build(rootId) {
    const chunks = ['%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'];
    const offsets = [0];
    let position = Buffer.byteLength(chunks[0], 'latin1');

    for (let id = 1; id < this.objects.length; id += 1) {
      const body = this.objects[id];
      if (body === null) throw new Error(`object ${id} was reserved but never written`);
      const text = `${id} 0 obj\n${body}\nendobj\n`;
      offsets[id] = position;
      chunks.push(text);
      position += Buffer.byteLength(text, 'latin1');
    }

    const count = this.objects.length;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let id = 1; id < count; id += 1) {
      xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${count} /Root ${rootId} 0 R >>\nstartxref\n${position}\n%%EOF\n`;
    chunks.push(xref);

    return Buffer.from(chunks.join(''), 'latin1');
  }
}

/* ------------------------------------------------------------------ *
 * Document assembly
 * ------------------------------------------------------------------ */

const pdf = new Pdf();

const catalogId = pdf.reserve();
const pagesId = pdf.reserve();
const pageId = pdf.reserve();
const fontId = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const boldId = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

/** Empty and ticked appearance streams, shared by the checkbox and the radios. */
const apOff = pdf.stream('/Type /XObject /Subtype /Form /BBox [0 0 12 12] /Resources << >>', '');
const apOn = pdf.stream(
  '/Type /XObject /Subtype /Form /BBox [0 0 12 12] /Resources << >>',
  '0 g\n2 w\n2 2 m 10 10 l S\n10 2 m 2 10 l S',
);

const content = [];
const annots = [];
let cursorY = 720;

function drawText(x, y, text, { size = 11, font = 'F1' } = {}) {
  content.push(`BT /${font} ${size} Tf ${x} ${y} Td ${lit(text)} Tj ET`);
}

/** Draws the label, then registers a widget to its right on the same line. */
function addWidget(label, dict, { width = 220, height = 18 } = {}) {
  const y = cursorY;
  drawText(72, y + 5, `${label}:`);
  const rect = [250, y, 250 + width, y + height];
  const id = pdf.add(
    `<< /Type /Annot /Subtype /Widget /F 4 /P ${pageId} 0 R `
    + `/Rect [${rect.join(' ')}] /DA (/Helv 10 Tf 0 g) ${dict} >>`,
  );
  annots.push(id);
  cursorY -= 28;
  return id;
}

drawText(72, 760, 'Membership Application', { size: 16, font: 'F2' });

for (const field of TEXT_FIELDS) {
  addWidget(field.label, `/FT /Tx /T ${lit(field.name)} /TU ${lit(field.alt)} /V ${lit(field.value)}`);
}

addWidget(
  CHOICE_FIELD.label,
  `/FT /Ch /Ff 131072 /T ${lit(CHOICE_FIELD.name)} /TU ${lit(CHOICE_FIELD.alt)} `
  + `/V ${lit(CHOICE_FIELD.value)} /Opt [${CHOICE_FIELD.options.map(lit).join(' ')}]`,
);

addWidget(
  CHECKBOX_FIELD.label,
  `/FT /Btn /T ${lit(CHECKBOX_FIELD.name)} /TU ${lit(CHECKBOX_FIELD.alt)} `
  + `/V /${CHECKBOX_FIELD.on} /AS /${CHECKBOX_FIELD.on} `
  + `/AP << /N << /${CHECKBOX_FIELD.on} ${apOn} 0 R /Off ${apOff} 0 R >> >>`,
  { width: 14, height: 14 },
);

/* A radio field is one field object with a kid widget per option. */
const radioFieldId = pdf.reserve();
const radioKids = RADIO_FIELD.options.map((option, index) => {
  const on = option === RADIO_FIELD.value;
  const x = 250 + index * 110;
  drawText(x + 20, cursorY + 3, option);
  return pdf.add(
    `<< /Type /Annot /Subtype /Widget /F 4 /P ${pageId} 0 R /Parent ${radioFieldId} 0 R `
    + `/Rect [${x} ${cursorY} ${x + 14} ${cursorY + 14}] /AS /${on ? option : 'Off'} `
    + `/AP << /N << /${option} ${apOn} 0 R /Off ${apOff} 0 R >> >> >>`,
  );
});
drawText(72, cursorY + 3, `${RADIO_FIELD.label}:`);
pdf.set(
  radioFieldId,
  `<< /FT /Btn /Ff 32768 /T ${lit(RADIO_FIELD.name)} /TU ${lit(RADIO_FIELD.alt)} `
  + `/V /${RADIO_FIELD.value} /Kids [${radioKids.map((id) => `${id} 0 R`).join(' ')}] >>`,
);
annots.push(...radioKids);
cursorY -= 44;

/* Both blocks below are drawn text only — no field objects — so the geometric
 * row/column clustering is what has to find them. The gap between blocks is
 * wide enough that they are not run together into one table. */
drawText(72, cursorY, DETAILS.title, { size: 13, font: 'F2' });
cursorY -= 22;
for (const row of DETAILS.rows) {
  row.forEach((cell, i) => drawText(DETAILS.columns[i], cursorY, cell));
  cursorY -= 18;
}
cursorY -= 40;

drawText(72, cursorY, TABLE.title, { size: 13, font: 'F2' });
cursorY -= 22;
TABLE.header.forEach((cell, i) => drawText(TABLE.columns[i], cursorY, cell, { font: 'F2' }));
cursorY -= 18;
for (const row of TABLE.rows) {
  row.forEach((cell, i) => drawText(TABLE.columns[i], cursorY, cell));
  cursorY -= 18;
}

const contentId = pdf.stream('', content.join('\n'));

pdf.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] `
  + `/Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> `
  + `/Contents ${contentId} 0 R /Annots [${annots.map((id) => `${id} 0 R`).join(' ')}] >>`);

pdf.set(pagesId, `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);

/* Radio kids are reached through their parent field, not listed directly. */
const acroFields = annots
  .filter((id) => !radioKids.includes(id))
  .concat(radioFieldId)
  .map((id) => `${id} 0 R`)
  .join(' ');

pdf.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /AcroForm << /Fields [${acroFields}] `
  + `/DA (/Helv 10 Tf 0 g) /DR << /Font << /Helv ${fontId} 0 R >> >> /NeedAppearances true >> >>`);

const out = join(HERE, 'test-form.pdf');
writeFileSync(out, pdf.build(catalogId));
console.log(`wrote ${out}`);
