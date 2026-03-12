// src/ui/UIOrchestrator.ts
// =======================
//
// UIOrchestrator
// --------------
//
// This module owns the minimal DOM orchestration for the replay UI.
//
// It is responsible for creating and wiring the visual container
// used by the replay playback layer. It does NOT implement playback
// logic, replay lifecycle, or DVR decisions.
//
// Architecture role
// -----------------
// UIOrchestrator belongs to the UI layer.
//
// It sits below the ReplayCoordinator and provides the DOM elements
// needed for playback rendering.
//
// Typical flow
// ------------
// ReplayCoordinator
//        ↓
//   UIOrchestrator
//        ↓
//   ReplayRoot (DOM container)
//        ├─ headerHost
//        │    ↓
//        │ ReplayHeader
//        │
//        ├─ videoHost
//        │    ↓
//        │ ReplayVideo (HTMLVideoElement)
//        │
//        └─ controlsHost
//             ↓
//        ReplayControls
//
//
// Responsibilities
// ----------------
// This module is responsible ONLY for:
//
// - creating the replay DOM root container
// - creating the replay header element
// - creating the replay video element
// - creating the replay controls
// - mounting header, video, and controls into their corresponding hosts
// - wiring minimal DOM-level control events to the video element
// - wiring minimal shell presentation controls
// - wiring header close behavior
// - exposing references to DOM elements
// - exposing minimal UI visibility controls for replay rendering
//
// Key guarantees
// --------------
// - the replay root exists exactly once
// - the replay header exists exactly once
// - the replay video element exists exactly once
// - the replay controls exist exactly once
// - the header is always mounted inside the header host
// - the video is always mounted inside the video host
// - the controls are always mounted inside the controls host
// - callers receive stable DOM references
//
// Non-responsibilities
// --------------------
// This module MUST NOT:
//
// - attach MediaSource
// - manage replay sessions
// - control playback start/stop internals beyond DOM-level UI actions
// - resolve which video should replay
// - read DVR state
// - control recorder state
//
// Those responsibilities belong to:
//
//   ReplayCoordinator
//   ReplaySessionManager
//   DvrEngine
//   Playback layer
//
// Design rule
// -----------
// UIOrchestrator must remain a very thin DOM composition layer.
// If replay policy, DVR logic, or playback orchestration appears here,
// the architecture is being violated.
//

import { ReplayRoot } from "./ReplayRoot";
import { ReplayHeader } from "./ReplayHeader";
import { ReplayVideo } from "./ReplayVideo";
import { ReplayControls } from "./ReplayControls";
import { DragManager } from "./DragManager";

export class UIOrchestrator {
  private readonly replayRoot: ReplayRoot;
  private readonly replayHeader: ReplayHeader;
  private readonly replayVideo: ReplayVideo;
  private readonly replayControls: ReplayControls;
  private readonly dragManager: DragManager;

  private isShellMaximized = false;
  private isUserSeeking = false;

  constructor() {
    this.replayRoot = new ReplayRoot();
    this.replayHeader = new ReplayHeader();
    this.replayVideo = new ReplayVideo();
    this.replayControls = new ReplayControls();
    this.dragManager = new DragManager({
      handleElement: this.replayHeader.getDragHandleElement(),
      targetElement: this.replayRoot.getShellElement(),
    });

    this.mountUi();
    this.bindControls();
    this.applyNormalShellLayout();
    this.dragManager.enable();

    // Start hidden until a replay session explicitly requests visibility.
    this.hideReplay();
  }

  private mountUi(): void {
    this.replayRoot.mountHeader(this.replayHeader.getElement());
    this.replayRoot.mountVideo(this.replayVideo.getElement());
    this.replayRoot.mountControls(this.replayControls.getElement());
  }

