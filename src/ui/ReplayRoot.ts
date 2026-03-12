// src/ui/ReplayRoot.ts
// ====================
//
// ReplayRoot
// ----------
//
// This module owns the DOM container used to render the replay UI.
//
// It is responsible for creating a stable root element and ensuring
// that it is attached to the page exactly once.
//
// Architecture role
// -----------------
// ReplayRoot belongs to the UI layer.
//
// It provides the DOM container where the replay UI surface
// will live, including:
//
// - header host
// - video host
// - controls host
//
// Typical flow
// ------------
// ReplayCoordinator
//        ↓
//   UIOrchestrator
//        ↓
//     ReplayRoot
//        ├─ headerHost
//        ├─ videoHost
//        └─ controlsHost
//               ↓
//   ReplayHeader / ReplayVideo / ReplayControls
//
// Responsibilities
// ----------------
// This module is responsible ONLY for:
//
// - creating the replay root DOM container
// - attaching the container to document.body
// - creating a stable internal shell
// - exposing dedicated host elements for replay UI pieces
// - mounting header, video, and controls into their corresponding hosts
// - controlling container visibility
//
// Key guarantees
// --------------
// - the root element is created once
// - the root is attached to the page once
// - the shell structure is created once
// - header, video, and controls mount into stable dedicated hosts
//
// Non-responsibilities
// --------------------
// This module MUST NOT:
//
// - manage replay sessions
// - control playback
// - resolve replay sources
// - attach MediaSource
// - access DVR state
//
// Those responsibilities belong to:
//
//   ReplayCoordinator
//   ReplaySessionManager
//   Playback layer
//
// Design rule
// -----------
// ReplayRoot must remain a minimal DOM container owner.
// If playback logic or replay orchestration appears here,
// the architecture is being violated.
//

export class ReplayRoot {
  private readonly root: HTMLDivElement;
  private readonly shell: HTMLDivElement;
  private readonly headerHost: HTMLDivElement;
  private readonly videoHost: HTMLDivElement;
  private readonly controlsHost: HTMLDivElement;

  constructor() {
    this.root = document.createElement("div");
    this.shell = document.createElement("div");
    this.headerHost = document.createElement("div");
    this.videoHost = document.createElement("div");
    this.controlsHost = document.createElement("div");

    this.setupRoot();
    this.setupShell();
    this.setupHeaderHost();
    this.setupVideoHost();
    this.setupControlsHost();
    this.assemble();

    this.ensureMounted();

    // Start hidden by default until replay is triggered.
    this.hide();
  }

  private setupRoot(): void {
    // Hard markers so VideoResolver can exclude the whole replay tree.
    this.root.id = "flashback-replay-root";
    this.root.dataset.flashbackReplayRoot = "1";
    this.root.dataset.flashbackRoot = "1";
    this.root.dataset.flashbackRootRole = "replay";
    this.root.dataset.flashbackRole = "replay";
    this.root.dataset.flashbackIgnore = "1";
    this.root.setAttribute("data-flashback-replay-root", "1");
    this.root.setAttribute("data-flashback-root", "1");
    this.root.setAttribute("data-flashback-role", "replay");
    this.root.setAttribute("data-fb-role", "replay");
    this.root.setAttribute("data-flashback-ignore", "1");

    // Root remains a full-screen overlay boundary.
    // Pointer events stay disabled here so the overlay itself
    // does not block the page; interactive children can opt in.
    this.root.style.position = "fixed";
    this.root.style.inset = "0";
    this.root.style.width = "100%";
    this.root.style.height = "100%";
    this.root.style.pointerEvents = "none";
    this.root.style.zIndex = "2147483647";
  }

  private setupShell(): void {
    this.shell.className = "flashback-replay-shell";
    this.shell.dataset.flashbackRole = "replay-shell";

    // Stable visual replay surface.
    // This shell is the natural target for header chrome and future drag behavior.
    this.shell.style.position = "absolute";
    this.shell.style.left = "24px";
    this.shell.style.bottom = "24px";
    this.shell.style.display = "flex";
    this.shell.style.flexDirection = "column";
    this.shell.style.alignItems = "stretch";
    this.shell.style.gap = "8px";
    this.shell.style.pointerEvents = "auto";

    this.shell.style.width = "min(640px, calc(100vw - 48px))";
    this.shell.style.maxWidth = "640px";
    this.shell.style.padding = "8px";
    this.shell.style.background = "rgba(0, 0, 0, 0.55)";
    this.shell.style.borderRadius = "12px";
    this.shell.style.boxSizing = "border-box";
  }

  private setupHeaderHost(): void {
    this.headerHost.className = "flashback-replay-header-host";
    this.headerHost.dataset.flashbackRole = "replay-header-host";

    this.headerHost.style.display = "flex";
    this.headerHost.style.flexDirection = "row";
    this.headerHost.style.alignItems = "center";
    this.headerHost.style.width = "100%";
  }

  private setupVideoHost(): void {
    this.videoHost.className = "flashback-replay-video-host";
    this.videoHost.dataset.flashbackRole = "replay-video-host";

    this.videoHost.style.display = "flex";
    this.videoHost.style.flexDirection = "column";
    this.videoHost.style.alignItems = "stretch";
    this.videoHost.style.justifyContent = "center";
    this.videoHost.style.width = "100%";
  }

  private setupControlsHost(): void {
    this.controlsHost.className = "flashback-replay-controls-host";
    this.controlsHost.dataset.flashbackRole = "replay-controls-host";

    this.controlsHost.style.display = "flex";
    this.controlsHost.style.flexDirection = "row";
    this.controlsHost.style.alignItems = "center";
    this.controlsHost.style.gap = "8px";
    this.controlsHost.style.width = "100%";
  }

  private assemble(): void {
    this.shell.appendChild(this.headerHost);
    this.shell.appendChild(this.videoHost);
    this.shell.appendChild(this.controlsHost);
    this.root.appendChild(this.shell);
  }

  private ensureMounted(): void {
    const body = document.body;
    if (!body) return;

    if (!body.contains(this.root)) {
      body.appendChild(this.root);
    }
  }

  getElement(): HTMLDivElement {
    return this.root;
  }

  getShellElement(): HTMLDivElement {
    return this.shell;
  }

  getHeaderHostElement(): HTMLDivElement {
    return this.headerHost;
  }

  getVideoHostElement(): HTMLDivElement {
    return this.videoHost;
  }

  getControlsHostElement(): HTMLDivElement {
    return this.controlsHost;
  }

  mountHeader(child: HTMLElement): void {
    if (!this.headerHost.contains(child)) {
      this.headerHost.appendChild(child);
    }
  }

  mountVideo(child: HTMLElement): void {
    if (!this.videoHost.contains(child)) {
      this.videoHost.appendChild(child);
    }
  }

  mountControls(child: HTMLElement): void {
    if (!this.controlsHost.contains(child)) {
      this.controlsHost.appendChild(child);
    }
  }

  /**
   * Backward-compatible generic mount.
   *
   * Prefer mountHeader(), mountVideo(), or mountControls() for new code.
   * This method currently mounts into the video host to
   * preserve previous behavior as closely as possible.
   */
  mount(child: HTMLElement): void {
    this.mountVideo(child);
  }

  /**
   * Makes the replay container visible.
   */
  show(): void {
    this.root.style.display = "block";
    this.root.style.visibility = "visible";
    this.root.style.opacity = "1";
  }

  /**
   * Hides the replay container.
   */
  hide(): void {
    this.root.style.display = "none";
    this.root.style.visibility = "hidden";
    this.root.style.opacity = "0";
  }
}