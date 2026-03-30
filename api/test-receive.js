/**
 * /api/test-receive
 * Zero dependencies — just logs what it receives and responds.
 * Use this to confirm Make.com can reach Vercel at all.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const body = req.body || {};
  const received = {
    ok: true,
    method: req.method,
    timestamp: new Date().toISOString(),
    bodyKeys: Object.keys(body),
    fileId: body.fileId || null,
    pageNumber: body.pageNumber || null,
    title: body.title || null,
    hasSecret: !!body.secret,
  };

  console.log('[test-receive] Called:', JSON.stringify(received));
  return res.status(200).json(received);
};