  private bindControls(): void {
    const video = this.replayVideo.getElement();
    const shell = this.replayRoot.getShellElement();

    const closeButton = this.replayHeader.getCloseButton();
    const playButton = this.replayControls.getPlayButton();
    const pauseButton = this.replayControls.getPauseButton();
    const seekInput = this.replayControls.getSeekInput();
    const maximizeButton = this.replayControls.getMaximizeButton();

    closeButton.addEventListener("click", () => {
      this.hideReplay();
    });

    playButton.addEventListener("click", () => {
      void video.play().catch(() => {
        // Best-effort UI action.
      });
    });

    pauseButton.addEventListener("click", () => {
      video.pause();
    });

    const beginUserSeek = (): void => {
      this.isUserSeeking = true;
    };

    const endUserSeek = (): void => {
      this.isUserSeeking = false;
      this.syncSeekFromVideo();
    };

    seekInput.addEventListener("pointerdown", beginUserSeek);
    seekInput.addEventListener("mousedown", beginUserSeek);
    seekInput.addEventListener("touchstart", beginUserSeek, { passive: true });

    seekInput.addEventListener("pointerup", endUserSeek);
    seekInput.addEventListener("mouseup", endUserSeek);
    seekInput.addEventListener("touchend", endUserSeek);
    seekInput.addEventListener("change", endUserSeek);
    seekInput.addEventListener("blur", endUserSeek);

    seekInput.addEventListener("input", () => {
      const duration = video.duration;
      const value = Number(seekInput.value);

      if (!Number.isFinite(duration) || duration <= 0) return;
      if (!Number.isFinite(value)) return;

      const nextTime = (value / 1000) * duration;
      video.currentTime = Math.max(0, Math.min(duration, nextTime));
    });

    maximizeButton.addEventListener("click", () => {
      this.isShellMaximized = !this.isShellMaximized;

      if (this.isShellMaximized) {
        this.applyMaximizedShellLayout(shell);
      } else {
        this.applyNormalShellLayout(shell);
      }
    });

    video.addEventListener("loadedmetadata", () => {
      this.syncSeekFromVideo();
    });

    video.addEventListener("timeupdate", () => {
      this.syncSeekFromVideo();
    });

    video.addEventListener("ended", () => {
      this.syncSeekFromVideo();
    });
  }

  private applyNormalShellLayout(
    shell: HTMLDivElement = this.replayRoot.getShellElement()
  ): void {
    this.dragManager.resetPositioning();

    shell.style.left = "";
    shell.style.bottom = "24px";
    shell.style.top = "";
    shell.style.right = "24px";
    shell.style.transform = "none";
    shell.style.width = "min(640px, calc(100vw - 48px))";
    shell.style.maxWidth = "640px";
    shell.style.maxHeight = "";
  }

  private applyMaximizedShellLayout(
    shell: HTMLDivElement = this.replayRoot.getShellElement()
  ): void {
    this.dragManager.resetPositioning();

    shell.style.left = "50%";
    shell.style.bottom = "";
    shell.style.top = "50%";
    shell.style.right = "";
    shell.style.transform = "translate(-50%, -50%)";
    shell.style.width = "min(1100px, 92vw)";
    shell.style.maxWidth = "92vw";
    shell.style.maxHeight = "92vh";
  }

  private syncSeekFromVideo(): void {
    if (this.isUserSeeking) return;

    const video = this.replayVideo.getElement();
    const seekInput = this.replayControls.getSeekInput();

    const duration = video.duration;
    const currentTime = video.currentTime;

    if (!Number.isFinite(duration) || duration <= 0) {
      seekInput.value = "0";
      return;
    }

    if (!Number.isFinite(currentTime) || currentTime < 0) {
      seekInput.value = "0";
      return;
    }

    const progress = Math.round((currentTime / duration) * 1000);
    const clamped = Math.max(0, Math.min(1000, progress));
    seekInput.value = String(clamped);
  }

  /**
   * Returns the root DOM container used for replay UI.
   */
  getRootElement(): HTMLDivElement {
    return this.replayRoot.getElement();
  }

  /**
   * Returns the video element used for replay playback.
   */
  getVideoElement(): HTMLVideoElement {
    return this.replayVideo.getElement();
  }

  /**
   * Makes the replay UI visible.
   *
   * Important:
   * This is a UI concern only. It does not attach sources,
   * start playback, or modify replay session ownership.
   */
  showReplay(): void {
    this.replayRoot.show();
    this.replayHeader.show();
    this.replayVideo.show();
    this.replayControls.show();
  }

  /**
   * Hides the replay UI.
   *
   * Important:
   * This is a UI concern only. It does not stop playback,
   * dispose sessions, or clear DVR state.
   */
  hideReplay(): void {
    this.replayControls.hide();
    this.replayVideo.hide();
    this.replayHeader.hide();
    this.replayRoot.hide();
  }
}