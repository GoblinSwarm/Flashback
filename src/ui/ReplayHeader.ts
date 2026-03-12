// src/ui/ReplayHeader.ts
// =====================
//
// ReplayHeader
// ------------
//
// This module owns the replay header DOM elements.
//
// It is responsible for creating a minimal window-like header for the
// replay surface, including:
//
// - title label
// - close button
//
// Architecture role
// -----------------
// ReplayHeader belongs to the UI layer.
//
// It provides the top chrome of the replay shell and is intended to
// become the official drag handle for future DragManager behavior.
//
// Typical flow
// ------------
// UIOrchestrator
//        ↓
//   ReplayHeader
//        ├─ title label
//        └─ close button
//
// Responsibilities
// ----------------
// This module is responsible ONLY for:
//
// - creating replay header DOM elements
// - exposing stable references to those elements
// - owning minimal header layout
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
// - implement drag behavior directly
//
// Design rule
// -----------
// ReplayHeader must remain a DOM element owner only.
// Wiring behavior belongs to UIOrchestrator.
//

export class ReplayHeader {
  private readonly root: HTMLDivElement;
  private readonly titleLabel: HTMLSpanElement;
  private readonly closeButton: HTMLButtonElement;

  constructor() {
    this.root = document.createElement("div");
    this.titleLabel = document.createElement("span");
    this.closeButton = document.createElement("button");

    this.setupRoot();
    this.setupTitleLabel();
    this.setupCloseButton();
    this.assemble();
  }

  private setupRoot(): void {
    this.root.className = "flashback-replay-header";
    this.root.dataset.flashbackRole = "replay-header";

    this.root.style.display = "flex";
    this.root.style.flexDirection = "row";
    this.root.style.alignItems = "center";
    this.root.style.justifyContent = "space-between";
    this.root.style.width = "100%";
    this.root.style.boxSizing = "border-box";
    this.root.style.padding = "8px 10px";
    this.root.style.background = "rgba(20, 20, 20, 0.88)";
    this.root.style.borderRadius = "10px";
    this.root.style.pointerEvents = "auto";
    this.root.style.userSelect = "none";
    this.root.style.cursor = "grab";
  }

  private setupTitleLabel(): void {
    this.titleLabel.textContent = "Flashback Replay";
    this.titleLabel.dataset.flashbackRole = "replay-header-title";

    this.titleLabel.style.flex = "1 1 auto";
    this.titleLabel.style.fontSize = "13px";
    this.titleLabel.style.fontWeight = "600";
    this.titleLabel.style.color = "white";
    this.titleLabel.style.whiteSpace = "nowrap";
    this.titleLabel.style.overflow = "hidden";
    this.titleLabel.style.textOverflow = "ellipsis";
    this.titleLabel.style.pointerEvents = "none";
  }

  private setupCloseButton(): void {
    this.closeButton.type = "button";
    this.closeButton.textContent = "✕";
    this.closeButton.dataset.flashbackRole = "replay-close-button";
    this.closeButton.dataset.flashbackNoDrag = "1";

    this.closeButton.style.pointerEvents = "auto";
    this.closeButton.style.cursor = "pointer";
    this.closeButton.style.width = "32px";
    this.closeButton.style.height = "32px";
    this.closeButton.style.flex = "0 0 auto";
    this.closeButton.style.fontSize = "16px";
    this.closeButton.style.lineHeight = "1";
  }

  private assemble(): void {
    this.root.appendChild(this.titleLabel);
    this.root.appendChild(this.closeButton);
  }

  getElement(): HTMLDivElement {
    return this.root;
  }

  getDragHandleElement(): HTMLDivElement {
    return this.root;
  }

  getTitleLabel(): HTMLSpanElement {
    return this.titleLabel;
  }

  getCloseButton(): HTMLButtonElement {
    return this.closeButton;
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