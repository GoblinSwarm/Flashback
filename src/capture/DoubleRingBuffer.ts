// src/capture/DoubleRingBuffer.ts
// =================================
//
// DoubleRingBuffer
// ----------------
//
// This module implements a two-ring buffering system used by Flashback
// to capture streaming media chunks and produce stable snapshots for replay.
//
// Architecture
// ------------
// The buffer maintains two logical rings:
//
//   active  -> receives incoming chunks from the recorder
//   sealed  -> stable snapshot used by replay sessions
//
// Typical flow:
//
//   recorder pushes chunks → active ring
//
//   replay requested:
//       swap()
//           active  → sealed
//           sealed  → becomes new active (cleared)
//
//   snapshot builder reads sealed ring
//
// Key guarantees
// --------------
// - The sealed ring represents a stable snapshot of past media data.
// - The active ring continues receiving new chunks without affecting
//   the sealed snapshot.
// - The sealed ring cannot be swapped while it is locked by a replay session.
//
// Responsibilities
// ----------------
// This module is responsible ONLY for:
//
// - storing media chunks in a rolling window
// - managing two rings (active / sealed)
// - swapping the rings when a snapshot is needed
// - locking and unlocking the sealed ring during replay
// - exposing basic stats and ring accessors
//
// Non-responsibilities
// --------------------
// This module MUST NOT:
//
// - decide whether a snapshot is valid
// - perform replay fallback logic
// - interact with MediaSource / MSE
// - attach video elements
// - perform playback seeks
// - make decisions about replay lifecycle
//
// Those responsibilities belong to:
//
//   SnapshotBuilder
//   ReplaySessionManager
//   Playback layer
//
// Design rule
// -----------
// DoubleRingBuffer must remain a pure data structure.
// If replay logic starts appearing here, the architecture is being violated.
//
// Invariants
// ----------
// - active and sealed must never reference the same ring
// - swap() must never occur while sealed is locked
// - swap() always clears the new active ring
// - this module never decides replay validity or fallback policy

import { ChunkManager } from "./ChunkManager";

export type DoubleRingStats = {
  chunksCount: number;
  bytes: number;
  bufferedMs: number;
  hasInitBlob: boolean;
};

export type DoubleRingDebugState = {
  active: DoubleRingStats;
  sealed: DoubleRingStats;
  activeKey: "A" | "B";
  sealedKey: "A" | "B";
  sealedLockedBy: string | null;
  lastTimesliceMs: number;
};

export class DoubleRingBuffer {
  private readonly ringA: ChunkManager;
  private readonly ringB: ChunkManager;

  private active: ChunkManager;
  private sealed: ChunkManager;

  private activeKey: "A" | "B" = "A";
  private sealedKey: "A" | "B" = "B";

  private sealedLockedBy: string | null = null;
  private readonly debug: boolean;
  private lastTimesliceMs = 0;

  constructor(maxBufferMs: number, debug = false) {
    this.ringA = new ChunkManager(maxBufferMs, debug);
    this.ringB = new ChunkManager(maxBufferMs, debug);

    this.active = this.ringA;
    this.sealed = this.ringB;
    this.debug = !!debug;
  }

  public setLastTimesliceMs(ms: number): void {
    const value = Math.max(0, Math.trunc(Number(ms) || 0));
    this.lastTimesliceMs = value;

    this.ringA.setLastTimesliceMs(value);
    this.ringB.setLastTimesliceMs(value);
  }

  public getLastTimesliceMs(): number {
    return this.lastTimesliceMs;
  }

  public pushChunk(blob: Blob, nowMs: number): void {
    this.active.pushChunk(blob, nowMs);

    if (this.debug) {
      console.log("[Flashback][DoubleRing] pushChunk", {
        to: this.activeKey,
        bytes: blob.size,
        nowMs,
        active: this.getRingStats(this.active),
        sealed: this.getRingStats(this.sealed),
        sealedLockedBy: this.sealedLockedBy,
      });
    }
  }

