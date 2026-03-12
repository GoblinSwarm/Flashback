// src/replay/ReplayLifecycle.ts
// ======================================================
//
// ReplayLifecycle
// ---------------
//
// This module defines the lifecycle state machine used
// by ReplaySession instances.
//
// The lifecycle represents the runtime state of a replay
// attempt as it moves through preparation, playback,
// completion or failure.
//
// Typical lifecycle
// -----------------
//
//   idle
//    ↓
//   preparing
//    ↓
//   ready
//    ↓
//   playing
//    ↓
//   closed
//    ↓
//   disposed
//
// Error path:
//
//   preparing / ready / playing
//            ↓
//          error
//
// Architecture role
// -----------------
//
// ReplayLifecycle belongs to the **Replay Layer**.
//
// It provides:
//
// - lifecycle state definitions
// - lifecycle snapshot structure
// - transition helpers
//
// It is intentionally **pure and side-effect free**.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - defining replay lifecycle states
// - tracking lifecycle transitions
// - producing immutable lifecycle snapshots
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - manage replay sessions
// - perform playback
// - attach HTMLVideoElement
// - interact with MediaSource
// - manipulate UI
//
// Those responsibilities belong to:
//
//   ReplaySession
//   ReplaySessionManager
//   PlaybackRouter
//
// Design rule
// -----------
//
// Lifecycle snapshots are immutable.
// Each transition produces a new snapshot.
//

export type ReplayLifecycleState =
  | "idle"
  | "preparing"
  | "ready"
  | "playing"
  | "closed"
  | "disposed"
  | "error";

export type ReplayCloseReason =
  | "user_close"
  | "replaced_by_new_replay"
  | "playback_ended"
  | "playback_error"
  | "attach_failed"
  | "snapshot_invalid"
  | "internal_error"
  | "released";

export interface ReplayLifecycleSnapshot {
  state: ReplayLifecycleState;
  closeReason: ReplayCloseReason | null;
  errorMessage: string | null;
}

export function createInitialReplayLifecycle(): ReplayLifecycleSnapshot {
  return {
    state: "idle",
    closeReason: null,
    errorMessage: null,
  };
}

function isTerminalState(state: ReplayLifecycleState): boolean {
  return state === "disposed";
}

export function transitionReplayLifecycle(
  current: ReplayLifecycleSnapshot,
  nextState: ReplayLifecycleState
): ReplayLifecycleSnapshot {
  // Prevent transitions from disposed state
  if (isTerminalState(current.state)) {
    return current;
  }

  return {
    ...current,
    state: nextState,
  };
}

export function closeReplayLifecycle(
  current: ReplayLifecycleSnapshot,
  reason: ReplayCloseReason
): ReplayLifecycleSnapshot {
  if (isTerminalState(current.state)) {
    return current;
  }

  return {
    ...current,
    state: "closed",
    closeReason: reason,
  };
}

export function failReplayLifecycle(
  current: ReplayLifecycleSnapshot,
  message: string,
  reason: ReplayCloseReason = "internal_error"
): ReplayLifecycleSnapshot {
  if (isTerminalState(current.state)) {
    return current;
  }

  return {
    ...current,
    state: "error",
    closeReason: reason,
    errorMessage: message,
  };
}

export function disposeReplayLifecycle(
  current: ReplayLifecycleSnapshot
): ReplayLifecycleSnapshot {
  return {
    ...current,
    state: "disposed",
  };
}