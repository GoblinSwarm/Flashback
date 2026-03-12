// src/controller/FlashbackController.ts
// ======================================================
//
// FlashbackController
// -------------------
//
// This module is the high-level coordinator for replay
// creation requests.
//
// Architecture role
// -----------------
//
// FlashbackController belongs to the **Controller Layer**.
//
// It orchestrates replay creation by delegating to:
//
//   ReplayCommand
//        ↓
//   ReplaySession
//        ↓
//   ReplaySessionManager
//
// Important boundary
// ------------------
//
// FlashbackController is responsible for **creating**
// replay sessions, not for **attaching** or **playing**
// them.
//
// In this architecture:
//
// - `FlashbackController` = create replay session
// - `ReplayCoordinator`   = attach session to playback/UI target
//
// This distinction is important.
//
// If attach/playback lifecycle starts happening here,
// this file will begin to overlap with `ReplayCoordinator`.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - receiving replay commands
// - creating replay identities
// - creating ReplaySession instances
// - delegating session ownership to ReplaySessionManager
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - own recording lifecycle
// - own DVR pipeline state
// - attach playback directly
// - interact with UI directly
// - implement playback attach lifecycle
// - decide target video attachment behavior
//
// Those responsibilities belong to:
//
//   FlashbackRecorder
//   ContinuousDvrPipeline
//   ReplayCoordinator
//   Playback layer
//   UI layer
//
// Design rule
// -----------
//
// FlashbackController coordinates replay session creation
// only.
//
// If capture logic, DVR state logic, attach logic, UI
// logic, or playback policy starts appearing here, the
// architecture is being violated.
//
// Maintenance note
// ----------------
//
// If a future feature sounds like:
//
// - "attach this replay to the visible video"
// - "mark the replay as playing"
// - "handle attach failures"
// - "choose how playback should be started"
//
// then that logic does NOT belong here.
// It belongs in:
//
//   `ReplayCoordinator`
//   `PlaybackRouter`
//   `BlobPlayer` / `MsePlayer`
//
// Lifecycle note
// --------------
//
// Replay lifecycle should begin here only in the sense
// that a ReplaySession is created.
//
// The attach/playback-specific lifecycle transitions
// (`preparing`, `ready`, `playing`, `attach_failed`, etc.)
// should be driven by `ReplayCoordinator`, because that
// is where attach actually happens.
//

import type { ReplayCommand } from "./ReplayCommand";
import { ReplaySession } from "../replay/ReplaySession";
import { ReplaySessionManager } from "../replay/ReplaySessionManager";
import type { ReplayMode } from "../replay/ReplayMode";

function createReplayId(): string {
  return `replay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveReplayMode(): ReplayMode {
  return "continuous_dvr";
}

export class FlashbackController {
  constructor(private readonly replaySessionManager: ReplaySessionManager) {}

  public async requestReplay(command: ReplayCommand): Promise<ReplaySession> {
    const replayId = createReplayId();
    const replayMode = resolveReplayMode();

    const requestedDurationMs = Math.max(
      0,
      Math.trunc(Number(command.seconds) * 1000)
    );

    const session = new ReplaySession({
      replayId,
      mode: replayMode,
      offsetMs: requestedDurationMs,
      requestedDurationMs,
      fallbackAllowed: true,
    });

    // Important:
    // session ownership is established here, but playback attach
    // has NOT happened yet. Do not advance attach/play lifecycle here.
    this.replaySessionManager.replaceActiveSession(session);

    return session;
  }

  public closeActiveReplay(): void {
    this.replaySessionManager.clearActiveSession();
  }

  public getActiveReplay(): ReplaySession | null {
    return this.replaySessionManager.getActiveSession();
  }
}