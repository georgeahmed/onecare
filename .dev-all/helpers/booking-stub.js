#!/usr/bin/env node
const http = require('node:http');
const port = Number(process.env.BOOKING_STUB_PORT ?? 4002);
const slots = [
  { id: 'slot-demo-001', start: '2025-07-01T09:00:00Z', end: '2025-07-01T09:15:00Z', modality: 'in_person', location: 'Demo Clinic - Room 101' },
  { id: 'slot-demo-002', start: '2025-07-01T09:30:00Z', end: '2025-07-01T09:45:00Z', modality: 'phone',     location: 'Virtual Visit' },
  { id: 'slot-demo-003', start: '2025-07-01T10:00:00Z', end: '2025-07-01T10:15:00Z', modality: 'in_person', location: 'Demo Clinic - Room 102' }
];
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url || '').startsWith('/slots')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ slots }));
    return;
  }
  if (req.method === 'GET' && (req.url || '').startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', source: 'booking-stub', ready: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});
server.listen(port, () => console.log(`[booking-stub] listening on http://127.0.0.1:${port}`));
