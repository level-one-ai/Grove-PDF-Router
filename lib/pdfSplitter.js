const { PDFDocument } = require('pdf-lib');

/**
 * Splits a multi-page PDF buffer into an array of single-page PDF buffers.
 * Returns: [{ pageNumber: 1, buffer: Buffer, zeroPadded: '01' }, ...]
 */
async function splitPdf(pdfBuffer) {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const totalPages = srcDoc.getPageCount();
  const pages = [];

  const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;

  for (let i = 0; i < totalPages; i++) {
    const newDoc = await PDFDocument.create();
    const [copiedPage] = await newDoc.copyPages(srcDoc, [i]);
    newDoc.addPage(copiedPage);

    const pageBytes = await newDoc.save();
    const pageBuffer = Buffer.from(pageBytes);

    const pageNumber = i + 1;
    const zeroPadded = String(pageNumber).padStart(padWidth, '0');

    pages.push({
      pageNumber,
      zeroPadded,
      buffer: pageBuffer,
    });
  }

  return { pages, totalPages };
}

module.exports = { splitPdf };
