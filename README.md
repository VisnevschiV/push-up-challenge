# Pushups — Floor Sensor + Front Camera Trainer PWA

Hands-free push-up counter and adaptive 5-set progression trainer built as an installable offline-capable **Progressive Web App (PWA)**.

## Features

1. **Step 1: Baseline Max Test & Adaptive 5-Set Progression**
   - Starts by testing your unbroken push-up max (or accepting a known baseline) and sets a clear milestone goal (`25` / `40` / `60` / `100` unbroken reps).
   - Prescribes structured 5-set wave workouts (`60% · 76% · 58% · 58% · 72%+`, e.g., `3 · 4 · 3 · 3 · 4+` for a max of `5`) with hands-free between-set rest timers and spoken audio announcements.
   - Automatically scales working capacity after each completed workout across a **30-Day Schedule** (`23` training days + active recovery `REST` every 4th day).

2. **Flat-Floor & Face-Up Sensor Gate (`GroundOrientationMonitor`)**
   - Uses `DeviceOrientationEvent` (`beta` / `gamma` tilt angles, with iOS 13+ permission support) to verify the phone is screen-up and flat on the floor before arming the camera.
   - Immediately disarms rep detection when you pick up or tilt the phone at the end of a set.
   - Includes a one-tap **Sim Floor** fallback for desktop testing without IMU sensors.

3. **Front-Camera Optical Proximity Engine (`FrontCameraPushUpDetector`)**
   - Processes `64×48` front-camera (`facingMode: 'user'`) frames on-device at ~30 FPS (100% offline, no cloud uploads).
   - Supports **Hybrid (`Both`)**, **`Face`**, and **`Chest`** placement modes plus **`Easy` / `Normal` / `Strict`** depth thresholds, synthesized chimes, and a **Spoken Rep Counter** (`SpeechSynthesis`).

## Local Development

```bash
npm install
npm run dev
```

## Deploying to Your Phone (HTTPS)

Mobile browsers require **HTTPS** for camera (`getUserMedia`) and orientation (`DeviceOrientationEvent`) access. Once merged to `main`, enable **Settings → Pages → Source: GitHub Actions** in GitHub to publish via `.github/workflows/deploy.yml`, then open the URL on your phone and choose **Add to Home Screen**.
