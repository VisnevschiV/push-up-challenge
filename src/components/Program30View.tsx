import React, { useState } from 'react';
import type { ChallengeState, PrescribedWorkout } from '../services/challengeStore';
import { build30DayProgram, computeDashboardMetrics } from '../services/challengeStore';

interface Program30ViewProps {
  state: ChallengeState;
  onStartProgramDay: (workout: PrescribedWorkout) => void;
  onStartMaxTest: () => void;
}

export const Program30View: React.FC<Program30ViewProps> = ({
  state,
  onStartProgramDay,
  onStartMaxTest,
}) => {
  const schedule = build30DayProgram(state);
  const [selectedDay, setSelectedDay] = useState<number>(state.activeProgramDay);

  const activeDayObj =
    schedule.find((d) => d.dayNumber === selectedDay) ??
    schedule.find((d) => !d.isRestDay) ??
    schedule[0];

  const completedTrainingCount = state.completedProgramDays.filter(
    (d) => d % 4 !== 0
  ).length;

  const metrics = computeDashboardMetrics(state);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Top Program Day Card */}
      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="card-label">30-DAY ADAPTIVE LADDER</span>
          <span
            className="mono-num"
            style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--lime)' }}
          >
            🏆 {completedTrainingCount}/23
          </span>
        </div>

        {state.baselineMax === null && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 13px',
              borderRadius: 12,
              background: 'var(--amber-tint)',
              border: '1px solid var(--amber-border)',
              fontSize: '0.8rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <span>Previewing default plan — test your max first to calibrate sets!</span>
            <button
              type="button"
              className="btn-outline"
              style={{ padding: '5px 10px', fontSize: '0.76rem', flexShrink: 0 }}
              onClick={onStartMaxTest}
            >
              Test Max
            </button>
          </div>
        )}

        <h2 style={{ margin: '10px 0 4px', fontSize: '1.45rem', fontWeight: 800 }}>
          {activeDayObj.isRestDay
            ? `Day ${activeDayObj.dayNumber}: Active Recovery`
            : `Day ${activeDayObj.dayNumber}: ${activeDayObj.totalMinReps}+ Pushups`}
        </h2>

        <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
          {activeDayObj.isRestDay
            ? 'Rest & shoulder mobility day — let your chest and triceps supercompensate.'
            : `Structured sets: ${activeDayObj.label} reps (${activeDayObj.restSeconds}s rest between sets)`}
        </div>

        {/* Clear Goal Bar */}
        <div
          style={{
            background: 'var(--bg-card-inner)',
            borderRadius: 13,
            padding: '11px 14px',
            marginBottom: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '0.76rem',
              color: 'var(--text-secondary)',
              marginBottom: 6,
            }}
          >
            <span>
              Baseline Max: <strong style={{ color: 'var(--text-primary)' }}>{state.baselineMax ?? '—'}</strong>
            </span>
            <span>
              Clear Goal: <strong style={{ color: 'var(--lime)' }}>{metrics.milestoneGoal} unbroken</strong>
            </span>
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 99,
              background: '#0e1114',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, Math.round((metrics.bestSetPR / Math.max(1, metrics.milestoneGoal)) * 100))}%`,
                background: 'var(--lime)',
                borderRadius: 99,
              }}
            />
          </div>
        </div>

        {!activeDayObj.isRestDay && (
          <button
            type="button"
            id="btn-start-program-day"
            className="cta-lime"
            onClick={() => onStartProgramDay(activeDayObj)}
          >
            ▶ Start Day {activeDayObj.dayNumber} ({activeDayObj.sets.join('-')}+)
          </button>
        )}
      </section>

      {/* 30-Day 5-Column Schedule Matrix */}
      <section className="card">
        <span className="card-label" style={{ display: 'block', marginBottom: 14 }}>
          30-DAY SCHEDULE (TAP ANY ACTIVE DAY TO TRAIN)
        </span>

        <div className="schedule-grid-5">
          {schedule.map((item) => {
            const isSelected = item.dayNumber === selectedDay;
            const isCompleted = state.completedProgramDays.includes(item.dayNumber);

            return (
              <button
                key={item.dayNumber}
                type="button"
                id={`sched-day-${item.dayNumber}`}
                className={`sched-tile ${isSelected ? 'active' : ''} ${
                  isCompleted ? 'done' : ''
                } ${item.isRestDay ? 'rest' : ''}`}
                onClick={() => setSelectedDay(item.dayNumber)}
              >
                <span className="sched-day-lbl">D{item.dayNumber}</span>
                <span className="sched-val-lbl">
                  {item.isRestDay
                    ? 'REST'
                    : isCompleted
                      ? `✓${item.totalMinReps}`
                      : item.totalMinReps}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
};
