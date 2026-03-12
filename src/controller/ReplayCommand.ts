// src/controller/ReplayCommand.ts
// ======================================================
//
// ReplayCommand
// -------------
//
// This module defines the command object used to request
// a replay operation from the FlashbackController.
//
// Architecture role
// -----------------
//
// ReplayCommand belongs to the **Controller Layer**.
//
// It acts as a simple command/data transfer object
// describing a replay request issued by higher layers.
//
// Typical flow
// ------------
//
//   UI / ContentRuntime
//        ↓
//   ReplayCommand
//        ↓
//   FlashbackController
//        ↓
//   SnapshotBuilder
//        ↓
//   ReplaySession
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - defining the structure of a replay request
// - transporting replay parameters to the controller
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - build replay sources
// - access DVR state
// - create sessions
// - perform playback
// - interact with UI
//
// Those responsibilities belong to:
//
//   FlashbackController
//   SnapshotBuilder
//   ReplaySessionManager
//   Playback layer
//
// Design rule
// -----------
//
// ReplayCommand must remain a simple immutable data
// structure describing a replay request.
//

export interface ReplayCommand {
  seconds: number;
  traceId?: string | null;
}