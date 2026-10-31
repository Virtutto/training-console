# Training Console - overtime stopwatch + smooth timer ring

Date: 2026-10-31
Status: approved by Adam, implemented as v8.5

## Why

Two asks from Adam after v8.4 shipped:

1. Timed holds often run past the prescribed time. He wants a stopwatch that
   starts counting the moment the target time is reached, purely as a logging
   aid. It must NOT be logged automatically - he is still asked how long the
   hold was, as always.
2. The timer circle moves in one-second jumps. He wants it smooth.

## 1. Overtime stopwatch

### Behaviour

- Applies to timed work holds only (`cur.type === "time"` with `duration > 0`).
  Windup, rest, rep sets and the calibration timer are unchanged.
- When the hold countdown reaches zero: the existing triple beep fires, the
  session enters a new phase `overtime`, and a stopwatch starts at zero.
- Ring: full, amber `#ffb547` with an amber glow; the middle shows the
  count-up seconds and the label `OVERTIME`.
- Controls during overtime: PAUSE / RESUME freezes the stopwatch, STOP ends it.
  SKIP behaves as STOP.
- STOP lands on the normal `logSet` screen. The seconds field is pre-filled
  with target + overtime (20s target + 7s over = 27) and remains editable.
  The panel shows the breakdown: held 20s + 7s over.
- Nothing is written to the set log until a difficulty is chosen. The
  pre-filled number is a suggestion, not a recording.
- The stopwatch is timestamp-driven (`overtimeStart`, `overtimePausedAt`), not
  tick-driven, so a backgrounded tab or a locked screen reports the honest
  number on return. No cap and no auto-stop.

### Consequence: the clamp goes

`recordSetLog` currently clamps a logged hold with `Math.min(v, cur.duration)`
and the input carries `max = duration + 10`. An overtime log is worthless if
it cannot record more than the target, so the clamp is removed and the field
accepts any non-negative value.

### State

| Field | Meaning |
|---|---|
| `state.overtimeStart` | epoch ms when the stopwatch began, shifted on resume |
| `state.overtimePausedAt` | epoch ms when paused, null while running |
| `state.overtimeSeconds` | whole seconds elapsed, refreshed by the tick |
| `state.overtimeMeasured` | target + overtime, pre-fill for the log field |
| `state.overtimeOver` | seconds beyond target, shown in the log panel |

`overtimeMeasured` / `overtimeOver` are cleared in `recordSetLog` so the next
set cannot inherit a stale pre-fill.

### Progress

`sessionProgressPercent` treats `overtime` like `logSet`: the current step
counts as completed (fraction 1).

## 2. Smooth timer ring

### Root cause

`ringSVG` positions the arc from `1 - state.secondsLeft / ringMax`, where
`secondsLeft` is a whole number, and the circle carries
`transition: stroke-dashoffset 1s linear`. `runTimer` re-renders every 250ms,
replacing the node and restarting that transition. The result is one snap per
second, four times over.

### Fix

- `ringSVG` emits stable ids: `ringArc` on the progress circle and `ringNum` on
  the centre number. The CSS transition is removed from the arc.
- `applyRingFrame()` computes fractional progress from `state.phaseEndTime`
  (windup / work / rest) and writes `stroke-dashoffset` directly, so the arc
  sweeps continuously. Overtime is a static full ring.
- `startRingAnimation()` runs `applyRingFrame` inside `requestAnimationFrame`;
  `render()` restarts it for the active view and stops it for every other view.
  Paused frames are skipped. If `requestAnimationFrame` is unavailable the app
  keeps the existing 250ms tick as a fallback.
- Digits still change once per second - that is the point of a countdown - but
  the arc no longer waits for them.

## Testing

New `tests/overtime.test.js` (behavioural, boots the real inline script):

- a timed hold reaching zero enters `overtime`, not `logSet`
- nothing is written to the set log during overtime or on STOP
- STOP sets `overtimeMeasured` to target + elapsed and phase to `logSet`
- the log field is pre-filled with that total, with no `max` clamp, and the
  breakdown is rendered
- `recordSetLog` stores a duration above the target
- a rep set never enters overtime
- `sessionProgressPercent` counts overtime as a completed step
- PAUSE freezes the stopwatch; RESUME continues it without losing time

New `tests/ring-smooth.test.js`:

- `ringSVG` exposes `ringArc` and carries no CSS transition on the arc
- a mid-second frame writes a fractional dashoffset (not a whole-second value)
- a paused or overtime frame leaves the arc at its expected position
- `startRingAnimation` / `stopRingAnimation` are defined and cancel cleanly

All existing suites must stay green: plan, progress, lockd-sync,
calib-variant, difficulty-normal. Version bumps to v8.5.
