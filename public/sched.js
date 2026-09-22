'use strict';
// Client-side jitter buffer.
//
// The host stamps every message with its own monotonic clock (`h`, ms) and sends each
// beat ~LEAD ms before it is due, tagged with the host time it is due (`at`).
// The phone never runs a free clock of its own: it estimates the host clock's offset
// from the messages themselves and holds each beat until its `at` arrives.
//
// offset estimate = min over the last WINDOW_MS of (local receive time - host send time).
// Network delay only ever adds to that difference, so the smallest recent sample is
// (clock offset + best-case delay). Because the window is short, crystal drift between
// the two devices can't accumulate.
//
// Works in the browser (global createScheduler) and in Node (module.exports) so it can
// be tested with a fake clock.
(function (root) {
  function createScheduler({ now, setTimeout, clearTimeout, show, windowMs = 15000, trackStats = false }) {
    let samples = [];     // monotonic deque: {t: local time, d: local - host}, d strictly increasing
    let queue = [];       // pending beats, sorted by `at`: {at, msg}
    let timer = null;
    let stats;
    resetStats();

    // slack/delay (used only for the debug overlay's percentiles) are kept just when asked for
    // (trackStats), so a client not being watched doesn't grow and periodically trim arrays for
    // no reason. late/n are cheap counters and are always kept.
    function resetStats() { stats = { slack: [], delay: [], late: 0, n: 0 }; }
    const cap = a => { if (a.length > 4000) a.splice(0, 2000); };

    const offset = () => (samples.length ? samples[0].d : 0);
    const hostNow = () => now() - offset();

    // Every message from the host (beat, heartbeat, anything) feeds the estimate.
    function observe(h) {
      const t = now(), d = t - h;
      while (samples.length && samples[samples.length - 1].d >= d) samples.pop();
      samples.push({ t, d });
      while (samples.length && samples[0].t < t - windowMs) samples.shift();
      if (trackStats) { stats.delay.push(Math.max(0, d - offset())); cap(stats.delay); }
      if (queue.length) pump(); // the estimate may have moved
    }

    function pump() {
      clearTimeout(timer); timer = null;
      const hn = hostNow();
      let last = null;
      while (queue.length && queue[0].at <= hn) last = queue.shift();
      if (last) show(last.msg);   // several overdue at once: only the newest matters
      if (queue.length) timer = setTimeout(pump, Math.max(0, queue[0].at - hn));
    }

    // A beat to show when host clock reaches msg.at.
    function enqueue(msg) {
      const slack = msg.at - hostNow();          // <0 means it arrived after it was due
      stats.n++; if (slack < 0) stats.late++;
      if (trackStats) { stats.slack.push(slack); cap(stats.slack); }
      let i = queue.length;
      while (i > 0 && queue[i - 1].at > msg.at) i--;
      queue.splice(i, 0, { at: msg.at, msg });
      pump();
    }

    // Host says: everything due up to host-time T counts as already happened (show the
    // newest of those now); everything due later is cancelled. T = 0 drops everything.
    function cut(T) {
      let last = null;
      const keep = [];
      for (const q of queue) { if (q.at <= T) last = q; }
      clearTimeout(timer); timer = null;
      queue = keep;
      if (last) show(last.msg);
    }

    function reset() { queue = []; samples = []; clearTimeout(timer); timer = null; }

    return { observe, enqueue, cut, reset, resetStats, stats: () => stats, hostNow, pending: () => queue.length };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createScheduler };
  else root.createScheduler = createScheduler;
})(typeof self !== 'undefined' ? self : this);
