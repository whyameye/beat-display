#!/usr/bin/env node
'use strict';
// Synced quartet beat display — host.
// Serves public/index.html and broadcasts the current title/measure/beat to
// every connected client over WebSocket, on a schedule taken from beats.json.
//
//   node server.js [--port 8080] [--speed 1] [--beats beats.json]
//
// --speed 10 plays the schedule 10x faster (simulation / testing).
// --lead 1000 sends each beat 1000 ms before it is due; phones hold it until then (jitter buffer).
// --hb 100    heartbeat period in ms (also feeds the phones' clock-offset estimate).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-terminal');

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const PORT = Number(arg('port', process.env.PORT || 8080));
const SPEED = Number(arg('speed', 1));
const BEATS_FILE = path.resolve(__dirname, arg('beats', 'beats.json'));
const HB_MS = Number(arg('hb', 100));
const LEAD_MS = Number(arg('lead', 1000));
const END_HOLD_S = 2; // real seconds the last beat stays up before "END"
if (!(SPEED > 0)) { console.error('--speed must be > 0'); process.exit(1); }

// ---------- schedule ----------
const beats = JSON.parse(fs.readFileSync(BEATS_FILE, 'utf8'));
const N = beats.length; // index N is the virtual END event
for (let i = 1; i < N; i++) {
  if (!(beats[i].t > beats[i - 1].t)) throw new Error(`beats.json: t not increasing at index ${i}`);
}

const movements = []; // { title, startIdx }
beats.forEach((b, i) => {
  if (!movements.length || movements[movements.length - 1].title !== b.title) {
    movements.push({ title: b.title, startIdx: i });
  }
});
movements.forEach((m, k) => { m.endIdx = k + 1 < movements.length ? movements[k + 1].startIdx : N; });

// Host clock: monotonic ms since start, stamped on every message as `h`.
const T0 = process.hrtime.bigint();
const hostMs = () => Number(process.hrtime.bigint() - T0) / 1e6;
const shownObj = i => (i < 0 ? { state: 'start', title: beats[0].title, mv: 1 }
  : i >= N ? { state: 'end' }
  : { mv: movementOf(i) + 1, title: beats[i].title, measure: beats[i].measure, beat: beats[i].beat });
const wire = obj => JSON.stringify({ h: hostMs(), ...obj });

// ---------- http + websocket ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/sched.js': ['sched.js', 'text/javascript; charset=utf-8'],
  '/nosleep.mp4': ['nosleep.mp4', 'video/mp4'],
};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const hit = STATIC[url];
  if (!hit) { res.writeHead(404); return res.end('not found'); }
  const file = path.join(__dirname, 'public', hit[0]);
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(500); return res.end('read error'); }
    const headers = { 'Content-Type': hit[1], 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    // Safari (iPhone/iPad) will not play a <video> unless the server answers Range requests.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      let start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]);
      let end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      start = Math.max(0, start);
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });

const clientIp = req => (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ws.send(wire(shownObj(pos))); // late joiner / reconnect: show where we are right now...
  const t = hostMs();
  for (const a of ahead) if (a.at > t) ws.send(wire(a.obj)); // ...plus beats already sent but not yet due
  log(`+ client ${ip} connected (${wss.clients.size} total)`);
  ws.on('close', () => log(`- client ${ip} disconnected (${wss.clients.size} total)`));
  ws.on('error', () => {});
  ws.on('message', () => {}); // clients aren't expected to send anything
});