  public swap(reason: string): boolean {
    if (this.sealedLockedBy) {
      if (this.debug) {
        console.warn("[Flashback][DoubleRing] swap blocked: sealed is locked", {
          reason,
          sealedLockedBy: this.sealedLockedBy,
          activeKey: this.activeKey,
          sealedKey: this.sealedKey,
          active: this.getRingStats(this.active),
          sealed: this.getRingStats(this.sealed),
        });
      }
      return false;
    }

    const oldActive = this.active;
    const oldSealed = this.sealed;
    const oldActiveKey = this.activeKey;
    const oldSealedKey = this.sealedKey;

    this.sealed = oldActive;
    this.sealedKey = oldActiveKey;

    this.active = oldSealed;
    this.activeKey = oldSealedKey;

    this.active.clear();
    this.active.setLastTimesliceMs(this.lastTimesliceMs);
    this.sealed.setLastTimesliceMs(this.lastTimesliceMs);

    if (this.debug) {
      console.log("[Flashback][DoubleRing] swap", {
        reason,
        newActiveKey: this.activeKey,
        newSealedKey: this.sealedKey,
        active: this.getRingStats(this.active),
        sealed: this.getRingStats(this.sealed),
      });
    }

    return true;
  }

  public lockSealed(ownerId: string): boolean {
    const normalizedOwner = String(ownerId || "").trim();
    if (!normalizedOwner) return false;

    if (this.sealedLockedBy === normalizedOwner) {
      return true;
    }

    if (this.sealedLockedBy && this.sealedLockedBy !== normalizedOwner) {
      if (this.debug) {
        console.warn("[Flashback][DoubleRing] lockSealed blocked: already locked", {
          ownerId: normalizedOwner,
          sealedLockedBy: this.sealedLockedBy,
          sealed: this.getRingStats(this.sealed),
        });
      }
      return false;
    }

    this.sealedLockedBy = normalizedOwner;

    if (this.debug) {
      console.log("[Flashback][DoubleRing] lockSealed", {
        ownerId: normalizedOwner,
        sealed: this.getRingStats(this.sealed),
      });
    }

    return true;
  }

  public unlockSealed(ownerId: string): boolean {
    const normalizedOwner = String(ownerId || "").trim();
    if (!normalizedOwner) return false;

    if (this.sealedLockedBy !== normalizedOwner) {
      if (this.debug) {
        console.warn("[Flashback][DoubleRing] unlockSealed ignored: owner mismatch", {
          ownerId: normalizedOwner,
          sealedLockedBy: this.sealedLockedBy,
        });
      }
      return false;
    }

    this.sealedLockedBy = null;

    if (this.debug) {
      console.log("[Flashback][DoubleRing] unlockSealed", {
        ownerId: normalizedOwner,
      });
    }

    return true;
  }

  public isSealedLocked(): boolean {
    return this.sealedLockedBy !== null;
  }

  public getSealedLockOwner(): string | null {
    return this.sealedLockedBy;
  }

  public getActiveManager(): ChunkManager {
    return this.active;
  }

  public getSealedManager(): ChunkManager {
    return this.sealed;
  }

  public clearAll(): void {
    this.ringA.clear();
    this.ringB.clear();

    this.active = this.ringA;
    this.sealed = this.ringB;

    this.activeKey = "A";
    this.sealedKey = "B";
    this.sealedLockedBy = null;

    this.ringA.setLastTimesliceMs(this.lastTimesliceMs);
    this.ringB.setLastTimesliceMs(this.lastTimesliceMs);

    if (this.debug) {
      console.log("[Flashback][DoubleRing] clearAll", {
        activeKey: this.activeKey,
        sealedKey: this.sealedKey,
        lastTimesliceMs: this.lastTimesliceMs,
      });
    }
  }

  public getDebugState(): DoubleRingDebugState {
    return {
      active: this.getRingStats(this.active),
      sealed: this.getRingStats(this.sealed),
      activeKey: this.activeKey,
      sealedKey: this.sealedKey,
      sealedLockedBy: this.sealedLockedBy,
      lastTimesliceMs: this.lastTimesliceMs,
    };
  }

  private getRingStats(ring: ChunkManager): DoubleRingStats {
    const chunks = ring.getChunks();
    const chunksCount = Array.isArray(chunks) ? chunks.length : 0;

    let bytes = Number(ring.getTotalBytes());
    let bufferedMs = Number(ring.getBufferedMs());

    if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
    if (!Number.isFinite(bufferedMs) || bufferedMs < 0) bufferedMs = 0;

    return {
      chunksCount,
      bytes,
      bufferedMs,
      hasInitBlob: !!ring.getInitCandidate(),
    };
  }
}