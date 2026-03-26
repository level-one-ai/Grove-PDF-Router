/**
 * Naming Engine
 * Determines final PDF filename from Claude JSON output.
 *
 * Rules:
 * 1. Detect supplier from document.header.title
 *    - Contains "Grove Bedding" → suffix = document.header.etd
 *    - Contains "Loren Williams" → suffix = document.header.inv_no
 *
 * 2. Determine name field:
 *    - document.customer.company_name (not null) → use company_name
 *    - document.customer.company_name is null    → use document.customer.name
 *
 * 3. Final filename: {name}-{suffix}_{zeroPaddedPage}.pdf
 */

const SUPPLIERS = [
  {
    match: 'grove bedding',
    label: 'Grove Bedding',
    getSuffix: (doc) => doc?.header?.etd || 'unknown-etd',
  },
  {
    match: 'loren williams',
    label: 'Loren Williams',
    getSuffix: (doc) => doc?.header?.inv_no || 'unknown-inv',
  },
];

function detectSupplier(document) {
  const title = (document?.header?.title || '').toLowerCase().trim();
  for (const supplier of SUPPLIERS) {
    if (title.includes(supplier.match)) {
      return supplier;
    }
  }
  return null;
}

function getNameField(document) {
  const companyName = document?.customer?.company_name;
  if (companyName && companyName.trim() !== '') {
    return companyName.trim();
  }
  return (document?.customer?.name || 'unknown-customer').trim();
}

function sanitiseForFilename(str) {
  // Remove characters that are invalid in filenames
  return str.replace(/[/\\:*?"<>|]/g, '-').trim();
}

function buildFilename(claudeJson, zeroPaddedPage) {
  const document = claudeJson?.document;
  if (!document) {
    return `unknown-document_${zeroPaddedPage}.pdf`;
  }

  const supplier = detectSupplier(document);
  const nameField = getNameField(document);
  const suffix = supplier ? supplier.getSuffix(document) : 'unknown-type';

  const safeName = sanitiseForFilename(nameField);
  const safeSuffix = sanitiseForFilename(suffix);

  return `${safeName}-${safeSuffix}_${zeroPaddedPage}.pdf`;
}

function getSupplierLabel(claudeJson) {
  const supplier = detectSupplier(claudeJson?.document);
  return supplier ? supplier.label : 'Unknown';
}

function getCustomerFolderName(claudeJson) {
  const document = claudeJson?.document;
  const companyName = document?.customer?.company_name;
  if (companyName && companyName.trim() !== '') {
    return companyName.trim();
  }
  return (document?.customer?.name || 'unknown-customer').trim();
}

function getRefFolder(claudeJson) {
  return (claudeJson?.document?.header?.ref || 'unknown-ref').trim();
}

module.exports = {
  buildFilename,
  getSupplierLabel,
  getCustomerFolderName,
  getRefFolder,
  detectSupplier,
  getNameField,
};