function broadcast(msg) {
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
// Heartbeat: lets a client notice a dead connection, and gives it host-clock samples.
setInterval(() => broadcast(wire({ hb: 1 })), HB_MS);

// ---------- playback engine ----------
// Each beat is sent LEAD_MS before it is due, tagged with the host time it is due (`at`).
// Phones hold it until then, so network jitter below LEAD_MS is invisible and all phones
// show the beat together. All host timing uses process.hrtime (monotonic) against one
// base timestamp, so nothing accumulates.
let pos = -1;        // beat currently showing: -1 = START, N = END
let running = false;
let baseNs = 0n;     // hrtime at which playback time t=0 falls
let gen = 0;         // bumped to cancel pending timers
let maxLateMs = 0;   // worst host lateness sending a beat
let ahead = [];      // beats already sent but not yet due (for late joiners)

const LEAD_NS = BigInt(Math.round(LEAD_MS * 1e6));
const nowNs = () => process.hrtime.bigint();
const scaled = t => BigInt(Math.round((t / SPEED) * 1e9));
const dueNs = i => (i >= N ? dueNs(N - 1) + BigInt(END_HOLD_S * 1e9) : baseNs + scaled(beats[i].t));
const dueHost = i => Number(dueNs(i) - T0) / 1e6;
const msUntil = ns => Math.max(0, Number(ns - nowNs()) / 1e6);

function schedule(i) {
  const g = gen;
  setTimeout(() => {
    if (g !== gen) return;
    const late = Number(nowNs() - (dueNs(i) - LEAD_NS)) / 1e6;
    if (late > maxLateMs) maxLateMs = late;
    const at = dueHost(i), obj = { ...shownObj(i), at };
    ahead = ahead.filter(a => a.at > hostMs() - 1000);
    ahead.push({ at, obj });
    broadcast(wire(obj));
    setTimeout(() => {                       // bookkeeping only: when it's due, it's "showing"
      if (g !== gen) return;
      pos = i; status();
      if (i >= N) { running = false; log(`end of piece (worst host send lateness ${maxLateMs.toFixed(2)} ms)`); }
    }, msUntil(dueNs(i)));
    if (i < N) schedule(i + 1);
  }, msUntil(dueNs(i) - LEAD_NS));
}

function play() {
  if (running) return log('already playing');
  if (pos >= N) return log('at END — use "r" to rewind first');
  const first = Math.max(pos, 0);
  baseNs = nowNs() + LEAD_NS - scaled(beats[first].t); // first beat is due LEAD_MS from now
  running = true; maxLateMs = 0; gen++; ahead = [];
  log(`playing from ${describe(first)}${SPEED !== 1 ? `  [speed x${SPEED}]` : ''}`);
  schedule(first);
}

function stop() {
  if (!running) return log('not playing');
  gen++; running = false;
  const now = nowNs();
  let p = pos;
  while (p < N && dueNs(p + 1) <= now) p++; // beats that came due since the last bookkeeping
  pos = p;
  ahead = [];
  broadcast(wire({ cut: hostMs() })); // phones: show what was due by now, drop the rest
  log(`stopped at ${describe(pos)} (worst host send lateness ${maxLateMs.toFixed(2)} ms)`);
  status();
}

function rewind() {
  gen++; running = false; ahead = [];
  pos = -1;
  broadcast(wire({ cut: 0 }));
  broadcast(wire(shownObj(-1)));
  status();
  log('rewound to START (press Enter to play)');
}

function jumpTo(idx) {
  const was = running;
  gen++; ahead = [];
  broadcast(wire({ cut: 0 }));       // phones: drop anything queued
  pos = idx;
  if (was) {
    baseNs = nowNs() + LEAD_NS - scaled(beats[idx].t);
    schedule(idx);                   // shows on every phone LEAD_MS from now
  } else {
    broadcast(wire(shownObj(idx)));  // stopped: show right away
  }
  status();
  log(`jumped to ${describe(idx)}${was ? ' (playing)' : ' (stopped — press Enter to play)'}`);
}

function describe(i) {
  if (i < 0) return 'START';
  if (i >= N) return 'END';
  const b = beats[i];
  return `#${movementOf(i) + 1} "${b.title}" m${b.measure}/b${b.beat}`;
}
function movementOf(i) {
  let k = 0;
  while (k + 1 < movements.length && movements[k + 1].startIdx <= i) k++;
  return k;
}

// ---------- terminal UI ----------
const tty = process.stdin.isTTY && process.stdout.isTTY;
const ts = () => new Date().toTimeString().slice(0, 8);
let rl;

// Layout in a TTY: [output...] / status row / prompt row. emit() overwrites the row
// above the prompt (the status row, or the echo of the just-typed command),
// prints, then redraws the status row and prompt beneath it.
function emit(text) {
  if (!tty || !rl) return console.log(text);
  process.stdout.write('\x1b[1A\r\x1b[2K' + text + '\n\x1b[2K' + statusLine() + '\n');
  rl.prompt(true);
}
const log = line => emit(`[${ts()}] ${line}`);
function statusLine() {
  const st = pos < 0 ? 'START' : pos >= N ? 'END' : describe(pos);
  return `${running ? '▶' : '■'} ${st}   clients: ${wss.clients.size}`;
}
function status() {
  if (!tty || !rl) return;
  process.stdout.write('\x1b7\x1b[1A\r\x1b[2K' + statusLine() + '\x1b8');
}

function listMovements() {
  emit('Movements:\n' + movements.map((m, k) => {
    const t = beats[m.startIdx].t;
    const mm = Math.floor(t / 60), ss = String(Math.floor(t % 60)).padStart(2, '0');
    const lastMeasure = beats[m.endIdx - 1].measure;
    return `  ${String(k + 1).padStart(2)}. ${m.title}  (${mm}:${ss}, ${lastMeasure} measures)`;
  }).join('\n'));
}

function help() {
  const first = lanUrls()[0];
  const base = (first ? first.url : `http://<this-Mac's-address>:${PORT}/`).replace(/\/$/, '');
  emit(`Commands (type then Enter):
  <Enter> / go     start, or resume from where it stopped
  s                stop (clients keep showing the current position)
  r                rewind to START (stopped)
  j N [M]          jump to movement N, optionally measure M of it
  m M              jump to measure M of the current movement
  l                list movements
  u                show URL(s) + QR code again
  h                this help        q   quit

Settings now: port ${PORT}, lead ${LEAD_MS} ms, heartbeat ${HB_MS} ms, speed x${SPEED}
To change them, quit (q) and restart with options (they can be combined):
  --lead 2000      send beats 2000 ms ahead (default 1000). Bigger hides more WiFi delay;
                   the first beat shows that long after you press Enter
  --port 9000      web/WebSocket port (default 8080)
  --hb 50          heartbeat period in ms (default 100)
  --speed 10       simulation: play 10x faster (default 1)
  --beats FILE     use a different beats file (default beats.json)
  e.g.  node server.js --lead 2000 --port 9000
        npm start -- --lead 2000        (via npm: note the extra --)

Page options: add to the end of the phone's URL, e.g. ${base}/?debug
  ?debug           show timing + keep-awake diagnostics at the bottom of the phone screen
                   (tap the yellow text to reset the counts; LATE should stay 0)
  ?ka=50           phone sends a tiny message every 50 ms, which can keep a WiFi radio
                   awake (write &ka=50 if it follows another option, like ?debug&ka=50)
  ?nogate          skip the TAP TO START screen (testing only)
  e.g.  ${base}/?debug&ka=50

Android Chrome, if the screen still sleeps: the real Wake Lock API needs a secure page.
Forcing it on for this address (once per phone; not for iPhones):
  1. In Chrome open   chrome://flags/#unsafely-treat-insecure-origin-as-secure
  2. Enter   ${base}   and set it to Enabled
  3. Tap Relaunch. With ?debug the line should then say "secure page: true".`);
}

function lanUrls() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, url: `http://${a.address}:${PORT}/` });
    }
  }
  out.sort((a, b) => (b.name.startsWith('bridge') - a.name.startsWith('bridge')) || a.name.localeCompare(b.name));
  return out;
}
function showUrls() {
  const urls = lanUrls();
  if (!urls.length) return emit('No LAN address found yet — is Wi-Fi / Internet Sharing on? Type "u" to retry.');
  qrcode.generate(urls[0].url, { small: true }, code => emit(
    'Open on each iPhone/iPad in Safari:\n' +
    urls.map(u => `  ${u.url}   (${u.name})`).join('\n') +
    `\n\nQR for ${urls[0].url}\n${code}`));
}

