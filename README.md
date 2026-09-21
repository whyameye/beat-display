# Synced beat display

Shows the current **movement, title, measure and beat** of a piece of music on several phones or
tablets at once, so an ensemble can glance at a screen instead of sharing a click track over
headphones. Visual only: no audio is sent anywhere.

A host (a Mac, or any machine that runs Node) sends beats over WebSocket to browsers on the same
WiFi. Nothing to install on the phones: they just open a web page.

## How it stays in sync

The host sends each beat about 1 second *before* it is due, tagged with the host-clock time it is
due. Each phone holds the beat until then (a jitter buffer), so WiFi delays under 1 s are invisible
and all phones flip together. Phones work out the host's clock from the messages themselves
(`public/sched.js`, re-estimated every few seconds), so nothing drifts over a long piece. If a beat
does arrive after it was due, it is shown immediately.

In tests with simulated 250 ms network spikes, beats were displayed within about 3 ms of schedule.
`node tools/test-sched.js` reproduces that. Real WiFi is worth checking with `?debug` (see below).

## Run

Needs [Node.js](https://nodejs.org/) (developed on v26).

    npm install
    npm start                     # real time, port 8080

The host prints the URL(s) and a QR code. On each phone, open the URL and tap **TAP TO START**.
Type `h` in the host for all commands and options.

Options (quit with `q` and restart to change them; `npm start -- --lead 2000` passes them via npm):

    --lead 2000     send beats 2000 ms ahead (default 1000); more hides more WiFi delay,
                    and the first beat shows that long after you press Enter
    --port 9000     port (default 8080)
    --hb 50         heartbeat period in ms (default 100)
    --speed 10      simulation: play 10x faster
    --beats FILE    beats file (default beats.json)

### Host commands (type + Enter)

    <Enter>   start, or resume where it stopped (ignored if already playing)
    s         stop (phones keep showing the current position)
    r         rewind to START (stopped)
    j N [M]   jump to movement N (optionally measure M); keeps playing if it was playing
    m M       jump to measure M of the current movement
    l         list movements      u   URL + QR      h   help      q   quit

## Beats file

`beats.json` is a list with one entry per beat, in time order:

    { "t": 12.345, "title": "Fly me to the Moon", "measure": 3, "beat": 2 }

`t` is seconds from the start of playback. A new `title` starts a new movement, and movements are
numbered in order. The included `beats.json` is the author's own medley, kept as a working example.
Replace it with your own (or pass `--beats`).

## Network

The phones and the host need to be on the same network. A normal router works well. Avoid a
router's "guest" network (devices there often can't reach each other).

Using the Mac itself as the WiFi network (no router): macOS won't turn on Internet Sharing without
an upstream connection. [This gist](https://gist.github.com/zhuhuilin/01656866b3e73a677a434c21183b40d2)
by zhuhuilin works around that with a dummy loopback network service; follow it, then turn on
System Settings > General > Sharing > Internet Sharing. It isn't included here. Once the hotspot
is on, type `u` in the host to reprint the URL: the phone-facing address is on the `bridge100`
interface (usually 192.168.2.1). In testing, a Mac hotspot had much worse WiFi jitter than an
ordinary router, so try a router first.

## Keeping the phone awake

Screens that turn off mid-piece are a problem, so the page tries to prevent it after the first tap:

- The Wake Lock API, which browsers only offer on secure pages (HTTPS/localhost). Over plain
  `http://` to an IP address it is not available.
- Fallback: a muted, full-screen, background-coloured video loops behind the page.

The bottom-right of the page says which one is active, or shows a warning if neither is. The most
reliable fix is still the phone's own setting (iOS: Display & Brightness > Auto-Lock > Never;
Android: Screen timeout). On Android Chrome you can also force the real Wake Lock API for the
host's address: open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
`http://<host-address>:8080`, enable, relaunch.

## Page options

Add to the end of the phone's URL:

    ?debug       timing and keep-awake diagnostics at the bottom of the screen
                 (LATE should stay 0; if not, restart the host with a bigger --lead)
    ?ka=50       the phone sends a tiny message every 50 ms (can keep a WiFi radio awake)
    ?nogate      skip the TAP TO START screen (testing only)

## Tests

    node tools/test-sched.js                             # jitter-buffer logic on a simulated network
    node server.js                                       # then press Enter to start playback
    node tools/simclient.js --seconds 20 --jitter 250    # fake phones against the running host

## License

MIT, see `LICENSE`.
