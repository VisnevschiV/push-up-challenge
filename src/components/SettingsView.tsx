import React from 'react';
import type { SensitivityPreset, UserSettings } from '../services/challengeStore';
import type { OrientationSnapshot } from '../services/orientationSensor';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface SettingsViewProps {
  settings: UserSettings;
  orientation: OrientationSnapshot;
  installPrompt: BeforeInstallPromptEvent | null;
  onTriggerInstall: () => void;
  onUpdateSettings: (patch: Partial<UserSettings>) => void;
  onExportData: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  orientation,
  installPrompt,
  onTriggerInstall,
  onUpdateSettings,
  onExportData,
}) => {
  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* PWA Install Status */}
      <section className="surface-plate" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="eyebrow">Progressive Web App</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.72rem',
              color: isStandalone ? 'var(--accent-lime)' : 'var(--text-secondary)',
            }}
          >
            {isStandalone ? 'INSTALLED STANDALONE' : 'OFFLINE-READY'}
          </span>
        </div>

        {installPrompt && !isStandalone ? (
          <button
            type="button"
            id="btn-install-pwa"
            className="btn-primary"
            onClick={onTriggerInstall}
          >
            Install FloorRep to Home Screen
          </button>
        ) : !isStandalone ? (
          <div
            className="recessed-well"
            style={{ padding: '12px 14px', fontSize: '0.83rem', color: 'var(--text-secondary)' }}
          >
            <strong style={{ color: 'var(--text-primary)' }}>Install on your phone:</strong>
            <div style={{ marginTop: 4 }}>
              • <strong>iPhone (Safari):</strong> Tap <em>Share</em> → <em>Add to Home Screen</em>.
              <br />• <strong>Android (Chrome):</strong> Tap menu <em>⋮</em> → <em>Install app</em>.
            </div>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
            Running as a full-screen offline-capable app with local storage persistence.
          </p>
        )}
      </section>

      {/* Camera & Ground Sensor Calibration */}
      <section className="surface-plate" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <span className="eyebrow">Sensor &amp; Vision Calibration</span>

        <div>
          <label
            style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600, marginBottom: 8 }}
          >
            Push-Up Depth Sensitivity
          </label>
          <div className="segmented-group">
            {(['strict', 'standard', 'relaxed'] as SensitivityPreset[]).map((preset) => (
              <button
                key={preset}
                type="button"
                id={`sensitivity-${preset}`}
                className={`segment-btn ${settings.sensitivity === preset ? 'selected' : ''}`}
                onClick={() => onUpdateSettings({ sensitivity: preset })}
              >
                {preset === 'strict'
                  ? 'Strict (Low)'
                  : preset === 'standard'
                    ? 'Standard'
                    : 'Relaxed'}
              </button>
            ))}
          </div>
          <p style={{ margin: '6px 0 0', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
            Strict requires your chest/chin closer to the lens (~15 cm); Relaxed triggers slightly higher (~28 cm).
          </p>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.86rem', marginBottom: 6 }}>
            <span style={{ fontWeight: 600 }}>Flat Floor Angle Tolerance</span>
            <span className="tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
              ±{settings.flatToleranceDeg}°
            </span>
          </div>
          <input
            type="range"
            id="slider-flat-tolerance"
            min={6}
            max={22}
            step={1}
            value={settings.flatToleranceDeg}
            onChange={(e) => onUpdateSettings({ flatToleranceDeg: Number(e.target.value) })}
          />
          <div
            className="recessed-well tabular-nums"
            style={{
              marginTop: 10,
              padding: '9px 12px',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>β: {orientation.beta.toFixed(1)}°</span>
            <span>γ: {orientation.gamma.toFixed(1)}°</span>
            <span>Face-up: {orientation.isFaceUp ? 'YES' : 'NO'}</span>
          </div>
        </div>
      </section>

      {/* Audio, Haptics & Night Mode */}
      <section className="surface-plate" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span className="eyebrow">Feedback &amp; Environment</span>

        {[
          {
            id: 'toggle-sound',
            label: 'Synthesized Audio Chimes',
            desc: 'Beeps on flat-lock, bottom depth, and completed reps',
            checked: settings.soundEnabled,
            onToggle: () => onUpdateSettings({ soundEnabled: !settings.soundEnabled }),
          },
          {
            id: 'toggle-haptics',
            label: 'Haptic Vibration',
            desc: 'Tactile pulse on supported Android devices',
            checked: settings.hapticsEnabled,
            onToggle: () => onUpdateSettings({ hapticsEnabled: !settings.hapticsEnabled }),
          },
          {
            id: 'toggle-torch',
            label: 'Dark-Room Screen Fill-Light',
            desc: 'Adds a bright screen border in dark rooms so the front camera still sees depth',
            checked: settings.screenTorchInDark,
            onToggle: () => onUpdateSettings({ screenTorchInDark: !settings.screenTorchInDark }),
          },
        ].map((item) => (
          <div
            key={item.id}
            className="recessed-well"
            style={{
              padding: '12px 14px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>{item.label}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{item.desc}</div>
            </div>
            <button
              type="button"
              id={item.id}
              className="btn-secondary"
              onClick={item.onToggle}
              style={{
                minWidth: 64,
                borderColor: item.checked ? 'var(--accent-lime)' : undefined,
                color: item.checked ? 'var(--accent-lime)' : 'var(--text-muted)',
              }}
            >
              {item.checked ? 'ON' : 'OFF'}
            </button>
          </div>
        ))}

        <button
          type="button"
          id="btn-export-backup"
          className="btn-secondary"
          style={{ marginTop: 4 }}
          onClick={onExportData}
        >
          Export Challenge History (JSON)
        </button>
      </section>
    </div>
  );
};
