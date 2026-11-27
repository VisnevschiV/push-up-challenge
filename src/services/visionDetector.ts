import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import type { CameraPlacementMode, DepthRequirement } from './challengeStore';

export type RepPhase =
  | 'DISARMED'
  | 'GET_READY'
  | 'CALIBRATING'
  | 'UP'
  | 'DESCENDING'
  | 'BOTTOM';

export type ActiveCVMethod =
  | 'BLAZEFACE'
  | 'LOOMING_FLOW'
  | 'OCCLUSION'
  | 'CALIBRATING';

export interface NormalizedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisionTelemetry {
  cameraActive: boolean;
  cameraError: string | null;
  phase: RepPhase;
  readyCountdownSec: number; // 3..1 during GET_READY, 0 otherwise
  activeMethod: ActiveCVMethod;
  mediapipeReady: boolean;
  faceBox: NormalizedBox | null;
  proximity: number; // 0..1 smoothed depth signal
  downThreshold: number;
  upThreshold: number;
  baselineLuma: number;
  centerLuma: number;
  isDarkAmbient: boolean;
}

export interface VisionCallbacks {
  onTelemetry: (telemetry: VisionTelemetry) => void;
  onReadyComplete?: () => void;
  onBottomReached: () => void;
  onRepCompleted: () => void;
}

const W = 64;
const H = 48;
const READY_DELAY_MS = 2800; // 3-second countdown so user gets into plank before zeroing

const DEPTH_THRESHOLDS: Record<DepthRequirement, { down: number; up: number }> = {
  easy: { down: 0.42, up: 0.2 },
  normal: { down: 0.55, up: 0.24 },
  strict: { down: 0.68, up: 0.27 },
};

const RADIAL_SCALES = [0.91, 0.94, 0.97, 0.99, 1.0, 1.01, 1.03, 1.06, 1.09];

// Module-level MediaPipe singleton + monotonic timestamp tracker
let sharedFaceDetector: FaceDetector | null = null;
let sharedDetectorPromise: Promise<FaceDetector | null> | null = null;
let globalLastMpTimestamp = 0;

async function ensureFaceDetector(): Promise<FaceDetector | null> {
  if (sharedFaceDetector) return sharedFaceDetector;
  if (sharedDetectorPromise) return sharedDetectorPromise;

  sharedDetectorPromise = (async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks('./mediapipe');
      try {
        sharedFaceDetector = await FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: './mediapipe/blaze_face_short_range.tflite',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.45,
        });
      } catch {
        // Fallback to CPU WASM delegate if WebGL is unavailable
        sharedFaceDetector = await FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: './mediapipe/blaze_face_short_range.tflite',
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.45,
        });
      }
      return sharedFaceDetector;
    } catch {
      sharedDetectorPromise = null;
      return null;
    }
  })();

  return sharedDetectorPromise;
}

export class FrontCameraPushUpDetector {
  private callbacks: VisionCallbacks;
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;

  private prevRawLuma: Float32Array = new Float32Array(W * H);
  private prevNormLuma: Float32Array = new Float32Array(W * H);
  private currNormLuma: Float32Array = new Float32Array(W * H);
  private hasPrevFrame = false;

  private running = false;
  private isArmed = false;
  private depthReq: DepthRequirement = 'normal';
  private placementMode: CameraPlacementMode = 'both';

  // Readiness & calibration state
  private armedSinceTs = 0;
  private skipReadyCountdown = false;
  private calibrationFrames = 0;

  // Method 1: BlazeFace 3D projective scale state
  private mediapipeReady = false;
  private lastFaceRunTs = 0;
  private plankFaceScale = 0.25;
  private hasPlankFaceScale = false;
  private currentFaceBox: NormalizedBox | null = null;
  private lastFaceScale = 0;
  private lastFaceProximity = 0;
  private lastFaceSeenTs = 0;

  // Method 2: Radial looming optical flow state
  private integratedLooming = 0;

  // Method 3: Gain-invariant occlusion & bidirectional envelope state
  private plankLuma = 120;
  private plankVignette = 0;
  private plankStd = 18;

  // Fused output & hysteresis state machine
  private activeMethod: ActiveCVMethod = 'CALIBRATING';
  private smoothedProximity = 0;
  private simulatedProximity: number | null = null;
  private phase: RepPhase = 'DISARMED';
  private bottomEnteredAt = 0;
  private lastRepAt = 0;
  private lowMotionInNonUpMs = 0;

