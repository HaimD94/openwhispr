const { screen } = require("electron");
const { WindowPositionUtil } = require("./windowConfig");
const debugLogger = require("./debugLogger");

// A press is only a drag once the cursor has actually travelled. Without this,
// every mousedown started moving the window at 60fps, so the few pixels a hand
// moves while clicking dragged the pill out from under the pointer -- it
// "ran away" from the click, and the click itself was often lost because the
// target moved before mouseup. Windows' own threshold (SM_CXDRAG) is 4px;
// 5 leaves a little room for a heavy click without feeling sticky.
const DRAG_START_THRESHOLD_PX = 5;

// Backstop for a drag whose mouseup never arrived (the renderer went
// click-through mid-gesture, the window lost focus to a system dialog, a
// crashed renderer). Without it the tracker keeps the window glued to the
// cursor until the app restarts, which is far worse than ending a genuine
// drag early. No real drag of a small floating pill lasts a minute.
const MAX_DRAG_DURATION_MS = 60000;

class DragManager {
  constructor() {
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.mouseTrackingInterval = null;
    this.targetWindow = null;
    this.activeWindow = null;
    // Set at mousedown; the window does not move until the cursor leaves the
    // threshold around it, at which point the drag is "armed" for good.
    this.dragStartCursor = null;
    this.dragArmed = false;
    this.dragStartedAt = null;
  }

  setTargetWindow(window) {
    this.targetWindow = window;
  }

  /** Drags the configured target window by default; a caller that owns a
   *  different frameless window (the control panel's manual titlebar) passes
   *  it explicitly for the duration of one drag. */
  async startWindowDrag(windowOverride = null) {
    const win = windowOverride || this.targetWindow;
    if (!win || win.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    try {
      this.isDragging = true;
      this.activeWindow = win;

      // Get current cursor position
      const cursorPos = screen.getCursorScreenPoint();
      const windowPos = win.getPosition();

      // Calculate offset from cursor to window position
      this.dragOffset = {
        x: cursorPos.x - windowPos[0],
        y: cursorPos.y - windowPos[1],
      };

      // Nothing moves until the pointer proves this is a drag and not a click.
      this.dragStartCursor = { x: cursorPos.x, y: cursorPos.y };
      this.dragArmed = false;
      this.dragStartedAt = Date.now();

      // Start tracking mouse movements
      this.setupMouseTracking();

      debugLogger.info("Window drag started", undefined, "window-drag");
      return { success: true };
    } catch (error) {
      console.error("Failed to start window drag:", error);
      this.isDragging = false;
      return { success: false, message: error.message };
    }
  }

  async stopWindowDrag() {
    try {
      this.isDragging = false;
      this.activeWindow = null;
      this.dragStartCursor = null;
      this.dragArmed = false;
      this.dragStartedAt = null;
      this.stopMouseTracking();
      debugLogger.info("Window drag stopped", undefined, "window-drag");
      return { success: true };
    } catch (error) {
      console.error("Failed to stop window drag:", error);
      return { success: false, message: error.message };
    }
  }

  setupMouseTracking() {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
    }

    this.mouseTrackingInterval = setInterval(() => {
      if (!this.isDragging || !this.activeWindow || this.activeWindow.isDestroyed()) return;
      if (this.dragStartedAt && Date.now() - this.dragStartedAt > MAX_DRAG_DURATION_MS) {
        debugLogger.info("Window drag ended by timeout (no mouseup)", undefined, "window-drag");
        this.stopWindowDrag();
        return;
      }
      this.updateWindowPosition();
    }, 16); // ~60fps
  }

  updateWindowPosition() {
    try {
      const cursorPos = screen.getCursorScreenPoint();

      // Hold still until the pointer has travelled far enough to mean it.
      if (!this.dragArmed) {
        if (!this.dragStartCursor) {
          this.dragArmed = true;
        } else {
          const dx = cursorPos.x - this.dragStartCursor.x;
          const dy = cursorPos.y - this.dragStartCursor.y;
          if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD_PX) return;
          this.dragArmed = true;
        }
      }

      const { width, height } = this.activeWindow.getBounds();
      const x = cursorPos.x - this.dragOffset.x;
      const y = cursorPos.y - this.dragOffset.y;

      // Constrain against the display the window lands on, not the one under the
      // cursor: near a boundary between differently sized displays, the cursor's
      // work area permits positions that leave the window in dead space.
      const display = screen.getDisplayNearestPoint({
        x: x + width / 2,
        y: y + height / 2,
      });
      const clamped = WindowPositionUtil.clampToWorkArea({ x, y, width, height }, display);

      this.activeWindow.setPosition(clamped.x, clamped.y);
    } catch (error) {
      console.error("Error updating window position:", error);
      this.stopWindowDrag();
    }
  }

  stopMouseTracking() {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
      this.mouseTrackingInterval = null;
    }
  }

  isDragActive() {
    return this.isDragging;
  }

  getDragOffset() {
    return { ...this.dragOffset };
  }

  cleanup() {
    this.stopWindowDrag();
    this.targetWindow = null;
  }
}

module.exports = DragManager;
