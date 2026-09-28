# Monaco Street Circuit (Desktop App with Tauri)

Drive an F1-style car around the Circuit de Monaco as a standalone desktop application.
Built using [Tauri v2](https://tauri.app/), [Three.js](https://threejs.org/), and [MuJoCo WASM](https://mujoco.org/).

## Development & Build Commands

```sh
npm install

# Run in desktop development mode (hot-reload)
npm run tauri dev

# Build production macOS application and DMG installer
npm run tauri build

# Web-only dev/build (if needed)
npm run dev
npm run build
```

## Build Artifacts

- **macOS (Local / Apple Silicon)**:
  - **DMG Installer**: `src-tauri/target/release/bundle/dmg/Monaco Drive_1.0.0_aarch64.dmg`
  - **Application Bundle**: `src-tauri/target/release/bundle/macos/Monaco Drive.app`
- **Windows (GitHub Actions)**:
  - **NSIS Setup (.exe)**: `src-tauri/target/release/bundle/nsis/*.exe`
  - **Standalone (.exe)**: `src-tauri/target/release/Monaco Drive.exe`
  - **MSI Installer (.msi)**: `src-tauri/target/release/bundle/msi/*.msi`

## CI/CD (GitHub Actions)

- **`Build Windows Desktop App`** (`.github/workflows/build-windows.yml`):
  - Runs on every `push` to `main` and manual trigger (`workflow_dispatch`).
  - Automatically compiles Tauri on `windows-latest` and uploads Windows installer artifacts (`MonacoDrive-Windows-x64`).
- **`Release All Platforms`** (`.github/workflows/release-all.yml`):
  - Builds both macOS DMG and Windows EXE/MSI installers on git tag push (`v*`).

## What you get

- **Modes**: 🎮 Manual, or 🤖 Demo (an autopilot drives the lap).
- **Cameras**: 🪖 Cockpit, 🚗 Chase (slightly behind the car), or 🎥 Trackside (fixed spectator posts
  that follow the car). An overhead map sits in the top-left corner.
- **Pedals**: ACCEL / HOLD / BRAKE. Pressing the active pedal again releases it, and the car coasts.
- **Lap timing**: current, last and best lap.
- **Warnings**: hitting a barrier shows a warning and plays a three-beep alarm. Rolling the car over
  stops the sim until you press Reset.
- **Language**: English / 日本語. Your choice is remembered.

Keys: ←/→ steer · C center · F/S/R direction · Space/W accel · H hold · B brake · V camera · M mode · L language.
URL options: `?mode=demo&view=trackside&lang=ja&autostart`.

## How the world is built

`scripts/build-monaco.ts` turns the sources in `assets/` into `public/monaco/`:

| Source | Used for |
|---|---|
| `assets/monaco.tif`: SRTM 1″ elevation | terrain (smoothed near the circuit), and the distant hills over the whole tile |
| `assets/monaco.jpg`: circuit schematic | circuit centreline (hand-traced in `scripts/monaco-source.ts`), city blocks turned into buildings, parks turned into trees, road and quay colours on the ground |
| Sentinel-2 cloudless 2016 (EOX, CC BY 4.0) | satellite imagery on the distant terrain, blended into the ground texture |

The schematic was placed on the map by fitting its sea to the DEM's sea (rotation, scale and offset).
The traced lap comes out at 3,211 m; the real circuit is 3,337 m. Building heights are random, because
the SRTM surface model is too coarse to measure real ones.

| File | Role |
|---|---|
| `src/world.ts` | MJCF: heightfield, barriers, F1 car (livery, suspension, cameras), actuators |
| `src/sim.ts` | stepping, pedals, speed-sensitive steering, downforce, lap timing, contact / rollover detection, demo autopilot |
| `src/render.ts` | three.js scene: MuJoCo geoms, terrain, sea, road surface, tunnel, buildings, trees |
| `src/main.ts`, `index.html` | UI, cameras, HUD, alerts |
| `src/i18n.ts` | English / Japanese strings |
