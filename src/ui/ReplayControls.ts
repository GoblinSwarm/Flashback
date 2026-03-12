// src/ui/ReplayControls.ts
// ========================
//
// ReplayControls
// --------------
//
// This module owns the replay control DOM elements.
//
// It is responsible for creating a minimal control surface for:
//
// - play
// - pause
// - seek
// - maximize
//
// Architecture role
// -----------------
// ReplayControls belongs to the UI layer.
//
// It provides a small, reusable DOM control bar that can be mounted
// into the ReplayRoot controls host.
//
// Typical flow
// ------------
// UIOrchestrator
//        ↓
//   ReplayControls
//        ├─ play button
//        ├─ pause button
//        ├─ seek input
//        └─ maximize button
//
// Responsibilities
// ----------------
// This module is responsible ONLY for:
//
// - creating replay control DOM elements
// - exposing stable references to those elements
// - owning minimal control-bar layout
//
// Non-responsibilities
// --------------------
// This module MUST NOT:
//
// - decide replay policy
// - resolve replay sources
// - access DVR state
// - attach MediaSource
// - manage replay sessions
//
// Design rule
// -----------
// ReplayControls must remain a DOM element owner only.
// Wiring behavior belongs to UIOrchestrator.
//

export class ReplayControls {
  private readonly root: HTMLDivElement;
  private readonly playButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly seekInput: HTMLInputElement;
  private readonly maximizeButton: HTMLButtonElement;

  constructor() {
    this.root = document.createElement("div");
    this.playButton = document.createElement("button");
    this.pauseButton = document.createElement("button");
    this.seekInput = document.createElement("input");
    this.maximizeButton = document.createElement("button");

    this.setupRoot();
    this.setupPlayButton();
    this.setupPauseButton();
    this.setupSeekInput();
    this.setupMaximizeButton();
    this.assemble();
  }

  private setupRoot(): void {
    this.root.className = "flashback-replay-controls";
    this.root.dataset.flashbackRole = "replay-controls";

    this.root.style.display = "flex";
    this.root.style.flexDirection = "row";
    this.root.style.alignItems = "center";
    this.root.style.justifyContent = "flex-start";
    this.root.style.gap = "8px";
    this.root.style.width = "100%";
    this.root.style.boxSizing = "border-box";
    this.root.style.padding = "8px 10px";
    this.root.style.background = "rgba(0, 0, 0, 0.72)";
    this.root.style.borderRadius = "10px";
    this.root.style.pointerEvents = "auto";
  }

  private setupPlayButton(): void {
    this.playButton.type = "button";
    this.playButton.textContent = "▶";
    this.playButton.dataset.flashbackRole = "replay-play-button";
    this.playButton.style.pointerEvents = "auto";
    this.playButton.style.cursor = "pointer";
    this.playButton.style.width = "32px";
    this.playButton.style.height = "32px";
    this.playButton.style.flex = "0 0 auto";
    this.playButton.style.fontSize = "16px";
    this.playButton.style.lineHeight = "1";
  }

  private setupPauseButton(): void {
    this.pauseButton.type = "button";
    this.pauseButton.textContent = "⏸";
    this.pauseButton.dataset.flashbackRole = "replay-pause-button";
    this.pauseButton.style.pointerEvents = "auto";
    this.pauseButton.style.cursor = "pointer";
    this.pauseButton.style.width = "32px";
    this.pauseButton.style.height = "32px";
    this.pauseButton.style.flex = "0 0 auto";
    this.pauseButton.style.fontSize = "16px";
    this.pauseButton.style.lineHeight = "1";
  }

  private setupSeekInput(): void {
    this.seekInput.type = "range";
    this.seekInput.min = "0";
    this.seekInput.max = "1000";
    this.seekInput.step = "1";
    this.seekInput.value = "0";
    this.seekInput.dataset.flashbackRole = "replay-seek-input";
    this.seekInput.style.flex = "1 1 auto";
    this.seekInput.style.width = "100%";
    this.seekInput.style.pointerEvents = "auto";
    this.seekInput.style.cursor = "pointer";
  }

  private setupMaximizeButton(): void {
    this.maximizeButton.type = "button";
    this.maximizeButton.textContent = "⛶";
    this.maximizeButton.dataset.flashbackRole = "replay-maximize-button";
    this.maximizeButton.style.pointerEvents = "auto";
    this.maximizeButton.style.cursor = "pointer";
    this.maximizeButton.style.width = "32px";
    this.maximizeButton.style.height = "32px";
    this.maximizeButton.style.flex = "0 0 auto";
    this.maximizeButton.style.fontSize = "16px";
    this.maximizeButton.style.lineHeight = "1";
  }

  private assemble(): void {
    this.root.appendChild(this.playButton);
    this.root.appendChild(this.pauseButton);
    this.root.appendChild(this.seekInput);
    this.root.appendChild(this.maximizeButton);
  }

  getElement(): HTMLDivElement {
    return this.root;
  }

  getPlayButton(): HTMLButtonElement {
    return this.playButton;
  }

  getPauseButton(): HTMLButtonElement {
    return this.pauseButton;
  }

  getSeekInput(): HTMLInputElement {
    return this.seekInput;
  }

  getMaximizeButton(): HTMLButtonElement {
    return this.maximizeButton;
  }

  show(): void {
    this.root.style.display = "flex";
    this.root.style.visibility = "visible";
    this.root.style.opacity = "1";
  }

  hide(): void {
    this.root.style.display = "none";
    this.root.style.visibility = "hidden";
    this.root.style.opacity = "0";
  }
}