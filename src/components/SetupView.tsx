import React from 'react';
import type {
  CameraPlacementMode,
  ChallengeState,
  DepthRequirement,
  UserSettings,
} from '../services/challengeStore';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface SetupViewProps {
  state: ChallengeState;
  installPrompt: BeforeInstallPromptEvent | null;
  onTriggerInstall: () => void;
  onUpdateSettings: (patch: Partial<UserSettings>) => void;
  onUpdateBaselineMax: (newMax: number) => void;
  onLaunchMaxTest: () => void;
}

export const SetupView: React.FC<SetupViewProps> = ({
  state,
  installPrompt,
  onTriggerInstall,
  onUpdateSettings,
  onUpdateBaselineMax,
  onLaunchMaxTest,
}) => {
  const { settings } = state;
  const currentMax = Math.max(1, Math.round(state.baselineMax ?? state.trainingCapacity));

  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Vision & Floor Sensor Calibration Card (Matching Screenshot_122445) */}
      <section className="card">
        <span className="card-label" style={{ display: 'block', marginBottom: 4 }}>
          VISION &amp; FLOOR SENSOR CALIBRATION
        </span>

        {/* Baseline / Working Max */}
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.94rem' }}>Your Max Pushups</div>
            <div style={{ fontSize: '0.79rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Calibrates your 5-set adaptive program ·{' '}
              <button
                type="button"
                onClick={onLaunchMaxTest}
                style={{ color: 'var(--lime)', textDecoration: 'underline', fontSize: '0.79rem' }}
              >
                Re-test on floor
              </button>
            </div>
          </div>
          <div className="stepper-box">
            <button
              type="button"
              id="btn-max-minus"
              className="stepper-btn"
              onClick={() => onUpdateBaselineMax(Math.max(1, currentMax - 1))}
            >
              −
            </button>
            <span
              className="mono-num"
              style={{ minWidth: 34, textAlign: 'center', fontWeight: 700, fontSize: '0.92rem' }}
            >
              {state.baselineMax ?? currentMax}
            </span>
            <button
              type="button"
              id="btn-max-plus"
              className="stepper-btn"
              onClick={() => onUpdateBaselineMax(currentMax + 1)}
            >
              +
            </button>
          </div>
        </div>

        {/* Daily Push-Up Goal */}
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.94rem' }}>Daily Push-Up Goal</div>
            <div style={{ fontSize: '0.79rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Total reps per day to turn streak ring green
            </div>
          </div>
          <div className="stepper-box">
            <button
              type="button"
              id="btn-goal-minus"
              className="stepper-btn"
              onClick={() =>
                onUpdateSettings({ dailyGoal: Math.max(10, settings.dailyGoal - 5) })
              }
            >
              −
            </button>
            <span
              className="mono-num"
              style={{ minWidth: 34, textAlign: 'center', fontWeight: 700, fontSize: '0.92rem' }}
            >
              {settings.dailyGoal}
            </span>
            <button
              type="button"
              id="btn-goal-plus"
              className="stepper-btn"
              onClick={() => onUpdateSettings({ dailyGoal: settings.dailyGoal + 5 })}
            >
              +
            </button>
          </div>
        </div>

        {/* Camera Placement Mode */}
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.94rem' }}>Camera Placement Mode</div>
            <div style={{ fontSize: '0.79rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Auto-selects BlazeFace 3D scale, radial looming flow, or gain-invariant occlusion
            </div>
          </div>
          <div className="pill-segmented">
            {(
              [
                { id: 'both', label: 'Both' },
                { id: 'face', label: 'Face' },
                { id: 'chest', label: 'Chest' },
              ] as { id: CameraPlacementMode; label: string }[]
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                id={`placement-${opt.id}`}
                className={`pill-seg-btn ${
                  settings.placementMode === opt.id ? 'active' : ''
                }`}
                onClick={() => onUpdateSettings({ placementMode: opt.id })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Rep Depth Requirement */}
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.94rem' }}>Rep Depth Requirement</div>
            <div style={{ fontSize: '0.79rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              How close you must descend toward the front lens
            </div>
          </div>
          <div className="pill-segmented">
            {(
              [
                { id: 'easy', label: 'Easy' },
                { id: 'normal', label: 'Normal' },
                { id: 'strict', label: 'Strict' },
              ] as { id: DepthRequirement; label: string }[]
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                id={`depth-${opt.id}`}
                className={`pill-seg-btn ${
                  settings.depthRequirement === opt.id ? 'active' : ''
                }`}
                onClick={() => onUpdateSettings({ depthRequirement: opt.id })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Floor Tilt Tolerance */}
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.94rem' }}>Floor Tilt Tolerance</div>
            <div style={{ fontSize: '0.79rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              12° allows camera bumps or thick gym mats
            </div>
          </div>
          <div className="pill-segmented">
            {([8, 12, 18] as const).map((deg) => (
              <button
                key={deg}
                type="button"
                id={`tilt-${deg}`}
                className={`pill-seg-btn ${
                  settings.flatToleranceDeg === deg ? 'active' : ''
                }`}
                onClick={() => onUpdateSettings({ flatToleranceDeg: deg })}
              >
                {deg}°
              </button>
            ))}
          </div>
        </div>

        {/* Sound Effects */}
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.94rem' }}>Sound Effects</div>
            <div style={{ fontSize: '0.79rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Floor lock chime, bottom depth tick &amp; rep tone
            </div>
          </div>
          <button
            type="button"
            id="switch-sound"
            role="switch"
            aria-checked={settings.soundEnabled}
            className={`ios-switch ${settings.soundEnabled ? 'on' : ''}`}
            onClick={() => onUpdateSettings({ soundEnabled: !settings.soundEnabled })}
          >
            <span className="ios-switch-knob" />
          </button>
        </div>

        {/* Spoken Rep Counter */}
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.94rem' }}>Spoken Rep Counter</div>
            <div style={{ fontSize: '0.79rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Reads each rep count aloud hands-free
            </div>
          </div>
          <button
            type="button"
            id="switch-spoken"
            role="switch"
            aria-checked={settings.spokenEnabled}
            className={`ios-switch ${settings.spokenEnabled ? 'on' : ''}`}
            onClick={() => onUpdateSettings({ spokenEnabled: !settings.spokenEnabled })}
          >
            <span className="ios-switch-knob" />
          </button>
        </div>
      </section>

      {/* PWA Install Card */}
      <section className="card">
        <span className="card-label" style={{ display: 'block', marginBottom: 10 }}>
          INSTALL PUSHUPS PWA
        </span>
        {installPrompt && !isStandalone ? (
          <button
            type="button"
            id="btn-install-pwa"
            className="cta-lime"
            onClick={onTriggerInstall}
          >
            Install Pushups to Home Screen
          </button>
        ) : (
          <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
            {isStandalone
              ? 'Installed as standalone full-screen app (works offline).'
              : 'On iPhone Safari: tap Share → Add to Home Screen. On Android Chrome: tap ⋮ → Install app.'}
          </div>
        )}
      </section>
    </div>
  );
};