function handle(line) {
  const [cmd, ...a] = line.trim().toLowerCase().split(/\s+/);
  switch (cmd) {
    case '': case 'go': case 'g': case 'start': play(); break;
    case 's': case 'stop': stop(); break;
    case 'r': case 'restart': case 'rewind': rewind(); break;
    case 'j': case 'jump': {
      const mv = parseInt(a[0], 10);
      if (!(mv >= 1 && mv <= movements.length)) return log(`usage: j N [M]   (N = 1..${movements.length}, "l" to list)`);
      const m = movements[mv - 1];
      let idx = m.startIdx;
      if (a[1] !== undefined) idx = findMeasure(m, parseInt(a[1], 10));
      if (idx < 0) return;
      jumpTo(idx); break;
    }
    case 'm': case 'measure': {
      const k = movementOf(Math.max(pos, 0));
      const idx = findMeasure(movements[pos < 0 ? 0 : k], parseInt(a[0], 10));
      if (idx < 0) return;
      jumpTo(idx); break;
    }
    case 'l': case 'list': listMovements(); break;
    case 'u': case 'url': showUrls(); break;
    case 'h': case '?': case 'help': help(); break;
    case 'q': case 'quit': case 'exit': shutdown(); break;
    default: log(`unknown command "${cmd}" — "h" for help`);
  }
}

function findMeasure(m, measure) {
  for (let i = m.startIdx; i < m.endIdx; i++) if (beats[i].measure === measure) return i;
  const last = beats[m.endIdx - 1].measure;
  log(`"${m.title}" has no measure ${measure} (1..${last})`);
  return -1;
}

function shutdown() {
  gen++;
  for (const c of wss.clients) c.terminate();
  server.close();
  process.exit(0);
}

// ---------- go ----------
server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (try --port N)` : err);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => { // 0.0.0.0, NOT 127.0.0.1: must be reachable from other devices
  console.log(`Beat display host: ${N} beats, ${movements.length} movements, listening on 0.0.0.0:${PORT}`);
  console.log(`sending beats ${LEAD_MS} ms ahead; heartbeat every ${HB_MS} ms`);
  if (SPEED !== 1) console.log(`*** SIMULATION: playing at ${SPEED}x speed ***`);
  showUrls();
  console.log('');
  help();
  console.log('');
  if (tty) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
    console.log(statusLine());
    rl.prompt();
    rl.on('line', handle);
    rl.on('close', shutdown);
  } else {
    readline.createInterface({ input: process.stdin }).on('line', handle);
  }
});
process.on('SIGINT', shutdown);