  private rafId: number | null = null;
  private lastAnalysisTs = 0;

  constructor(callbacks: VisionCallbacks) {
    this.callbacks = callbacks;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    // Kick off MediaPipe load asynchronously
    ensureFaceDetector().then((det) => {
      this.mediapipeReady = det !== null;
    });
  }

  public configure(
    depthReq: DepthRequirement,
    placementMode: CameraPlacementMode
  ): void {
    this.depthReq = depthReq;
    this.placementMode = placementMode;
  }

  public setArmed(armed: boolean): void {
    if (this.isArmed === armed) return;
    this.isArmed = armed;
    if (!armed) {
      this.phase = 'DISARMED';
      this.smoothedProximity = 0;
      this.integratedLooming = 0;
      this.currentFaceBox = null;
    } else {
      this.armedSinceTs = performance.now();
      this.skipReadyCountdown = false;
      this.resetCalibrationBuffers();
      this.phase = 'GET_READY';
    }
  }

  /** Manual Zero button — skips 3s wait since user is already positioned */
  public recalibrate(immediate = true): void {
    this.skipReadyCountdown = immediate;
    this.armedSinceTs = performance.now();
    this.resetCalibrationBuffers();
    this.phase = this.isArmed
      ? immediate
        ? 'CALIBRATING'
        : 'GET_READY'
      : 'DISARMED';
  }

  private resetCalibrationBuffers(): void {
    this.calibrationFrames = 0;
    this.hasPlankFaceScale = false;
    this.integratedLooming = 0;
    this.smoothedProximity = 0;
    this.lowMotionInNonUpMs = 0;
    this.hasPrevFrame = false;
  }

  /** Desktop / camera-free push-up cycle test */
  public triggerSimulatedRep(): void {
    if (!this.isArmed) return;
    this.skipReadyCountdown = true;
    this.simulatedProximity = 0.85;
    if (this.phase === 'GET_READY' || this.phase === 'CALIBRATING') {
      this.phase = 'UP';
    }
    window.setTimeout(() => {
      this.simulatedProximity = 0.04;
      window.setTimeout(() => {
        this.simulatedProximity = null;
      }, 150);
    }, 180);
  }

