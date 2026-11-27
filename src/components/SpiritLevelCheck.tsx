import React from 'react';
import type { OrientationSnapshot } from '../services/orientationSensor';

interface SpiritLevelCheckProps {
  orientation: OrientationSnapshot;
  toleranceDeg: number;
  onToggleManualFlat: (manual: boolean) => void;
  onRequestSensorPermission?: () => void;
  needsPermissionGesture?: boolean;
}

export const SpiritLevelCheck: React.FC<SpiritLevelCheckProps> = ({
  orientation,
  toleranceDeg,
  onToggleManualFlat,
  onRequestSensorPermission,
  needsPermissionGesture,
}) => {
  // Clamp bubble displacement inside 84px dial (max radius ~28px)
  const maxVisualDeg = 35;
  const clampedGamma = Math.max(-maxVisualDeg, Math.min(maxVisualDeg, orientation.gamma));
  const clampedBeta = Math.max(-maxVisualDeg, Math.min(maxVisualDeg, orientation.beta));
  const offsetX = (clampedGamma / maxVisualDeg) * 26;
  const offsetY = (clampedBeta / maxVisualDeg) * 26;

  let statusHeadline = 'Place phone flat, screen up';
  let statusDetail = `Target ≤ ${toleranceDeg}° tilt · Current ${Math.round(orientation.tiltDeg)}°`;

  if (!orientation.hasHardwareEvents && !orientation.manualFlatOverride) {
    statusHeadline = 'Waiting for gyroscope...';
    statusDetail = 'On a laptop or desktop? Enable Flat Test Mode below.';
  } else if (!orientation.isFaceUp && !orientation.manualFlatOverride) {
    statusHeadline = 'Phone is face-down / inverted';
    statusDetail = 'Flip phone so screen & front camera face the ceiling.';
  } else if (orientation.isFlatLocked) {
    statusHeadline = orientation.manualFlatOverride
      ? 'Flat lock simulated (Test Mode)'
      : 'Ground lock engaged · Face-up';
    statusDetail = orientation.manualFlatOverride
      ? 'Front camera armed for desktop / stand testing'
      : `Tilt ${orientation.tiltDeg.toFixed(1)}° · Camera armed`;
  } else if (orientation.isWithinFlatAngle) {
    statusHeadline = 'Stabilizing on floor...';
    statusDetail = `Hold steady (${Math.round(orientation.settleProgress * 100)}%)`;
  }

  return (
    <div className="recessed-well level-instrument" id="ground-spirit-level">
      <div className="level-dial" aria-label="Ground spirit level indicator">
        <div className="level-crosshair-h" />
        <div className="level-crosshair-v" />
        <div className={`level-target-ring ${orientation.isFlatLocked ? 'locked' : ''}`} />
        <div
          className={`level-bubble ${orientation.isFlatLocked ? 'locked' : ''}`}
          style={{
            transform: `translate(${offsetX.toFixed(1)}px, ${offsetY.toFixed(1)}px)`,
          }}
        />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
          <span
            className={`status-dot ${
              orientation.isFlatLocked
                ? 'locked'
                : !orientation.isFaceUp
                  ? 'danger'
                  : ''
            }`}
          />
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: '0.95rem',
              color: orientation.isFlatLocked ? 'var(--accent-lime)' : 'var(--text-primary)',
            }}
          >
            {statusHeadline}
          </span>
        </div>

        <div
          style={{
            fontSize: '0.78rem',
            color: 'var(--text-secondary)',
            marginBottom: 9,
          }}
        >
          {statusDetail}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {needsPermissionGesture && onRequestSensorPermission && (
            <button
              type="button"
              id="btn-enable-motion-sensors"
              className="btn-secondary"
              style={{ padding: '6px 11px', fontSize: '0.76rem' }}
              onClick={onRequestSensorPermission}
            >
              Enable Motion Sensors
            </button>
          )}

          {(!orientation.hasHardwareEvents || orientation.manualFlatOverride) && (
            <button
              type="button"
              id="btn-toggle-flat-override"
              className="btn-secondary"
              style={{
                padding: '6px 11px',
                fontSize: '0.76rem',
                borderColor: orientation.manualFlatOverride
                  ? 'hsla(78, 89%, 56%, 0.5)'
                  : undefined,
                color: orientation.manualFlatOverride ? 'var(--accent-lime)' : undefined,
              }}
              onClick={() => onToggleManualFlat(!orientation.manualFlatOverride)}
            >
              {orientation.manualFlatOverride ? 'Disable Flat Test Mode' : 'Bypass Flat Check (Test Mode)'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
