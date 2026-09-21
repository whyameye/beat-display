#!/usr/bin/env node
'use strict';
// Simulates host -> phone over a jittery, in-order (TCP-like) link and checks that the
// client scheduler shows every beat at the right host time despite the jitter.
//   node tools/test-sched.js

const { createScheduler } = require('../public/sched.js');

// deterministic RNG
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

function run({ lead = 300, hbMs = 50, beatMs = 500, seconds = 120, driftPpm = 60, offsetMs = 5000, jitter }) {
  let real = 0;                                   // true time, ms
  const clientNow = () => offsetMs + real * (1 + driftPpm * 1e-6); // phone's own clock
  const events = [];                              // {t, fn}
  const at = (t, fn) => { events.push({ t, fn }); };
  const timers = new Map(); let tid = 0;

  const shown = [];                               // {real, msg}
  const sched = createScheduler({
    now: clientNow,
    setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, true); at(real + ms / (1 + driftPpm * 1e-6), () => { if (timers.get(id)) { timers.delete(id); fn(); } }); return id; },
    clearTimeout: id => timers.delete(id),
    show: msg => shown.push({ real, msg }),
  });

  // host -> phone, in order: a delayed packet holds back everything behind it
  let lastDeliver = 0;
  const send = (obj) => {
    const h = real;                                // host clock == true time
    const delay = jitter();
    lastDeliver = Math.max(lastDeliver, real + delay);
    const msg = { h, ...obj };
    at(lastDeliver, () => {
      sched.observe(msg.h);
      if (msg.hb) return;
      if (msg.cut !== undefined) sched.cut(msg.cut);
      else if (msg.at !== undefined) sched.enqueue(msg);
    });
  };

  for (let t = 0; t < seconds * 1000; t += hbMs) at(t, () => send({ hb: 1 }));
  let i = 0;
  for (let due = 1000; due < seconds * 1000; due += beatMs, i++) {
    const k = i;
    at(due - lead, () => send({ measure: k, beat: 1, at: due }));
  }

  // run
  for (;;) {
    events.sort((a, b) => a.t - b.t);
    const e = events.shift();
    if (!e || e.t > seconds * 1000 + 2000) break;
    real = e.t; e.fn();
  }
  return { shown, sched };
}

function report(name, { shown, sched }) {
  const errs = shown.filter(s => s.msg.at !== undefined).map(s => s.real - s.msg.at);
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const p = q => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))];
  const st = sched.stats();
  console.log(`${name}: beats shown ${errs.length}, late arrivals ${st.late}; display error vs due time (ms): median ${p(0.5).toFixed(1)}  p99 ${p(0.99).toFixed(1)}  max ${p(1).toFixed(1)}`);
  return { errs, abs, late: st.late, count: errs.length };
}

let fail = 0;
const check = (ok, what) => { if (!ok) { fail++; console.log('  FAIL:', what); } else console.log('  ok:', what); };

// 1. Moderate WiFi jitter: mostly fast, some 10-60 ms, a few up to 140 ms
{
  const r = report('jittery link (up to 140 ms spikes)', run({ jitter: () => { const x = rnd(); return x < 0.9 ? 2 + rnd() * 6 : x < 0.98 ? 10 + rnd() * 50 : 60 + rnd() * 80; } }));
  check(r.count > 200, 'all beats displayed');
  check(r.late === 0, 'no beat arrived after its due time');
  check(r.abs[r.abs.length - 1] < 15, `worst display error < 15 ms (was ${r.abs[r.abs.length - 1].toFixed(1)})`);
}

// 2. Same but with a big clock offset and drift and nasty 250 ms spikes (still < lead)
{
  const r = report('very jittery (250 ms spikes)', run({ offsetMs: 987654, driftPpm: 100, jitter: () => { const x = rnd(); return x < 0.9 ? 3 + rnd() * 5 : 20 + rnd() * 230; } }));
  check(r.late === 0, 'no late arrivals with 250 ms spikes and 300 ms lead');
  check(r.abs[r.abs.length - 1] < 20, `worst display error < 20 ms (was ${r.abs[r.abs.length - 1].toFixed(1)})`);
}

// 3. Spikes bigger than the lead: those beats show late, immediately, nothing crashes
{
  const r = report('spikes exceed lead (500 ms)', run({ jitter: () => (rnd() < 0.02 ? 500 : 3 + rnd() * 5) }));
  check(r.late > 0, 'late beats are detected');
  check(r.count > 150, 'beats still displayed');
}

// 4. cut(): flush what was due, drop what wasn't
{
  let t = 0; const shown = []; const timers = [];
  const s = createScheduler({ now: () => t, setTimeout: (fn, ms) => timers.push({ fn, at: t + ms }), clearTimeout: () => { timers.length = 0; }, show: m => shown.push(m.id) });
  s.observe(0);                                     // offset 0
  s.enqueue({ id: 'a', at: 100 }); s.enqueue({ id: 'b', at: 200 }); s.enqueue({ id: 'c', at: 400 });
  s.cut(250);                                       // a,b were due by 250; c not
  check(shown.join() === 'b', 'cut flushes newest due beat only');
  check(s.pending() === 0, 'cut drops later beats');
  s.enqueue({ id: 'd', at: 500 }); s.cut(0);
  check(s.pending() === 0 && shown.join() === 'b', 'cut(0) drops everything without showing');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