  public async startCamera(videoElement: HTMLVideoElement): Promise<boolean> {
    this.videoEl = videoElement;
    this.running = true;

    ensureFaceDetector().then((det) => {
      this.mediapipeReady = det !== null;
    });

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.emitTelemetry(false, 'Camera API unavailable');
      this.startLoop();
      return false;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 480 },
          height: { ideal: 360 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      videoElement.srcObject = this.stream;
      videoElement.setAttribute('playsinline', 'true');
      videoElement.muted = true;
      await videoElement.play();
      if (this.isArmed) {
        this.armedSinceTs = performance.now();
        this.phase = 'GET_READY';
      }
      this.startLoop();
      return true;
    } catch {
      this.emitTelemetry(false, 'Camera unavailable');
      this.startLoop();
      return false;
    }
  }

  public stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
  }

  private startLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.lastAnalysisTs = performance.now();
    this.loop();
  }

  private loop = (): void => {
    if (!this.running) return;
    const now = performance.now();
    const dt = now - this.lastAnalysisTs;
    if (dt >= 32) {
      this.lastAnalysisTs = now;
      this.processFrame(now, dt);
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  /**
   * Method 2 helper: Estimates radial scale factor lambda between prevNormLuma and currNormLuma
   * over central annulus r in [5, 19]. lambda > 1 = expanding (moving DOWN), lambda < 1 = contracting (moving UP).
   */
  private estimateRadialExpansion(): number {
    if (!this.hasPrevFrame) return 1.0;

    const cx = W * 0.5;
    const cy = H * 0.5;
    const costs = new Float32Array(RADIAL_SCALES.length);

    for (let y = 6; y < H - 6; y += 2) {
      const dy = y - cy;
      for (let x = 8; x < W - 8; x += 2) {
        const dx = x - cx;
        const r2 = dx * dx + dy * dy;
        if (r2 < 25 || r2 > 360) continue;

        const currVal = this.currNormLuma[y * W + x];

        for (let sIdx = 0; sIdx < RADIAL_SCALES.length; sIdx++) {
          const invS = 1.0 / RADIAL_SCALES[sIdx];
          const sx = cx + dx * invS;
          const sy = cy + dy * invS;
          const ix = sx | 0;
          const iy = sy | 0;
          const fx = sx - ix;
          const fy = sy - iy;

          const p00 = this.prevNormLuma[iy * W + ix];
          const p10 = this.prevNormLuma[iy * W + ix + 1];
          const p01 = this.prevNormLuma[(iy + 1) * W + ix];
          const p11 = this.prevNormLuma[(iy + 1) * W + ix + 1];

          const interp =
            (1 - fy) * ((1 - fx) * p00 + fx * p10) +
            fy * ((1 - fx) * p01 + fx * p11);

          costs[sIdx] += Math.abs(currVal - interp);
        }
      }
    }

    let bestIdx = 4; // 1.0
    let bestCost = costs[4] * 0.985; // slight bias toward 1.0 to suppress sensor noise
    for (let i = 0; i < RADIAL_SCALES.length; i++) {
      if (costs[i] < bestCost) {
        bestCost = costs[i];
        bestIdx = i;
      }
    }

    // Parabolic sub-step refinement
    if (bestIdx > 0 && bestIdx < RADIAL_SCALES.length - 1) {
      const cPrev = costs[bestIdx - 1];
      const cCurr = costs[bestIdx];
      const cNext = costs[bestIdx + 1];
      const denom = 2 * (cPrev - 2 * cCurr + cNext);
      if (Math.abs(denom) > 1e-4) {
        const offset = Math.max(-0.5, Math.min(0.5, (cPrev - cNext) / denom));
        const step =
          (RADIAL_SCALES[bestIdx + 1] - RADIAL_SCALES[bestIdx - 1]) * 0.5;
        return RADIAL_SCALES[bestIdx] + offset * step;
      }
    }

    return RADIAL_SCALES[bestIdx];
  }

  /**
   * Method 1 helper: Runs BlazeFace on GPU/WASM (~18 FPS) and returns apparent 2D face scale (s ~ 1/Z).
   */
  private updateBlazeFace(now: number): boolean {
    if (
      !sharedFaceDetector ||
      !this.videoEl ||
      this.placementMode === 'chest'
    ) {
      this.currentFaceBox = null;
      return false;
    }

    if (now - this.lastFaceRunTs < 52) {
      // Reuse recent detection between 52ms GPU ticks
      return now - this.lastFaceSeenTs < 180;
    }
    this.lastFaceRunTs = now;

    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (vw <= 0 || vh <= 0) return false;

    const mpTs = Math.max(globalLastMpTimestamp + 1, Math.floor(now));
    globalLastMpTimestamp = mpTs;

    try {
      const result = sharedFaceDetector.detectForVideo(this.videoEl, mpTs);
      if (result.detections && result.detections.length > 0) {
        const det = result.detections[0];
        const bb = det.boundingBox;
        let boxScale = 0;

        if (bb) {
          const nx = Math.max(0, bb.originX / vw);
          const ny = Math.max(0, bb.originY / vh);
          const nw = Math.min(1, bb.width / vw);
          const nh = Math.min(1, bb.height / vh);
          this.currentFaceBox = { x: nx, y: ny, w: nw, h: nh };
          boxScale = Math.sqrt(nw * nh);
        }

        // Keypoint inter-eye / ear span (keypoints in BlazeFace are already normalized 0..1)
        let kpScale = 0;
        const kps = det.keypoints;
        if (kps && kps.length >= 2) {
          const dxEye = kps[0].x - kps[1].x;
          const dyEye = kps[0].y - kps[1].y;
          const eyeDist = Math.hypot(dxEye, dyEye);
          kpScale = eyeDist * 2.55;

          if (kps.length >= 6) {
            const earDist = Math.hypot(kps[4].x - kps[5].x, kps[4].y - kps[5].y);
            kpScale = Math.max(kpScale, earDist * 1.42);
          }
        }

        const scale = Math.max(boxScale, kpScale);
        if (scale > 0.08) {
          this.lastFaceScale = scale;
          this.lastFaceSeenTs = now;
          return true;
        }
      }
    } catch {
      // Ignore transient video frame errors
    }

    this.currentFaceBox = null;
    return false;
  }

  private processFrame(now: number, dtMs: number): void {
    const thresholds = DEPTH_THRESHOLDS[this.depthReq];
    const hasLiveVideo =
      this.videoEl !== null &&
      this.stream !== null &&
      this.videoEl.readyState >= 2 &&
      this.videoEl.videoWidth > 0;

    if (this.simulatedProximity !== null) {
      if (this.phase === 'GET_READY' || this.phase === 'CALIBRATING') {
        this.phase = 'UP';
      }
      this.activeMethod = 'OCCLUSION';
      this.smoothedProximity =
        0.45 * this.smoothedProximity + 0.55 * this.simulatedProximity;
      this.advanceStateMachine(now, thresholds);
      this.emitTelemetry(
        hasLiveVideo,
        hasLiveVideo ? null : 'Camera unavailable',
        0
      );
      return;
    }

    if (!hasLiveVideo || !this.ctx || !this.videoEl) {
      this.emitTelemetry(false, 'Camera unavailable', 0);
      return;
    }

    // 1. Extract 64x48 grayscale & compute zero-mean unit-variance normalized frame
    this.ctx.drawImage(this.videoEl, 0, 0, W, H);
    const rgba = this.ctx.getImageData(0, 0, W, H).data;

    let totalSum = 0;
    let centerSum = 0;
    let centerCount = 0;
    let outerSum = 0;
    let outerCount = 0;
    let motionSum = 0;

    const xMin = Math.floor(W * 0.2);
    const xMax = Math.floor(W * 0.8);
    const yMin = Math.floor(H * 0.18);
    const yMax = Math.floor(H * 0.82);

    const rawFrame = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i4 = (y * W + x) * 4;
        const luma =
          0.299 * rgba[i4] + 0.587 * rgba[i4 + 1] + 0.114 * rgba[i4 + 2];
        const idx = y * W + x;
        rawFrame[idx] = luma;
        totalSum += luma;

        if (x >= xMin && x < xMax && y >= yMin && y < yMax) {
          centerSum += luma;
          centerCount++;
          if (this.hasPrevFrame) {
            motionSum += Math.abs(luma - this.prevRawLuma[idx]);
          }
        } else {
          outerSum += luma;
          outerCount++;
        }
        this.prevRawLuma[idx] = luma;
      }
    }

    const meanLuma = totalSum / (W * H);
    let varSum = 0;
    for (let i = 0; i < W * H; i++) {
      const diff = rawFrame[i] - meanLuma;
      varSum += diff * diff;
    }
    const stdLuma = Math.sqrt(varSum / (W * H));
    const invStd = 1.0 / (stdLuma + 3.5);
    for (let i = 0; i < W * H; i++) {
      this.currNormLuma[i] = (rawFrame[i] - meanLuma) * invStd;
    }

    const centerLuma = centerSum / Math.max(1, centerCount);
    const outerLuma = outerSum / Math.max(1, outerCount);
    const meanMotion = this.hasPrevFrame
      ? motionSum / Math.max(1, centerCount)
      : 0;
    // Gain-invariant log center-to-outer ratio (AE gain g(t) cancels!)
    const currVignette = Math.log((centerLuma + 16) / (outerLuma + 16));

    // Run BlazeFace check
    const faceVisible = this.updateBlazeFace(now);

    if (!this.isArmed) {
      this.phase = 'DISARMED';
      this.smoothedProximity = 0;
      this.copyCurrToPrevNorm();
      this.emitTelemetry(true, null, 0, centerLuma);
      return;
    }

    // 2. 3-Second "Get Into Plank" Countdown (Prevents bare-ceiling calibration bug!)
    if (!this.skipReadyCountdown && this.phase === 'GET_READY') {
      const elapsedReady = now - this.armedSinceTs;
      if (elapsedReady < READY_DELAY_MS) {
        const secLeft = Math.max(
          1,
          Math.ceil((READY_DELAY_MS - elapsedReady) / 1000)
        );
        this.activeMethod = 'CALIBRATING';
        this.copyCurrToPrevNorm();
        this.emitTelemetry(true, null, secLeft, centerLuma);
        return;
      }
      this.phase = 'CALIBRATING';
      this.calibrationFrames = 0;
      this.callbacks.onReadyComplete?.();
    }

    // 3. Plank Reference Calibration (~16 frames = ~0.5s once in plank)
    if (this.calibrationFrames < 16) {
      this.phase = 'CALIBRATING';
      this.activeMethod = 'CALIBRATING';
      const a = this.calibrationFrames === 0 ? 1 : 0.22;
      this.plankLuma = (1 - a) * this.plankLuma + a * centerLuma;
      this.plankVignette = (1 - a) * this.plankVignette + a * currVignette;
      this.plankStd = (1 - a) * this.plankStd + a * stdLuma;

      if (faceVisible && this.lastFaceScale > 0.1) {
        const clampedFace = Math.max(0.14, Math.min(0.45, this.lastFaceScale));
        this.plankFaceScale = this.hasPlankFaceScale
          ? 0.75 * this.plankFaceScale + 0.25 * clampedFace
          : clampedFace;
        this.hasPlankFaceScale = true;
      }

      this.calibrationFrames++;
      if (this.calibrationFrames >= 16) {
        this.phase = 'UP';
        this.integratedLooming = 0;
      }
      this.copyCurrToPrevNorm();
      this.emitTelemetry(true, null, 0, centerLuma);
      return;
    }

    // 4. Compute all 3 CV Cues!

    // --- CUE A: Method 2 — Radial Looming Expansion/Contraction Flow ---
    const lambda = stdLuma > 2.6 ? this.estimateRadialExpansion() : 1.0;
    const logStep = Math.log(lambda);
    // Integrate outward expansion (+logStep when descending) and inward contraction (-logStep when ascending)
    const leak = meanMotion < 1.8 && this.phase === 'UP' ? 0.88 : 0.985;
    this.integratedLooming = Math.max(
      0,
      Math.min(1.15, this.integratedLooming * leak + 2.1 * logStep)
    );
    const pLooming = Math.min(1, this.integratedLooming / 0.62);

    // --- CUE B: Method 3 — Gain-Invariant & Bidirectional Occlusion (Works on white & dark shirts!) ---
    const vignetteShift = Math.min(
      1,
      Math.abs(currVignette - this.plankVignette) / 0.42
    );
    const biLumaShift = Math.min(
      1,
      Math.abs(centerLuma - this.plankLuma) / Math.max(this.plankLuma * 0.48, 24)
    );
    const defocusFlat =
      this.plankStd > 6
        ? Math.max(0, Math.min(1, (this.plankStd - stdLuma) / (this.plankStd * 0.65)))
        : 0;
    const pOcclusion = Math.min(
      1,
      0.45 * vignetteShift + 0.38 * biLumaShift + 0.17 * defocusFlat
    );

    // Chest / Non-Face fused proximity (combines radial looming + gain-invariant occlusion)
    const hasGoodTexture = stdLuma > 4.2;
    const pChestFused = hasGoodTexture
      ? Math.max(pLooming * 0.85 + pOcclusion * 0.25, pOcclusion * 0.88)
      : pOcclusion;

    // --- CUE C: Method 1 — MediaPipe BlazeFace 3D Projective Scale ---
    let rawProximity = pChestFused;

    if (faceVisible) {
      if (!this.hasPlankFaceScale) {
        this.plankFaceScale = Math.max(
          0.15,
          Math.min(0.42, this.lastFaceScale)
        );
        this.hasPlankFaceScale = true;
      }
      const scaleRatio = this.lastFaceScale / Math.max(0.12, this.plankFaceScale);
      const pFace = Math.max(0, Math.min(1, (scaleRatio - 1.07) / 0.82));
      this.lastFaceProximity = pFace;

      this.activeMethod = 'BLAZEFACE';
      rawProximity = pFace;

      // Adapt plank face scale gently when resting in UP plank
      if (this.phase === 'UP' && pFace < 0.18 && meanMotion < 2.5) {
        this.plankFaceScale =
          0.985 * this.plankFaceScale +
          0.015 * Math.max(0.14, Math.min(0.45, this.lastFaceScale));
      }
    } else if (
      this.placementMode !== 'chest' &&
      now - this.lastFaceSeenTs < 950 &&
      this.lastFaceProximity > 0.42 &&
      logStep >= -0.012
    ) {
      // Close-range handoff: face got so close (<12 cm) it clipped the camera FOV at the bottom!
      this.activeMethod = 'OCCLUSION';
      rawProximity = Math.max(this.lastFaceProximity * 0.92, pChestFused);
    } else {
      this.activeMethod = hasGoodTexture ? 'LOOMING_FLOW' : 'OCCLUSION';
      rawProximity = pChestFused;
    }

    this.smoothedProximity =
      0.55 * this.smoothedProximity + 0.45 * Math.max(0, Math.min(1, rawProximity));

    // 5. Rolling Plank Envelope & Anti-Stuck Self-Zeroing!
    if (this.phase === 'UP' && this.smoothedProximity < thresholds.up * 0.8 && meanMotion < 2.5) {
      this.plankLuma = 0.975 * this.plankLuma + 0.025 * centerLuma;
      this.plankVignette = 0.975 * this.plankVignette + 0.025 * currVignette;
      this.plankStd = 0.98 * this.plankStd + 0.02 * stdLuma;
      this.lowMotionInNonUpMs = 0;
    } else if (this.phase !== 'UP' && !faceVisible && meanMotion < 2.0 && Math.abs(logStep) < 0.008) {
      // Safety anti-stuck guard: if user is holding totally still in plank for >2.1s without a close face,
      // re-anchor plank baseline so Chest mode NEVER gets stuck waiting for an impossible ceiling brightness!
      this.lowMotionInNonUpMs += dtMs;
      if (this.lowMotionInNonUpMs > 2100) {
        this.plankLuma = centerLuma;
        this.plankVignette = currVignette;
        this.plankStd = stdLuma;
        this.integratedLooming = 0;
        this.smoothedProximity = 0;
        this.phase = 'UP';
        this.lowMotionInNonUpMs = 0;
      }
    } else {
      this.lowMotionInNonUpMs = 0;
    }

    this.advanceStateMachine(now, thresholds, logStep);
    this.copyCurrToPrevNorm();
    this.emitTelemetry(true, null, 0, centerLuma);
  }

  private copyCurrToPrevNorm(): void {
    this.prevNormLuma.set(this.currNormLuma);
    this.hasPrevFrame = true;
  }

  private advanceStateMachine(
    now: number,
    thresholds: { down: number; up: number },
    logStep = 0
  ): void {
    const p = this.smoothedProximity;

    if (this.phase === 'UP') {
      if (p > thresholds.up + 0.07) {
        this.phase = 'DESCENDING';
      }
    } else if (this.phase === 'DESCENDING') {
      if (p >= thresholds.down) {
        this.phase = 'BOTTOM';
        this.bottomEnteredAt = now;
        this.callbacks.onBottomReached();
      } else if (p <= thresholds.up) {
        this.phase = 'UP';
        this.integratedLooming = 0;
      }
    } else if (this.phase === 'BOTTOM') {
      const heldMs = now - this.bottomEnteredAt;
      // Count rep when returning below upThreshold (or strong radial inward contraction back to low proximity)
      const returnedUp =
        p <= thresholds.up || (p <= thresholds.up + 0.08 && logStep < -0.022);
      if (returnedUp) {
        if (heldMs >= 85 && now - this.lastRepAt >= 420) {
          this.lastRepAt = now;
          this.phase = 'UP';
          this.integratedLooming = 0;
          this.callbacks.onRepCompleted();
        } else {
          this.phase = 'UP';
        }
      }
    }
  }

  private emitTelemetry(
    cameraActive: boolean,
    error: string | null,
    readyCountdownSec = 0,
    centerLuma = this.plankLuma
  ): void {
    const thresholds = DEPTH_THRESHOLDS[this.depthReq];
    this.callbacks.onTelemetry({
      cameraActive,
      cameraError: error,
      phase: this.phase,
      readyCountdownSec,
      activeMethod: this.activeMethod,
      mediapipeReady: this.mediapipeReady,
      faceBox: this.currentFaceBox,
      proximity: this.smoothedProximity,
      downThreshold: thresholds.down,
      upThreshold: thresholds.up,
      baselineLuma: Math.round(this.plankLuma),
      centerLuma: Math.round(centerLuma),
      isDarkAmbient: this.plankLuma < 36,
    });
  }
}
