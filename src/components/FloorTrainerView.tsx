import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { ChallengeState, WorkoutMode } from '../services/challengeStore';
import { getTodayChallengeInfo } from '../services/challengeStore';
import type { OrientationSnapshot } from '../services/orientationSensor';
import { GroundOrientationMonitor } from '../services/orientationSensor';
import type { VisionTelemetry } from '../services/visionDetector';
import { FrontCameraPushUpDetector } from '../services/visionDetector';
import { soundEngine } from '../services/sound';
import { SpiritLevelCheck } from './SpiritLevelCheck';

interface FloorTrainerViewProps {
  state: ChallengeState;
  orientationMonitor: GroundOrientationMonitor;
  orientation: OrientationSnapshot;
  onActiveHudChange: (active: boolean) => void;
  onSaveSession: (reps: number, durationSec: number, mode: WorkoutMode, avgDepthPct: number) => void;
}

type SessionStage = 'setup' | 'active' | 'summary';

export const FloorTrainerView: React.FC<FloorTrainerViewProps> = ({
  state,
  orientationMonitor,
  orientation,
  onActiveHudChange,
  onSaveSession,
}) => {
  const [workoutMode, setWorkoutMode] = useState<WorkoutMode>('daily');
  const [stage, setStage] = useState<SessionStage>('setup');
  const [reps, setReps] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [repPulse, setRepPulse] = useState(false);
  const [depthSamples, setDepthSamples] = useState<number[]>([]);
  const [telemetry, setTelemetry] = useState<VisionTelemetry>({
    cameraActive: false,
    cameraError: null,
    phase: 'DISARMED',
    proximity: 0,
    downThreshold: 0.5,
    upThreshold: 0.23,
    baselineLuma: 120,
    centerLuma: 120,
    isDarkAmbient: false,
    fps: 30,
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const detectorRef = useRef<FrontCameraPushUpDetector | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const prevFlatLockedRef = useRef(false);
  const repsRef = useRef(0);

  const todayInfo = getTodayChallengeInfo(state);
  const targetRepsForSet =
    workoutMode === 'daily' ? Math.max(5, todayInfo.remaining || todayInfo.todayTarget) : 0;

  useEffect(() => {
    repsRef.current = reps;
  }, [reps]);

  // Sync user sound & haptics settings
  useEffect(() => {
    soundEngine.enabled = state.settings.soundEnabled;
    soundEngine.hapticsEnabled = state.settings.hapticsEnabled;
  }, [state.settings.soundEnabled, state.settings.hapticsEnabled]);

  // Play ground lock chime when phone transitions to flat-locked during active session
  useEffect(() => {
    if (stage === 'active') {
      if (orientation.isFlatLocked && !prevFlatLockedRef.current) {
        soundEngine.playFlatLocked();
      }
      detectorRef.current?.setArmed(orientation.isFlatLocked);
    }
    prevFlatLockedRef.current = orientation.isFlatLocked;
  }, [orientation.isFlatLocked, stage]);

  // Update sensitivity live
  useEffect(() => {
    detectorRef.current?.setSensitivity(state.settings.sensitivity);
  }, [state.settings.sensitivity]);

  // Session timer & 60s Blitz auto-stop
  useEffect(() => {
    if (stage !== 'active') return;
    const id = window.setInterval(() => {
      setElapsedSec((prev) => {
        const next = prev + 1;
        if (workoutMode === 'amrap60' && next >= 60) {
          finishActiveSet();
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, workoutMode]);

  // Spacebar shortcut for desktop push-up depth simulation
  useEffect(() => {
    if (stage !== 'active') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        detectorRef.current?.setSimulatedProximity(0.86);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        detectorRef.current?.setSimulatedProximity(0.05);
        window.setTimeout(() => {
          detectorRef.current?.setSimulatedProximity(null);
        }, 160);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [stage]);

  const acquireWakeLock = async () => {
    if ('wakeLock' in navigator) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        // WakeLock may be restricted in iframe/low battery
      }
    }
  };

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  };

  const startFloorSession = async () => {
    soundEngine.unlock();
    await orientationMonitor.requestAndStart();
    await acquireWakeLock();

    setReps(0);
    setElapsedSec(0);
    setDepthSamples([]);
    setStage('active');
    onActiveHudChange(true);

    const detector = new FrontCameraPushUpDetector({
      onTelemetry: (t) => setTelemetry(t),
      onBottomReached: () => {
        soundEngine.playBottomDepth();
      },
      onRepCompleted: (peakDepthPct) => {
        setReps((prev) => {
          const next = prev + 1;
          const hitDailyGoal =
            workoutMode === 'daily' && targetRepsForSet > 0 && next === targetRepsForSet;
          soundEngine.playRepCounted(next, hitDailyGoal);
          return next;
        });
        setDepthSamples((prev) => [...prev, peakDepthPct]);
        setRepPulse(true);
        window.setTimeout(() => setRepPulse(false), 210);
      },
    });
    detector.setSensitivity(state.settings.sensitivity);
    detector.setArmed(orientationMonitor.getSnapshot().isFlatLocked);
    detectorRef.current = detector;

    // Wait a microtask for <video> to mount in active HUD
    requestAnimationFrame(() => {
      if (videoRef.current) {
        detector.startCamera(videoRef.current);
      }
    });
  };

  const finishActiveSet = useCallback(() => {
    detectorRef.current?.stop();
    detectorRef.current = null;
    releaseWakeLock();
    setStage('summary');
    onActiveHudChange(false);
  }, [onActiveHudChange]);

  useEffect(() => {
    return () => {
      detectorRef.current?.stop();
      releaseWakeLock();
    };
  }, []);

  const handleConfirmSave = () => {
    if (reps > 0) {
      const avgDepth =
        depthSamples.length > 0
          ? Math.round(depthSamples.reduce((a, b) => a + b, 0) / depthSamples.length)
          : 82;
      onSaveSession(reps, Math.max(1, elapsedSec), workoutMode, avgDepth);
    }
    setStage('setup');
  };

  const formatTimer = (sec: number) => {
    const display = workoutMode === 'amrap60' ? Math.max(0, 60 - sec) : sec;
    const m = Math.floor(display / 60);
    const s = display % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // --- STAGE 1: SETUP ---
  if (stage === 'setup') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Daily Challenge Hero Plate */}
        <section className="surface-plate" aria-labelledby="today-quota-heading">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <span className="eyebrow">Day {todayInfo.currentDayNumber} of 30 · Daily Quota</span>
              <h2
                id="today-quota-heading"
                className="tabular-nums"
                style={{
                  margin: '4px 0 0',
                  fontFamily: 'var(--font-display)',
                  fontSize: '2.5rem',
                  lineHeight: 1,
                  letterSpacing: '-0.04em',
                }}
              >
                {todayInfo.todayReps}
                <span style={{ color: 'var(--text-muted)', fontSize: '1.5rem', fontWeight: 600 }}>
                  {' '}
                  / {todayInfo.todayTarget}
                </span>
              </h2>
            </div>

            <div
              style={{
                textAlign: 'right',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                color:
                  todayInfo.remaining === 0 ? 'var(--accent-lime)' : 'var(--text-secondary)',
              }}
            >
              {todayInfo.remaining === 0 ? 'QUOTA COMPLETE' : `${todayInfo.remaining} REPS LEFT`}
            </div>
          </div>

          {/* Crisp progress bar */}
          <div
            style={{
              marginTop: 14,
              height: 8,
              borderRadius: 99,
              background: 'var(--bg-recessed)',
              overflow: 'hidden',
              border: '1px solid var(--line-subtle)',
            }}
          >
            <div
              style={{
                width: `${todayInfo.progressPct}%`,
                height: '100%',
                background: 'var(--accent-lime)',
                borderRadius: 99,
                transition: 'width 0.35s ease',
              }}
            />
          </div>
        </section>

        {/* Workout Mode & Ground Sensor Check */}
        <section className="surface-plate" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <span className="eyebrow" style={{ display: 'block', marginBottom: 8 }}>
              Session Mode
            </span>
            <div className="segmented-group" role="tablist" aria-label="Session Mode">
              <button
                type="button"
                id="mode-daily"
                className={`segment-btn ${workoutMode === 'daily' ? 'selected' : ''}`}
                onClick={() => setWorkoutMode('daily')}
              >
                Daily Set ({Math.max(5, todayInfo.remaining || todayInfo.todayTarget)})
              </button>
              <button
                type="button"
                id="mode-amrap60"
                className={`segment-btn ${workoutMode === 'amrap60' ? 'selected' : ''}`}
                onClick={() => setWorkoutMode('amrap60')}
              >
                60s Blitz
              </button>
              <button
                type="button"
                id="mode-free"
                className={`segment-btn ${workoutMode === 'free' ? 'selected' : ''}`}
                onClick={() => setWorkoutMode('free')}
              >
                Free Endless
              </button>
            </div>
          </div>

          <div>
            <span className="eyebrow" style={{ display: 'block', marginBottom: 8 }}>
              1 · Ground Level Check
            </span>
            <SpiritLevelCheck
              orientation={orientation}
              toleranceDeg={state.settings.flatToleranceDeg}
              onToggleManualFlat={(val) => orientationMonitor.setManualFlatOverride(val)}
              needsPermissionGesture={orientationMonitor.needsExplicitPermissionGesture()}
              onRequestSensorPermission={() => orientationMonitor.requestAndStart()}
            />
          </div>

          <div
            className="recessed-well"
            style={{
              padding: '12px 14px',
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
              <rect x="3" y="21" width="22" height="3.5" rx="1.75" fill="var(--accent-lime)" />
              <path
                d="M8 7L14 13L20 7"
                stroke="var(--text-primary)"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="14" cy="17.5" r="2" fill="var(--accent-lime)" />
            </svg>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              <strong style={{ color: 'var(--text-primary)' }}>How it counts:</strong> Lay phone
              face-up beneath your chest/chin. Once flat-locked, the front camera tracks your
              descent &amp; ascent hands-free—and pauses immediately when you pick the phone up.
            </div>
          </div>

          <button
            type="button"
            id="btn-start-floor-session"
            className="btn-primary"
            onClick={startFloorSession}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5.14v14l11-7-11-7z" />
            </svg>
            Start Floor Session
          </button>
        </section>
      </div>
    );
  }

  // --- STAGE 2: ACTIVE FLOOR HUD ---
  if (stage === 'active') {
    const outerRadius = 136;
    const innerRadius = 114;
    const outerCirc = 2 * Math.PI * outerRadius;
    const innerCirc = 2 * Math.PI * innerRadius;

    const outerRatio =
      workoutMode === 'daily' && targetRepsForSet > 0
        ? Math.min(1, reps / targetRepsForSet)
        : workoutMode === 'amrap60'
          ? Math.max(0, 1 - elapsedSec / 60)
          : (reps % 20) / 20;

    const depthRatio = Math.min(1, telemetry.proximity / Math.max(0.2, telemetry.downThreshold));
    const isBottomHit = telemetry.phase === 'BOTTOM' || telemetry.proximity >= telemetry.downThreshold;

    const phaseDisplayText = !orientation.isFlatLocked
      ? !orientation.isFaceUp
        ? 'FLIP PHONE FACE-UP'
        : 'LAY PHONE FLAT ON FLOOR'
      : telemetry.phase === 'CALIBRATING'
        ? 'HOLD PLANK · CALIBRATING'
        : telemetry.phase === 'BOTTOM'
          ? 'DEPTH HIT · PUSH UP!'
          : telemetry.phase === 'DESCENDING'
            ? 'LOWER CHEST TO TARGET'
            : 'READY · DESCEND';

    const useScreenTorch =
      state.settings.screenTorchInDark && telemetry.isDarkAmbient && orientation.isFlatLocked;

    return (
      <div className={`floor-hud ${useScreenTorch ? 'screen-torch' : ''}`} id="active-floor-hud">
        {/* Top status strip */}
        <div className="hud-top-strip">
          <div className="sensor-readout-pill">
            <span className={`status-dot ${orientation.isFlatLocked ? 'locked' : ''}`} />
            <span>
              {orientation.isFlatLocked
                ? `FLAT ${orientation.tiltDeg.toFixed(0)}°`
                : `TILT ${orientation.tiltDeg.toFixed(0)}°`}
            </span>
          </div>

          <div className="sensor-readout-pill tabular-nums">{formatTimer(elapsedSec)}</div>
        </div>

        {/* If phone is NOT flat yet, show Spirit Level prominently so user can level it easily */}
        {!orientation.isFlatLocked && (
          <SpiritLevelCheck
            orientation={orientation}
            toleranceDeg={state.settings.flatToleranceDeg}
            onToggleManualFlat={(val) => orientationMonitor.setManualFlatOverride(val)}
          />
        )}

        {/* Massive Floor-Readable Dual-Ring Rep Dial */}
        <div className="rep-dial-stage">
          <svg className="rep-ring-svg" viewBox="0 0 300 300" aria-hidden="true">
            {/* Outer progress track */}
            <circle
              cx="150"
              cy="150"
              r={outerRadius}
              fill="none"
              stroke="hsla(48, 15%, 90%, 0.08)"
              strokeWidth="8"
            />
            <circle
              cx="150"
              cy="150"
              r={outerRadius}
              fill="none"
              stroke="var(--accent-lime)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={outerCirc}
              strokeDashoffset={outerCirc * (1 - outerRatio)}
              style={{ transition: 'stroke-dashoffset 0.25s ease' }}
            />

            {/* Inner live proximity depth ring */}
            <circle
              cx="150"
              cy="150"
              r={innerRadius}
              fill="none"
              stroke="hsla(48, 15%, 90%, 0.06)"
              strokeWidth="12"
            />
            <circle
              cx="150"
              cy="150"
              r={innerRadius}
              fill="none"
              stroke={isBottomHit ? 'var(--accent-lime)' : 'var(--accent-amber)'}
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray={innerCirc}
              strokeDashoffset={innerCirc * (1 - depthRatio)}
              style={{ transition: 'stroke-dashoffset 0.06s linear, stroke 0.12s ease' }}
            />
          </svg>

          <div className="rep-dial-center">
            {workoutMode === 'daily' && targetRepsForSet > 0 && (
              <span className="eyebrow" style={{ marginBottom: 4 }}>
                TARGET {targetRepsForSet}
              </span>
            )}
            <div className={`rep-big-number ${repPulse ? 'pulse' : ''}`} id="live-rep-count">
              {reps}
            </div>
            <div
              className={`rep-phase-label ${
                telemetry.phase === 'BOTTOM'
                  ? 'bottom'
                  : telemetry.phase === 'DESCENDING'
                    ? 'descending'
                    : ''
              }`}
            >
              {phaseDisplayText}
            </div>
          </div>
        </div>

        {/* Bottom Camera PiP + Live Depth Bar + Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="surface-plate camera-telemetry-bar" style={{ padding: 12 }}>
            <div className="camera-pip-frame">
              <video ref={videoRef} className="camera-pip-video" playsInline muted />
              <div className="camera-roi-reticle" />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="eyebrow">Chest Depth Sensor</span>
                <span
                  className="tabular-nums"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '0.74rem', color: 'var(--text-secondary)' }}
                >
                  {Math.round(telemetry.proximity * 100)}% / {Math.round(telemetry.downThreshold * 100)}%
                </span>
              </div>

              <div className="depth-meter-track">
                <div
                  className={`depth-meter-fill ${isBottomHit ? 'hit' : ''}`}
                  style={{ width: `${Math.min(100, Math.round(telemetry.proximity * 100))}%` }}
                />
                <div
                  className="depth-threshold-tick"
                  style={{ left: `${Math.round(telemetry.downThreshold * 100)}%` }}
                  title="Required bottom depth threshold"
                />
              </div>

              {telemetry.cameraError ? (
                <span style={{ fontSize: '0.73rem', color: 'var(--accent-amber)' }}>
                  {telemetry.cameraError}
                </span>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.73rem', color: 'var(--text-muted)' }}>
                    {telemetry.isDarkAmbient ? 'Night screen-glow assist ON' : `Luma ${telemetry.centerLuma}/${telemetry.baselineLuma}`}
                  </span>
                  <button
                    type="button"
                    id="btn-recalibrate-plank"
                    onClick={() => detectorRef.current?.recalibrate()}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      color: 'var(--accent-lime)',
                      textDecoration: 'underline',
                      padding: '2px 4px',
                    }}
                  >
                    Recalibrate Top
                  </button>
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button
              type="button"
              id="btn-simulate-pushup"
              className="btn-secondary"
              onPointerDown={() => {
                if (!orientation.isFlatLocked) {
                  orientationMonitor.setManualFlatOverride(true);
                }
                detectorRef.current?.setSimulatedProximity(0.85);
              }}
              onPointerUp={() => {
                detectorRef.current?.setSimulatedProximity(0.05);
                window.setTimeout(() => {
                  detectorRef.current?.setSimulatedProximity(null);
                }, 160);
              }}
              onPointerCancel={() => detectorRef.current?.setSimulatedProximity(null)}
            >
              Hold: Test Push-Up
            </button>

            <button
              type="button"
              id="btn-finish-session"
              className="btn-danger"
              onClick={finishActiveSet}
            >
              Finish Set
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- STAGE 3: POST-SET SUMMARY ---
  const avgDepth =
    depthSamples.length > 0
      ? Math.round(depthSamples.reduce((a, b) => a + b, 0) / depthSamples.length)
      : reps > 0
        ? 82
        : 0;
  const paceRpm = elapsedSec > 4 ? Math.round((reps / elapsedSec) * 60) : reps * 15;

  return (
    <section
      className="surface-plate"
      style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
      id="session-summary-card"
    >
      <div style={{ textAlign: 'center', paddingTop: 6 }}>
        <span className="eyebrow">Set Complete</span>
        <div
          className="tabular-nums"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '4.4rem',
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: '-0.04em',
            color: 'var(--accent-lime)',
            margin: '8px 0 6px',
          }}
        >
          {reps}
        </div>
        <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          Clean Push-Ups Counted
        </span>

        {/* Quick +/-1 adjustment in case of stray movement */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 14 }}>
          <button
            type="button"
            id="btn-adjust-minus"
            className="btn-secondary"
            onClick={() => setReps((r) => Math.max(0, r - 1))}
          >
            − 1 Rep
          </button>
          <button
            type="button"
            id="btn-adjust-plus"
            className="btn-secondary"
            onClick={() => setReps((r) => r + 1)}
          >
            + 1 Rep
          </button>
        </div>
      </div>

      <div className="stat-strip">
        <div className="stat-box">
          <span className="eyebrow">Duration</span>
          <div className="stat-value">{formatTimer(elapsedSec)}</div>
        </div>
        <div className="stat-box">
          <span className="eyebrow">Cadence</span>
          <div className="stat-value">{paceRpm}/m</div>
        </div>
        <div className="stat-box">
          <span className="eyebrow">Avg Depth</span>
          <div className="stat-value">{avgDepth}%</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
        <button
          type="button"
          id="btn-discard-set"
          className="btn-secondary"
          onClick={() => setStage('setup')}
        >
          Discard
        </button>
        <button
          type="button"
          id="btn-save-set"
          className="btn-primary"
          onClick={handleConfirmSave}
        >
          {reps > 0 ? `Log ${reps} Push-Ups` : 'Done'}
        </button>
      </div>
    </section>
  );
};
