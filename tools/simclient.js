#!/usr/bin/env node
'use strict';
// Test client: N fake phones running the real public/sched.js against a real host, with
// optional injected (in-order, TCP-like) network jitter. Reports how consistently and how
// simultaneously beats are displayed.
//
//   node tools/simclient.js [--url ws://localhost:8080/ws] [--clients 4] [--seconds 20] [--jitter 150]
//
// Start the host (any --speed; note --lead is scaled by nothing, so keep it as is), press
// Enter there, then run this.  --jitter 150 makes ~10% of messages arrive up to 150 ms late
// (each delaying the ones behind it, like TCP).

const WebSocket = require('ws');
const { createScheduler } = require('../public/sched.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const URL = arg('url', 'ws://localhost:8080/ws');
const CLIENTS = Number(arg('clients', 4));
const SECONDS = Number(arg('seconds', 20));
const JITTER = Number(arg('jitter', 0));

const now = () => Number(process.hrtime.bigint()) / 1e6;
const shown = Array.from({ length: CLIENTS }, () => new Map()); // at -> local show time
const late = new Array(CLIENTS).fill(0), total = new Array(CLIENTS).fill(0);
let open = 0;

for (let c = 0; c < CLIENTS; c++) {
  const sched = createScheduler({
    now, setTimeout, clearTimeout,
    show: m => { if (m.at !== undefined) shown[c].set(m.at, now()); },
  });
  const ws = new WebSocket(URL);
  let lastDeliver = 0;
  const deliver = m => {
    if (typeof m.h === 'number') sched.observe(m.h);
    if (m.hb) return;
    if (m.cut !== undefined) sched.cut(m.cut);
    else if (m.at !== undefined) sched.enqueue(m);
  };
  ws.on('open', () => { open++; if (open === CLIENTS) console.log(`${CLIENTS} clients connected${JITTER ? `, injecting up to ${JITTER} ms jitter` : ''}; waiting for beats…`); });
  ws.on('message', d => {
    const m = JSON.parse(d);
    const delay = JITTER && Math.random() < 0.1 ? Math.random() * JITTER : 0;
    lastDeliver = Math.max(lastDeliver, now() + delay);
    setTimeout(() => deliver(m), Math.max(0, lastDeliver - now()));
  });
  ws.on('error', e => { console.error('connect error:', e.message); process.exit(1); });
  setTimeout(() => { const st = sched.stats(); late[c] = st.late; total[c] = st.n; }, SECONDS * 1000 - 50);
}

setTimeout(() => {
  console.log('');
  const stat = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return { mean: m, sd: Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length), pp: Math.max(...a) - Math.min(...a) }; };
  for (let c = 0; c < CLIENTS; c++) {
    const rel = [...shown[c].entries()].map(([at, t]) => t - at); // constant + error
    if (!rel.length) { console.log(`client ${c}: no beats shown`); continue; }
    const s = stat(rel);
    console.log(`client ${c}: ${rel.length} beats shown, late arrivals ${late[c]}/${total[c]}; display timing vs schedule: std dev ${s.sd.toFixed(2)} ms, peak-to-peak ${s.pp.toFixed(2)} ms`);
  }
  let worst = 0, sum = 0, n = 0;
  for (const at of shown[0].keys()) {
    const ts = shown.map(m => m.get(at)).filter(x => x !== undefined);
    if (ts.length < CLIENTS) continue;
    const spread = Math.max(...ts) - Math.min(...ts);
    worst = Math.max(worst, spread); sum += spread; n++;
  }
  console.log(`spread between ${CLIENTS} clients showing the same beat: mean ${(sum / (n || 1)).toFixed(2)} ms  max ${worst.toFixed(2)} ms  (${n} beats)`);
  process.exit(0);
}, SECONDS * 1000);
