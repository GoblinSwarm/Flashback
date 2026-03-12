// src/replay/ReplaySessionManager.ts
// ======================================================
//
// ReplaySessionManager
// --------------------
//
// This module owns the currently active replay session.
//
// Architecture role
// -----------------
//
// ReplaySessionManager belongs to the **Replay Layer**.
//
// It is responsible for keeping track of the currently
// active replay session and enforcing single-session
// ownership across the replay runtime.
//
// Typical flow
// ------------
//
//   ReplaySnapshotSource
//          ↓
//   ReplaySession
//          ↓
//   ReplaySessionManager
//          ↓
//   ReplayCoordinator / Playback layer
//
// Important boundary
// ------------------
//
// ReplaySessionManager owns **session ownership**, not
// **session creation**, **session attach**, or **session
// trigger policy**.
//
// In this architecture:
//
// - `FlashbackController`    = creates replay sessions
// - `ReplaySessionManager`   = owns the active session slot
// - `ReplayCoordinator`      = attaches the session
// - `FlashbackContentRuntime` = triggers/orchestrates top-level flow
//
// This distinction must remain explicit.
//
// If replay creation, attach logic, playback policy, or
// top-level trigger policy starts appearing here, this
// file will overlap with:
//
// - `FlashbackController`
// - `ReplayCoordinator`
// - `FlashbackContentRuntime`
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - storing the current active replay session
// - replacing the previous session when a new one appears
// - disposing the active session when cleared or released
// - enforcing single active replay ownership
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - build replay snapshot sources
// - decide replay source policy
// - implement playback
// - attach HTMLVideoElement
// - interact with MediaSource
// - own UI lifecycle
// - trigger replay creation by itself
// - decide when the user should request replay
// - decide video-change/source-loss behavior
//
// Those responsibilities belong to:
//
//   SnapshotBuilder
//   FlashbackController
//   ReplayCoordinator
//   PlaybackRouter
//   BlobPlayer / MsePlayer
//   FlashbackContentRuntime
//   UI layer
//
// Design rule
// -----------
//
// ReplaySessionManager manages ownership only.
//
// If snapshot construction, playback policy, attach logic,
// replay triggering policy, or UI logic starts appearing
// here, the architecture is being violated.
//
// Maintenance note
// ----------------
//
// If a future feature sounds like:
//
// - "create a replay when user presses X"
// - "close replay because source video changed"
// - "attach replay to the visible video"
// - "choose how replay should be played"
//
// then that logic does NOT belong here.
// It belongs in:
//
//   `FlashbackContentRuntime`
//   `FlashbackController`
//   `ReplayCoordinator`
//   `PlaybackRouter`
//
// Ownership note
// --------------
//
// This module answers questions like:
//
// - what is the current active replay session?
// - should the previous one be replaced?
// - should the active one be released/disposed?
//
// It does NOT answer:
//
// - should a replay be created?
// - should playback start?
// - what video should be used?
//
// src/replay/ReplaySessionManager.ts

import { ReplaySession, type ReplayCloseReason } from "./ReplaySession";

function isSessionTerminal(session: ReplaySession | null): boolean {
  if (!session) return true;
  if (session.isDisposed()) return true;
  if (session.isClosed()) return true;
  if (session.isErrored()) return true;
  return false;
}

function finalizeSession(
  session: ReplaySession | null,
  closeReason: ReplayCloseReason
): void {
  if (!session) return;

  if (!session.isDisposed()) {
    if (!session.isClosed() && !session.isErrored()) {
      session.close(closeReason);
    }

    session.dispose();
  }
}

export class ReplaySessionManager {
  private activeSession: ReplaySession | null = null;

  public getActiveSession(): ReplaySession | null {
    const session = this.activeSession;

    if (isSessionTerminal(session)) {
      this.activeSession = null;
      return null;
    }

    return session;
  }

  public hasActiveSession(): boolean {
    return this.getActiveSession() !== null;
  }

  public replaceActiveSession(nextSession: ReplaySession): ReplaySession | null {
    const previousSession = this.activeSession;

    if (previousSession === nextSession) {
      return previousSession;
    }

    finalizeSession(previousSession, "replaced_by_new_replay");

    this.activeSession = nextSession;
    return previousSession;
  }

  public clearActiveSession(): void {
    const session = this.activeSession;
    if (!session) return;

    finalizeSession(session, "user_close");
    this.activeSession = null;
  }

  public releaseSession(session: ReplaySession): void {
    if (this.activeSession !== session) return;

    finalizeSession(this.activeSession, "released");
    this.activeSession = null;
  }
}