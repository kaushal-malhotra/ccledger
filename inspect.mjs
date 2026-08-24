// inspect.mjs
import { readdirSync, readFileSync } from 'node:fs';
const seen = {};
for (const f of readdirSync('captures')) {
  const p = JSON.parse(readFileSync(`captures/${f}`, 'utf8'));
  for (const rl of p.resourceLogs ?? []) {
    const res = (rl.resource?.attributes ?? []).map(a => a.key);
    for (const sl of rl.scopeLogs ?? [])
      for (const r of sl.logRecords ?? []) {
        const attrs = r.attributes ?? [];
        const name = attrs.find(a => a.key === 'event.name')?.value?.stringValue ?? '?';
        seen[name] ??= { count: 0, record: new Set(), resource: new Set() };
        seen[name].count++;
        attrs.forEach(a => seen[name].record.add(a.key));
        res.forEach(k => seen[name].resource.add(k));
      }
  }
}
for (const [name, v] of Object.entries(seen))
  console.log(`\n${name}  x${v.count}\n  record:   ${[...v.record].sort().join(', ')}\n  resource: ${[...v.resource].sort().join(', ')}`);