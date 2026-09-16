const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// At fractional display scaling Electron reports a window a pixel larger than
// it was commanded (electron#9477). The size ladder compared that reported size
// against the exact BASE size to decide whether to remember the pre-grow
// bounds, so on such a display it never remembered them, re-anchored the shrink
// on the inflated height, and the pill came back 2px lower after every menu.
// Measured by the user at 123%: a visible downward creep on each right-click.

const WINDOW_SIZES = {
  BASE: { width: 208, height: 120 },
  RECORDING: { width: 208, height: 120 },
  WITH_MENU: { width: 240, height: 280 },
};
const WORK_AREA = { x: 0, y: 0, width: 1561, height: 840 };

const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getPrimaryDisplay: () => ({ workArea: WORK_AREA }),
        getDisplayMatching: () => ({ workArea: WORK_AREA }),
        getDisplayNearestPoint: () => ({ workArea: WORK_AREA }),
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        on: () => undefined,
      },
      BrowserWindow: class {},
      Menu: { buildFromTemplate: () => ({ popup() {} }) },
      ipcMain: { on: () => undefined, removeListener: () => undefined },
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger")
    return {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      log: () => undefined,
    };
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {
      unregisterAll() {}
      isInListeningMode() {
        return false;
      }
    };
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager")
    return class {
      cleanup() {}
      isDragActive() {
        return false;
      }
    };
  if (request === "./menuManager") return {};
  if (request === "./devServerManager")
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES,
      ONBOARDING_WINDOW_SIZES: {
        COMPACT: { width: 480, height: 624 },
        EXPANDED: { width: 1000, height: 740 },
      },
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (bounds, display) => {
          const area = display.workArea;
          return {
            x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
            y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)),
          };
        },
        getMainWindowPosition: (_display, size) => ({ x: 0, y: 0, ...size }),
        getNotificationPosition: () => ({ x: 0, y: 0 }),
      },
      fitAssistantWindowToWorkArea: (s) => s,
      fitAssistantContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      fitDictationErrorWindowToWorkArea: (s) => s,
      fitDictationErrorContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      resolveHorizontalWindowDirection: () => "left",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

// A window that behaves like Electron at fractional DPI: whatever it is told,
// it reports back one pixel larger on each axis.
function inflatingWindow(bounds) {
  let commanded = { ...bounds };
  const setBoundsCalls = [];
  return {
    setBoundsCalls,
    commanded: () => ({ ...commanded }),
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => false,
    getBounds: () => ({ ...commanded, width: commanded.width + 1, height: commanded.height + 1 }),
    setBounds: (next) => {
      setBoundsCalls.push({ ...next });
      commanded = { ...next };
    },
    webContents: { send: () => undefined },
  };
}

function makeManager(startBounds) {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  const win = inflatingWindow(startBounds);
  manager.mainWindow = win;
  manager._panelStartPosition = "bottom-left";
  manager.enforceMainWindowOnTop = () => undefined;
  manager._notifyMainWindowHorizontalDirection = () => undefined;
  manager._prepareRendererForMainWindowResize = async () => ({ waitedMs: 0, timedOut: false });
  manager._getMainWindowDisplayFor = () => ({ workArea: WORK_AREA });
  return { manager, win };
}

test("opening and closing the menu five times leaves the pill exactly where it was", async () => {
  const start = { x: 14, y: 700, width: 208, height: 120 };
  const { manager, win } = makeManager(start);

  for (let cycle = 1; cycle <= 5; cycle += 1) {
    await manager._performMainWindowResize("WITH_MENU");
    await manager._performMainWindowResize("BASE");
    assert.deepEqual(win.commanded(), start, `drifted after menu cycle ${cycle}`);
  }
});

test("the grown window keeps the pill's bottom edge where the commanded window had it", async () => {
  const { manager, win } = makeManager({ x: 14, y: 700, width: 208, height: 120 });
  await manager._performMainWindowResize("WITH_MENU");
  const grown = win.commanded();
  // Bottom edge of the commanded BASE window is 820; the reported height (121)
  // must not move it to 821.
  assert.equal(grown.y + grown.height, 820);
  assert.equal(grown.width, 240);
  assert.equal(grown.height, 280);
});

test("a same-footprint request is still skipped when the window reports inflated bounds", async () => {
  // BASE and RECORDING are the same box on purpose: a recording edge must not
  // call setBounds, because resizing a transparent window flashes a stale frame.
  const { manager, win } = makeManager({ x: 14, y: 700, width: 208, height: 120 });
  await manager._performMainWindowResize("RECORDING");
  await manager._performMainWindowResize("BASE");
  assert.equal(win.setBoundsCalls.length, 0);
});
