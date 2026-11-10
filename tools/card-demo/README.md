# Card simulator

A static page that runs `custom:bticino-100x-card` against a fake intercom, so the whole flow can
be driven without a Home Assistant instance or a device on the wall.

```bash
python3 -m http.server 8778
```

Then open <http://localhost:8778/tools/card-demo/> from the repository root. The page imports the
real card file from `src/`, with a changing query string, so an edit shows up
on reload - no build in between, because the browser follows the card's own
imports.

## What it simulates

- **Ring front door** starts an incoming call: the doorbell sensor turns on, a fresh snapshot
  appears, every card reacts, and a record is opened in the call log. Nobody answering for 30
  seconds closes it as missed.
- **Answer at the monitor** and **Visitor hangs up** close the call as answered or missed.
- The card's own buttons act for real: **Open** unlocks and relocks after three seconds, **Stair
  light** toggles with the ten second auto-off, **Reject** ends the call, and **Live** and
  **Call home** start a call.
- **Notification: tap Answer** does what the phone does when the actionable notification is
  tapped: it reloads the page with `?answer=<camera>` in the address, with the bell ringing, and
  the card picks the call up on its own and clears the parameter.
- **Ring gate** rings the second external unit, so the pairing can be seen: the header names the
  entrance and **Answer** opens that unit's camera, not the first one.
- **One entrance only / Two entrances** adds or removes the second external unit, which is what
  decides whether the tabs appear at all: most homes have one, and the card should look right there
  too.
- **Refuse microphone** makes the browser deny it, which is how the card's notification path is
  exercised; toasts the card fires appear bottom left and in the log.
- **Drop module_id** removes the attribute from every entity, the way an integration older than
  k-the-hidden-hero/bticino_intercom#115 behaves, so the single-unit fallback can be checked.
- **Go offline** makes every entity unavailable.
- **Kiosk: upright / landscape** turns the wall tablet at the bottom of the page between 960x480
  and 480x800, drawn at its real pixel size and scaled down only when the window is narrower, so
  the call screen can be read the way it will be on the wall.

The swatches set the accent colour on every card at once, the way `color` does in the config, so
the palette can be checked against both themes.

Every action is printed in the log, so a flow can be read end to end.

## The screenshots in the README

The page doubles as the rig that takes them: `?shot=<card>` leaves that one card alone on the
page, and `ring=front|gate`, `answer`, `upright` and `dark` put it in the state wanted. `g1` to
`g5` are the cards down the page and `kiosk` is the wall tablet.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --force-device-scale-factor=2 --use-gl=swiftshader --enable-unsafe-swiftshader \
  --autoplay-policy=no-user-gesture-required --virtual-time-budget=9000 \
  --window-size=960,480 --screenshot=docs/images/card-100x-kiosk.png \
  "http://localhost:8778/tools/card-demo/index.html?shot=kiosk&ring=gate"
```

The window size is the picture: a card is 460 wide plus the page's 20px margins, and its height
has to be read off the page first. Software GL and the autoplay flag are what make the canvas
reach the video element in a headless run; without them the player comes out black.

## The call

The last card on the page carries only a `device_id` plus one free action pointing at
`lock.driveway_gate`, an entity that is deliberately not part of the integration, so the default
configuration and the extra buttons are both on screen next to the configured cards.

The page has no Home Assistant behind it, so `_startStream` is replaced with a session that
connects after a moment and, for a video call, serves a canvas animation as its video track. It is
only there to exercise the card's own states - connecting, live, microphone, audio only, hang up.
The real WebRTC path in the card is not covered by this page and needs a device to test.
