// A deliberately flaky CRM: the first request gets a 503, later ones work and report how many calls it took.
const http = require('http');
let calls = 0;
http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    calls += 1;
    res.setHeader('content-type', 'application/json');
    if (calls === 1) { res.statusCode = 503; return res.end('{"error":"CRM unavailable (deliberate first-call failure)"}'); }
    res.end(JSON.stringify({ok: true, attempt: calls}));
  });
}).listen(3000, '0.0.0.0');
