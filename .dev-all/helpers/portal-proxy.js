#!/usr/bin/env node
const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID, createHmac } = require('node:crypto');
const targetBase = process.env.PORTAL_PROXY_TARGET ?? 'http://127.0.0.1:3001';
const port = Number(process.env.PORTAL_PROXY_PORT ?? 4000);
const practiceId = process.env.PORTAL_PROXY_PRACTICE ?? 'demo';
const patientId = process.env.PORTAL_PROXY_PATIENT ?? 'patient-123';
const scope = process.env.PORTAL_PROXY_SCOPE ?? 'submit triage:submit booking:read';
const secret = process.env.SECURITY_SHARED_SECRET ?? 'dev-shared-secret';
const toB64Url = (b) => b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const sign = (s) => toB64Url(createHmac('sha256', secret).update(s).digest());
const read = (req) => new Promise((r,j)=>{const c=[];req.on('data',x=>c.push(Buffer.from(x)));req.on('end',()=>r(Buffer.concat(c).toString('utf8')));req.on('error',j);});
const srv = http.createServer(async (req,res)=>{
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'GET,POST,OPTIONS'});res.end();return;}
  const cors={'access-control-allow-origin':'*','cache-control':'no-store'};
  if (req.method==='POST' && url.pathname==='/safety-check'){
    const raw=await read(req); const body=raw; const requestId=randomUUID(); const corr=randomUUID();
    const idem = randomUUID(); const sig=sign(`${requestId}:${idem}`);
    const headers={authorization:`Bearer ${sig}`,'content-type':'application/json','x-actor-type':'patient','x-actor-id':patientId,'x-auth-scope':scope,'x-request-id':requestId,'x-correlation-id':corr,'x-idempotency-key':idem,'x-practice-id':practiceId};
    const upstream = await fetch(`${targetBase}/safety-check`,{method:'POST',headers,body});
    const text = await upstream.text();
    res.writeHead(upstream.status,{...cors,'content-type':upstream.headers.get('content-type')||'application/json','x-correlation-id':upstream.headers.get('x-correlation-id')||corr});
    res.end(text); return;
  }
  if (req.method==='GET' && url.pathname==='/booking/slots'){
    const requestId=randomUUID(); const corr=randomUUID(); const sig=sign(`${requestId}:booking:slots`);
    const upstreamUrl=new URL('/booking/slots',targetBase); upstreamUrl.search=url.searchParams.toString();
    const headers={authorization:`Bearer ${sig}`,'accept':'application/json','x-request-id':requestId,'x-correlation-id':corr,'x-actor-type':'patient','x-actor-id':patientId,'x-auth-scope':scope,'x-patient-id':url.searchParams.get('patientId')||patientId,'x-practice-id':practiceId};
    const upstream=await fetch(upstreamUrl,{method:'GET',headers}); const text=await upstream.text();
    res.writeHead(upstream.status,{...cors,'content-type':upstream.headers.get('content-type')||'application/json','x-correlation-id':upstream.headers.get('x-correlation-id')||corr});
    res.end(text); return;
  }
  if (req.method==='POST' && url.pathname==='/booking/appointments'){
    const corr=randomUUID();
    res.writeHead(200,{...cors,'content-type':'application/json','x-correlation-id':corr});
    res.end(JSON.stringify({appointmentId:`appt-${Date.now()}`,slotId:'slot-demo-001',start:new Date().toISOString(),end:new Date(Date.now()+15*60*1000).toISOString(),correlationId:corr}));
    return;
  }
  res.writeHead(404,{...cors,'content-type':'application/json'}); res.end(JSON.stringify({error:'not_found'}));
});
srv.listen(port,()=>console.log(`[portal-proxy] listening on http://127.0.0.1:${port} -> ${targetBase}`));
