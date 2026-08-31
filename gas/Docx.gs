/**
 * Docx.gs — read a Word .docx into plain text, server-side in Apps Script.
 *
 * A .docx is a zip; Utilities.unzip (a core service, no extra OAuth scope) gives
 * us its entries, and word/document.xml holds the body. We convert that XML to
 * text — paragraphs -> newlines, tabs preserved, tags stripped, entities
 * unescaped. Called from the uploader when the AIS report is a Word file.
 */

/**
 * @param {string} base64  the .docx file bytes, base64-encoded (from the browser)
 * @param {string} name    original filename (for error messages)
 * @return {string} extracted plain text
 */
function docxToText(base64, name) {
  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, 'application/zip', (name || 'ais') + '.zip');
  var entries;
  try {
    entries = Utilities.unzip(blob);
  } catch (e) {
    throw new Error('Could not read the file as a .docx (is it a real Word file?)');
  }
  var xml = '';
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].getName() === 'word/document.xml') {
      xml = entries[i].getDataAsString('UTF-8');
      break;
    }
  }
  if (!xml) throw new Error('No word/document.xml inside "' + (name || 'file') + '" — not a .docx.');
  return docxXmlToText_(xml);
}

/** Convert WordprocessingML body XML into readable plain text. */
function docxXmlToText_(xml) {
  var s = String(xml);
  // Structure -> whitespace before stripping tags.
  s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t');
  s = s.replace(/<w:br\b[^>]*\/?>/g, '\n');
  s = s.replace(/<\/w:p>/g, '\n');          // end of paragraph -> newline
  s = s.replace(/<[^>]+>/g, '');            // drop all remaining tags
  // Unescape XML entities.
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
       .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
       .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
       .replace(/&amp;/g, '&');             // last, so "&amp;lt;" isn't double-decoded
  // Tidy: trim trailing spaces per line, collapse 3+ blank lines to 1.
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// Export for the Node test harness (ignored by Apps Script).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { docxXmlToText_: docxXmlToText_ };
}
