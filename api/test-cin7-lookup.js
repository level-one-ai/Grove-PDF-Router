/**
 * /api/test-cin7-lookup
 *
 * Diagnostic endpoint that runs the Cin7 lookup inside Vercel's environment
 * (where CIN7 credentials are accessible). Returns the result as JSON.
 *
 * Protected by CALLBACK_SECRET so randoms can't probe your Cin7 data.
 *
 * Usage:
 *   GET /api/test-cin7-lookup?name=Anne%20Lovett&secret=abc123xyz
 *   GET /api/test-cin7-lookup?name=Audrey%20Allan&ref=AALL20114-1&secret=abc123xyz
 */

const { lookupCin7FolderName } = require('../lib/cin7');

module.exports = async function handler(req, res) {
  // Auth check
  const providedSecret = req.query.secret || req.headers['x-callback-secret'];
  const expectedSecret = process.env.CALLBACK_SECRET || 'abc123xyz';
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized — provide ?secret=...' });
  }

  const fullName = req.query.name;
  const expectedRef = req.query.ref || null;

  if (!fullName) {
    return res.status(400).json({
      error: 'Missing name parameter',
      usage: '/api/test-cin7-lookup?name=Anne%20Lovett&secret=abc123xyz',
    });
  }

  // Sanity check that credentials exist
  const hasUsername = !!process.env.CIN7_API_USERNAME;
  const hasKey = !!process.env.CIN7_API_KEY;
  if (!hasUsername || !hasKey) {
    return res.status(500).json({
      error: 'Cin7 credentials missing in this environment',
      hasUsername,
      hasKey,
    });
  }

  // Capture console.log output so we can return it in the response
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => { logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); origLog.apply(console, args); };
  console.warn = (...args) => { logs.push('[warn] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); origWarn.apply(console, args); };

  try {
    const result = await lookupCin7FolderName({
      customerName: fullName,
      companyName: null,
      pdfRef: expectedRef,
      pdfPostcode: null,
      pdfMobile: null,
      fileId: null,        // bypass cache
      pageNumber: null,    // bypass cache
    });

    console.log = origLog;
    console.warn = origWarn;

    return res.status(200).json({
      query: { name: fullName, expectedRef },
      cin7Credentials: { hasUsername, hasKey },
      result,
      logs,
    });
  } catch (err) {
    console.log = origLog;
    console.warn = origWarn;
    return res.status(500).json({
      error: err.message,
      stack: err.stack,
      logs,
    });
  }
};
