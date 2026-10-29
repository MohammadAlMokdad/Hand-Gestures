# Hand Particles

Thousands of glowing particles you shape, push and explode with your hands through the webcam.

Hand tracking is Google's MediaPipe Hand Landmarker running in the browser; rendering is Three.js with a bloom pass. Hand tracking runs entirely on your device, so your video never leaves it.

## Features

- Tracks up to two hands from the webcam and recognizes eight gestures (see below)
- Seven shapes: Sphere, Heart, Saturn, Galaxy, Knot, DNA, and Text (type your own word, up to 14 characters)
- Seven color palettes: Nebula, Inferno, Ocean, Aurora, Gold, Sakura, Rainbow
- Control panel for particle count (8k to 45k), particle size, glow strength, camera preview and hand skeleton overlay
- Mouse and keyboard mode when no camera is available
- Uses the GPU for hand tracking when it can and falls back to the CPU otherwise

## Tech stack

- [Three.js](https://threejs.org/) 0.160 with `EffectComposer` and `UnrealBloomPass`
- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) 0.10.14 (Hand Landmarker, WebAssembly)
- Plain JavaScript ES modules, HTML and CSS, with no build step
- A small zero-dependency Node.js static server (`server.js`)

## Prerequisites

- [Node.js](https://nodejs.org/) (only used to serve the files locally)
- Chrome or Edge, and a webcam
- An internet connection: Three.js, MediaPipe, the hand model and the font load from CDNs

## Getting started

```bash
git clone https://github.com/MohammadAlMokdad/Hand-Gestures.git
cd Hand-Gestures
npm start
```

Then open http://localhost:5173 and click **Start camera**, or **Use the mouse instead**.

There is nothing to install. Opening `index.html` directly from disk won't work, because browsers only allow camera access on `https://` or `http://localhost`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5173` | Port for the local server. It listens on `localhost` only. |

```bash
PORT=8080 npm start          # macOS / Linux
$env:PORT = 8080; npm start  # PowerShell
```

## Gestures

| Gesture | What it does |
| --- | --- |
| ✋ Open hand | Pushes particles away from your palm, and sweeps them along as you move |
| ☝️ Point | Pokes a small, strong hole with your fingertip |
| ✊ Fist | Pulls every particle into a glowing ball in your hand. Open your hand to blow it apart |
| 🤏 Pinch and drag | Grabs the shape and rotates it |
| 🙌 Two hands | Move them apart or together to resize the shape |
| ✌️ Hold peace sign | Next shape |
| 👍 Hold thumbs up | Next color palette |
| 🤘 Hold rock sign | Supernova: the core collapses, then blows apart and the debris never comes back on its own. Hold ✌️, make a ✊ or pick a shape to rebuild |

## Mouse and keyboard

Without a camera, the mouse pushes particles, dragging rotates, scrolling zooms and double-click is a supernova.

| Key | Action |
| --- | --- |
| `1`–`7` | Pick a shape |
| `←` `→` | Cycle shapes |
| `C` | Next color palette |
| `Space` | Supernova |
| `H` | Hide or show the UI |

## Project structure

```
Hand-Gestures/
├── index.html        Page layout, import map for Three.js
├── style.css         UI styling
├── server.js         Tiny static file server for http://localhost
├── src/
│   ├── main.js       Scene, particle physics, what each gesture does, and the UI
│   ├── hands.js      Camera, MediaPipe setup, and turning 21 hand landmarks into a gesture name
│   ├── shapes.js     Shape generators
│   └── palettes.js   Color palettes
└── package.json
```

To add a shape, write a generator in `src/shapes.js` that returns `{ pos, t }` and list it in `SHAPES`.

## Tuning

- If a pose isn't picked up reliably, adjust `TUNING` at the top of `src/hands.js`.
- `HOLD_MS` in `src/main.js` sets how long the peace, thumbs-up and rock signs must be held.
- The physics constants at the top of `src/main.js` set the feel: `SPRING` is how hard particles are pulled back to the shape, `DAMPING` is how quickly they lose speed, and `SPACE_DRAG` is how far supernova debris drifts.
- `CAM_MARGIN` sets how much of the camera's edge is ignored, so you can reach the screen corners without your hand leaving the frame.
- On a slow machine, pick 8k particles in the panel or lower the glow.

## Credits

- [Three.js](https://github.com/mrdoob/three.js) (MIT License)
- [MediaPipe](https://github.com/google-ai-edge/mediapipe) and the Hand Landmarker model by Google (Apache License 2.0)
- [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) font via Google Fonts (SIL Open Font License)
