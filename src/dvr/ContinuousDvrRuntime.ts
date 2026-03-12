// src/dvr/ContinuousDvrRuntime.ts
// ======================================================
//
// ContinuousDvrRuntime
// --------------------
//
// This module wires together the continuous live DVR chain:
//
//   FlashbackRecorder
//        ↓
//   ContinuousDvrBridge
//        ↓
//   ContinuousDvrPipeline
//
// Architecture role
// -----------------
//
// ContinuousDvrRuntime belongs to the **DVR Layer**.
//
// It acts as the live wiring boundary between the capture
// layer and the downstream DVR consumers. Its purpose is
// to connect and disconnect the real-time chunk flow
// without embedding replay, playback, or UI logic.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - connecting the recorder live feed to the DVR bridge
// - connecting the DVR bridge to downstream DVR consumers
// - exposing explicit connect / disconnect lifecycle
// - clearing downstream DVR state when requested
// - exposing aggregated debug state for the live DVR chain
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - own replay session lifecycle
// - own playback lifecycle
// - own UI lifecycle
// - implement snapshot policy
// - implement MediaSource / SourceBuffer
// - implement recorder internals
// - implement DVR buffering internals
//
// Those responsibilities belong to:
//
//   FlashbackRecorder
//   ContinuousDvrBridge
//   ContinuousDvrPipeline
//   ContinuousDvrEngine
//   Snapshot layer
//   Replay layer
//   Playback layer
//
// Design rule
// -----------
//
// ContinuousDvrRuntime is wiring only.
//
// If replay policy, playback logic, snapshot construction,
// or DVR buffer business rules start accumulating here,
// the architecture is being violated.
//

import {
  FlashbackRecorder,
  type OnChunkCallback,
} from "../capture/FlashbackRecorder";
import { ContinuousDvrBridge } from "./ContinuousDvrBridge";
import { ContinuousDvrPipeline } from "./ContinuousDvrPipeline";
import { ContinuousDvrEngine } from "./ContinuousDvrEngine";

export type ContinuousDvrRuntimeDebugState = {
  isConnected: boolean;
  recorder: ReturnType<FlashbackRecorder["getDebugState"]>;
  bridge: ReturnType<ContinuousDvrBridge["getDebugState"]>;
  pipeline: ReturnType<ContinuousDvrPipeline["getDebugState"]>;
  engine: ReturnType<ContinuousDvrEngine["getDebugState"]> | null;
};

export class ContinuousDvrRuntime {
  private isConnected = false;
  private liveListener: OnChunkCallback | null = null;

  constructor(
    private readonly recorder: FlashbackRecorder,
    private readonly bridge: ContinuousDvrBridge,
    private readonly pipeline: ContinuousDvrPipeline,
    private readonly engine: ContinuousDvrEngine | null = null,
    private readonly debug = false
  ) {}

  private log(...args: unknown[]): void {
    if (!this.debug) {
      return;
    }

    console.log("[Flashback][ContinuousDvrRuntime]", ...args);
  }

  public connect(): void {
    if (this.isConnected) {
      this.log("connect ignored: already connected");
      return;
    }

    this.bridge.setConsumer((blob, info) => {
      // Important architectural change:
      // live ingest must feed the canonical DVR pipeline only.
      //
      // The replay engine must NOT receive the same live chunks directly here,
      // because doing so mixes:
      //
      // - live ingest timing
      // - replay attach / rebuild timing
      //
      // That overlap can corrupt the replay engine timeline and produce
      // demuxer ordering failures during continuous DVR replay attach.
      //
      // The engine should instead be rebuilt explicitly from a coherent
      // pipeline snapshot at replay-attach time.
      this.pipeline.pushBlob(blob, info);
    });

    const listener: OnChunkCallback = (blob, perfNowMs, info) => {
      if (!blob || blob.size <= 0) {
        return;
      }

      if (!info) {
        return;
      }

      const forwardedInfo = {
        ...info,
        timestampMs:
          Number.isFinite(perfNowMs) && perfNowMs >= 0 ? perfNowMs : undefined,
      };

      this.bridge.ingest(blob, forwardedInfo);
    };

    this.liveListener = listener;
    this.recorder.setOnChunkListener(listener);
    this.isConnected = true;

    this.log("connected", {
      state: this.getDebugState(),
      liveFeedsEngineDirectly: false,
    });
  }

  public disconnect(): void {
    if (!this.isConnected) {
      this.log("disconnect ignored: not connected");
      return;
    }

    // Important:
    // disconnect() only detaches the live flow wiring.
    // It does NOT clear downstream DVR state by itself.
    // Explicit state reset belongs to clearPipeline().
    this.recorder.setOnChunkListener(null);
    this.bridge.setConsumer(null);
    this.bridge.clear();

    this.liveListener = null;
    this.isConnected = false;

    this.log("disconnected", {
      state: this.getDebugState(),
    });
  }

  public clearPipeline(): void {
    this.bridge.clear();
    this.pipeline.clear();

    if (this.engine) {
      this.engine.clear();
    }

    this.log("pipeline cleared", {
      state: this.getDebugState(),
    });
  }

  public getPipeline(): ContinuousDvrPipeline {
    return this.pipeline;
  }

  public getEngine(): ContinuousDvrEngine | null {
    return this.engine;
  }

  public getDebugState(): ContinuousDvrRuntimeDebugState {
    return {
      isConnected: this.isConnected,
      recorder: this.recorder.getDebugState(),
      bridge: this.bridge.getDebugState(),
      pipeline: this.pipeline.getDebugState(),
      engine: this.engine ? this.engine.getDebugState() : null,
    };
  }
}