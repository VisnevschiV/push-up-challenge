import React, { useState } from 'react';
import type { ChallengePlanId, ChallengeState } from '../services/challengeStore';
import {
  addDaysToKey,
  CHALLENGE_PLANS,
  getTodayChallengeInfo,
  toLocalDateKey,
} from '../services/challengeStore';

interface ChallengeViewProps {
  state: ChallengeState;
  onChangePlan: (planId: ChallengePlanId, customGoal?: number) => void;
  onResetStartDate: () => void;
  onAddManualSet: (reps: number) => void;
  onDeleteSession: (id: string) => void;
}

export const ChallengeView: React.FC<ChallengeViewProps> = ({
  state,
  onChangePlan,
  onResetStartDate,
  onAddManualSet,
  onDeleteSession,
}) => {
  const [selectedDayIndex, setSelectedDayIndex] = useState<number | null>(null);
  const [manualReps, setManualReps] = useState(20);

  const todayKey = toLocalDateKey();
  const info = getTodayChallengeInfo(state, todayKey);
  const activePlan = CHALLENGE_PLANS[state.planId];

  const inspectedDay = selectedDayIndex ?? info.currentDayNumber;
  const inspectedDateKey = addDaysToKey(state.startDateKey, inspectedDay - 1);
  const inspectedTarget = activePlan.getTargetForDay(inspectedDay, state.customDailyGoal);
  const inspectedDone = info.dailyTotals[inspectedDateKey] ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Lifetime Stats */}
      <div className="stat-strip">
        <div className="stat-box">
          <span className="eyebrow">Total Reps</span>
          <div className="stat-value" style={{ color: 'var(--accent-lime)' }}>
            {info.totalLifetimeReps}
          </div>
        </div>
        <div className="stat-box">
          <span className="eyebrow">Best Set</span>
          <div className="stat-value">{info.bestSingleSet}</div>
        </div>
        <div className="stat-box">
          <span className="eyebrow">Streak</span>
          <div className="stat-value">{info.streak}d</div>
        </div>
      </div>

      {/* 30-Day Challenge Matrix */}
      <section className="surface-plate" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div>
            <span className="eyebrow">30-Day Roadmap</span>
            <h2
              style={{
                margin: '2px 0 0',
                fontFamily: 'var(--font-display)',
                fontSize: '1.25rem',
                letterSpacing: '-0.02em',
              }}
            >
              {activePlan.name}
            </h2>
          </div>
          <button
            type="button"
            id="btn-restart-day1"
            onClick={onResetStartDate}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.72rem',
              color: 'var(--text-secondary)',
              textDecoration: 'underline',
            }}
          >
            Set Today = Day 1
          </button>
        </div>

        <div className="challenge-grid-30" role="list" aria-label="30-day challenge calendar">
          {Array.from({ length: 30 }, (_, idx) => {
            const dayNum = idx + 1;
            const dateKey = addDaysToKey(state.startDateKey, idx);
            const target = activePlan.getTargetForDay(dayNum, state.customDailyGoal);
            const done = info.dailyTotals[dateKey] ?? 0;
            const isToday = dateKey === todayKey;
            const isCompleted = done >= target;
            const isPartial = done > 0 && done < target;

            return (
              <button
                key={dayNum}
                type="button"
                id={`challenge-day-${dayNum}`}
                onClick={() => setSelectedDayIndex(dayNum)}
                className={`day-cell ${isToday ? 'today' : ''} ${
                  isCompleted ? 'completed' : isPartial ? 'partial' : ''
                }`}
                style={{
                  outline:
                    inspectedDay === dayNum ? '1.5px solid var(--accent-lime)' : undefined,
                }}
              >
                <span className="day-num">D{dayNum}</span>
                <span className="day-target">{isCompleted ? '✓' : target}</span>
              </button>
            );
          })}
        </div>

        {/* Inspected day detail bar */}
        <div
          className="recessed-well"
          style={{
            padding: '10px 14px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '0.84rem',
          }}
        >
          <span>
            <strong>Day {inspectedDay}</strong> ({inspectedDateKey})
          </span>
          <span className="tabular-nums" style={{ fontFamily: 'var(--font-mono)' }}>
            {inspectedDone} / {inspectedTarget} reps
          </span>
        </div>
      </section>

      {/* Program Switcher */}
      <section className="surface-plate" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span className="eyebrow">Challenge Program</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {(Object.keys(CHALLENGE_PLANS) as ChallengePlanId[]).map((pid) => {
            const p = CHALLENGE_PLANS[pid];
            const selected = state.planId === pid;
            return (
              <button
                key={pid}
                type="button"
                id={`plan-${pid}`}
                onClick={() => onChangePlan(pid)}
                className="recessed-well"
                style={{
                  padding: '11px 12px',
                  textAlign: 'left',
                  borderColor: selected ? 'var(--accent-lime)' : undefined,
                  background: selected ? 'var(--accent-lime-soft)' : undefined,
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: '0.88rem',
                    color: selected ? 'var(--accent-lime)' : 'var(--text-primary)',
                  }}
                >
                  {p.name}
                </div>
                <div style={{ fontSize: '0.73rem', color: 'var(--text-secondary)', marginTop: 3 }}>
                  {p.tagline}
                </div>
              </button>
            );
          })}
        </div>

        {state.planId === 'custom' && (
          <div style={{ marginTop: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem', marginBottom: 6 }}>
              <span>Custom Daily Quota</span>
              <strong className="tabular-nums">{state.customDailyGoal} push-ups / day</strong>
            </div>
            <input
              type="range"
              id="slider-custom-daily-goal"
              min={10}
              max={250}
              step={5}
              value={state.customDailyGoal}
              onChange={(e) => onChangePlan('custom', Number(e.target.value))}
            />
          </div>
        )}
      </section>

      {/* Quick Manual Log & Recent Sets */}
      <section className="surface-plate" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span className="eyebrow">Quick Log &amp; Recent Sets</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setManualReps((r) => Math.max(5, r - 5))}
          >
            −5
          </button>
          <div
            className="recessed-well tabular-nums"
            style={{
              flex: 1,
              textAlign: 'center',
              padding: '10px 8px',
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
            }}
          >
            {manualReps} reps
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setManualReps((r) => r + 5)}
          >
            +5
          </button>
          <button
            type="button"
            id="btn-add-manual-reps"
            className="btn-secondary"
            style={{ borderColor: 'hsla(78, 89%, 56%, 0.45)', color: 'var(--accent-lime)' }}
            onClick={() => onAddManualSet(manualReps)}
          >
            + Log Set
          </button>
        </div>

        {state.sessions.length === 0 ? (
          <p style={{ margin: '4px 0 0', fontSize: '0.84rem', color: 'var(--text-muted)' }}>
            No sets recorded yet. Place your phone on the floor and start your first set!
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            {state.sessions
              .slice()
              .reverse()
              .slice(0, 8)
              .map((s) => {
                const timeStr = new Date(s.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                });
                return (
                  <div
                    key={s.id}
                    className="recessed-well"
                    style={{
                      padding: '10px 12px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <span
                        className="tabular-nums"
                        style={{
                          fontFamily: 'var(--font-display)',
                          fontWeight: 700,
                          fontSize: '1rem',
                          color: 'var(--accent-lime)',
                        }}
                      >
                        {s.reps} reps
                      </span>
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: '0.76rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {s.dateKey} · {timeStr} · {s.mode === 'manual' ? 'Manual' : 'Camera'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => onDeleteSession(s.id)}
                      aria-label={`Delete ${s.reps} rep session`}
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                        padding: '4px 8px',
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
          </div>
        )}
      </section>
    </div>
  );
};
