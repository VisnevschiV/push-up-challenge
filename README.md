# FloorRep — Camera Push-Up Challenge PWA

Hands-free push-up counter & 30-day progressive push-up challenge built as an installable offline-capable **Progressive Web App (PWA)**.

## How It Works

1. **Ground-Level & Face-Up Check (`GroundOrientationMonitor`)**
   - Uses `DeviceOrientationEvent` (`beta` / `gamma` tilt angles) with iOS 13+ permission handling to verify the phone is **screen-up** (`|β| < 90°`) and **flat on the floor** (`hypot(β, γ) ≤ 12°` for 600 ms).
   - Automatically disarms counting the instant you tilt/pick up the phone (`> 17°`), preventing false reps at the end of a set.
   - Includes a one-tap **Flat Test Mode** bypass for laptop/desktop browser testing without gyroscope hardware.

2. **Near-Field Front-Camera Vision Detector (`FrontCameraPushUpDetector`)**
   - Processes `64×48` front-camera (`facingMode: 'user'`) frames at ~30 FPS completely on-device (no cloud uploads or external ML weights required—works 100% offline).
   - Fuses **relative center-ROI luminance occlusion**, **shadow pixel coverage**, and **near-field spatial gradient defocus** against a drift-compensated upper-plank baseline.
   - Automatically switches to **Dark-Room Screen Fill-Light** mode when ambient light is low, illuminating your chest from the phone screen to detect proximity day or night.
   - Hysteresis state machine (`UP → DESCENDING → BOTTOM → UP`) with minimum dwell & cadence filtering + synthesized Web Audio chimes, haptic pulses, and `Screen Wake Lock`.

3. **30-Day Push-Up Challenge**
   - Four built-in programs (*30-Day Progressive 25→100*, *100/Day Centurion*, *Foundation 15→60*, and *Custom Daily Quota*) persisted locally with JSON backup export.

## Local Development

```bash
npm install
npm run dev
```

## Using on Your Phone (HTTPS Required)

Mobile browsers require **HTTPS** for camera (`getUserMedia`) and gyroscope (`DeviceOrientationEvent`) access:
- Push/merge to `main` and enable **Settings → Pages → Source: GitHub Actions** to serve over `https://<user>.github.io/push-up-challenge/`, then install via **Add to Home Screen**.
