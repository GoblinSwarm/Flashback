// src/replay/ReplayMode.ts
// ======================================================
//
// ReplayMode
// ----------
//
// This module defines the runtime replay mode used by
// ReplaySession.
//
// Architecture role
// -----------------
//
// ReplayMode belongs to the **Replay Layer**.
//
// It exists to express how a replay session should be
// executed at runtime.
//
// Current direction
// -----------------
//
// Flashback uses **continuous DVR** as the primary replay
// path.
//
// Snapshot-based replay is considered fallback behavior
// only, and should never be the default conceptual model.
//
// Design rule
// -----------
//
// ReplayMode is a routing/runtime concern.
//
// It must remain simple and explicit.
//
// If mode-specific playback logic starts appearing here,
// the architecture is being violated.
//

export type ReplayMode =
  | "continuous_dvr"
  | "snapshot_fallback";