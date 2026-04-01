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
    // Use ETD if present, fall back to inv_no, then ref
    getSuffix: (doc) => doc?.header?.etd || doc?.header?.inv_no || doc?.header?.ref || 'no-date',
  },
  {
    match: 'loren williams',
    label: 'Loren Williams',
    // Use inv_no if present, fall back to ref, then etd
    getSuffix: (doc) => doc?.header?.inv_no || doc?.header?.ref || doc?.header?.etd || 'no-inv',
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

/**
 * Returns the base filename WITHOUT the .pdf extension.
 * Used by googleDrive.js to check for existing files
 * before applying the -{number} suffix.
 * e.g. "Acme Ltd-2026-03-26_01"
 */
function buildBaseFilename(claudeJson, zeroPaddedPage) {
  return buildFilename(claudeJson, zeroPaddedPage).replace(/\.pdf$/i, '');
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

/**
 * Returns true if the folder name comes from company_name (not customer.name).
 * Used to determine which search strategy to use in Google Drive.
 */
function isCompanyName(claudeJson) {
  const companyName = claudeJson?.document?.customer?.company_name;
  return !!(companyName && companyName.trim() !== '');
}

module.exports = {
  buildFilename,
  buildBaseFilename,
  getSupplierLabel,
  getCustomerFolderName,
  getRefFolder,
  isCompanyName,
  detectSupplier,
  getNameField,
};
