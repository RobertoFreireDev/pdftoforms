/**
 * Classic-script entry point.
 *
 * MV3 `content_scripts` cannot declare `"type": "module"`, so the real content
 * script (overlay.js) is pulled in with a dynamic import of an extension URL.
 * Everything downstream — overlay.js, pdf-extract.js, autofill.js, pdf.js — is
 * a plain ES module served from this extension's own origin.
 */
(() => {
  const FLAG = '__pdftoformextLoaded';
  if (window[FLAG]) return;
  window[FLAG] = true;

  import(chrome.runtime.getURL('src/content/overlay.js')).catch((err) => {
    console.error('[pdftoformext] failed to load overlay:', err);
  });
})();
