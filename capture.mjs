import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

mkdirSync('captures', { recursive: true });
let n = 0;

createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let buf = Buffer.concat(chunks);
    const enc = req.headers['content-encoding'];
    if (enc === 'gzip') buf = gunzipSync(buf);
    let out = buf.toString('utf8');
    try { out = JSON.stringify(JSON.parse(out), null, 2); } catch {}
    const file = `captures/${String(++n).padStart(3, '0')}.json`;
    writeFileSync(file, out);
    console.log(`${req.url}  auth=${!!req.headers.authorization}  enc=${enc ?? 'none'}  ${buf.length}B -> ${file}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"partialSuccess":{}}');
  });
}).listen(4318, () => console.log('listening on 4318 -> ./captures'));