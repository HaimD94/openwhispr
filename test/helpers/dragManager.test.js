const test = require("node:test");
const assert = require("node:assert/strict");

let fakeCursor = { x: 50, y: 679 };
const fakeDisplay = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

require.cache[require.resolve("electron")] = {
  exports: {
    screen: {
      getCursorScreenPoint: () => fakeCursor,
      getDisplayNearestPoint: () => fakeDisplay,
      getPrimaryDisplay: () => fakeDisplay,
      on: () => {},
    },
    app: {
      getPath: () => "",
      getVersion: () => "1.0.0",
      whenReady: async () => {},
      on: () => {},
    },
    BrowserWindow: class {},
    dialog: {},
    ipcMain: { on: () => {}, handle: () => {} },
    Menu: { buildFromTemplate: () => ({}) },
    shell: {},
    globalShortcut: {
      isRegistered: () => false,
      register: () => true,
      unregister: () => {},
      unregisterAll: () => {},
    },
  },
};

require.cache[require.resolve("../../src/helpers/debugLogger.js")] = {
  exports: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  },
};

const DragManager = require("../../src/helpers/dragManager.js");

function createFakeWindow({ x = 14, y = 432, width = 208, height = 120, inflate = 1 } = {}) {
  let bounds = { x, y, width, height };
  const setBoundsCalls = [];

  return {
    setBoundsCalls,
    isDestroyed: () => false,
    getPosition: () => [bounds.x, bounds.y],
    getBounds: () => ({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width + inflate,
      height: bounds.height + inflate,
    }),
    setBounds: (newBounds) => {
      setBoundsCalls.push({ ...newBounds });
      bounds = { ...newBounds };
    },
    _setLiveBoundsDirectly: (newBounds) => {
      bounds = { ...newBounds };
    },
  };
}

test.afterEach(() => {
  fakeCursor = { x: 50, y: 679 };
});

test("a) five consecutive drags with geometry returning 208x120 carry exactly 208x120 without ratcheting", async () => {
  const manager = new DragManager();
  const fakeWin = createFakeWindow({ x: 100, y: 100, width: 208, height: 120, inflate: 1 });
  const geometry = {
    getIntendedSize: () => ({ width: 208, height: 120 }),
    getAnchor: () => "right",
  };

  try {
    for (let i = 0; i < 5; i++) {
      fakeCursor = { x: 150 + i * 10, y: 150 + i * 10 };
      const startResult = await manager.startWindowDrag(fakeWin, { x: 50, y: 50 }, geometry);
      assert.equal(startResult.success, true);

      // Move cursor beyond DRAG_START_THRESHOLD_PX (5px) to arm the drag
      fakeCursor = { x: fakeCursor.x + 10, y: fakeCursor.y + 10 };
      manager.updateWindowPosition();

      const lastCall = fakeWin.setBoundsCalls[fakeWin.setBoundsCalls.length - 1];
      assert.ok(lastCall, `Expected setBounds to be called on drag ${i + 1}`);
      assert.equal(lastCall.width, 208, `Drag ${i + 1} setBounds width must be exactly 208`);
      assert.equal(lastCall.height, 120, `Drag ${i + 1} setBounds height must be exactly 120`);

      await manager.stopWindowDrag();
    }
  } finally {
    manager.cleanup();
  }
});

test("b) mid-drag menu close with left anchor adopts 208x120 and preserves pill grip (offset becomes 36,87)", async () => {
  const manager = new DragManager();
  // Starts with WITH_MENU size (240x280), inflated by 1 to 241x281
  const fakeWin = createFakeWindow({ x: 14, y: 432, width: 240, height: 280, inflate: 1 });

  let intendedSize = { width: 240, height: 280 };
  const geometry = {
    getIntendedSize: () => intendedSize,
    getAnchor: () => "left",
  };

  try {
    fakeCursor = { x: 50, y: 679 };
    const startResult = await manager.startWindowDrag(fakeWin, { x: 36, y: 247 }, geometry);
    assert.equal(startResult.success, true);
    assert.deepEqual(manager.getDragOffset(), { x: 36, y: 247 });

    // Arm drag by moving cursor
    fakeCursor = { x: 60, y: 689 };
    manager.updateWindowPosition();

    // Mid-drag: menu closes, window shrinks to BASE (208x120), inflated live is 209x121
    intendedSize = { width: 208, height: 120 };
    fakeWin._setLiveBoundsDirectly({ x: 14, y: 432, width: 208, height: 120 });

    fakeCursor = { x: 70, y: 700 };
    manager.updateWindowPosition();

    const lastCall = fakeWin.setBoundsCalls[fakeWin.setBoundsCalls.length - 1];
    assert.equal(lastCall.width, 208);
    assert.equal(lastCall.height, 120);

    // offset.y += 120 - 280 = -160 => 247 - 160 = 87
    // offset.x unchanged for left anchor => 36
    assert.deepEqual(manager.getDragOffset(), { x: 36, y: 87 });
    // Window y should equal cursor.y - 87 => 700 - 87 = 613
    assert.equal(lastCall.y, 700 - 87);
    assert.equal(lastCall.x, 70 - 36);

    await manager.stopWindowDrag();
  } finally {
    manager.cleanup();
  }
});

test("c) mid-drag resize with right anchor shifts offset.x by newWidth - oldWidth", async () => {
  const manager = new DragManager();
  const fakeWin = createFakeWindow({ x: 14, y: 432, width: 240, height: 280, inflate: 1 });

  let intendedSize = { width: 240, height: 280 };
  const geometry = {
    getIntendedSize: () => intendedSize,
    getAnchor: () => "right",
  };

  try {
    fakeCursor = { x: 214, y: 679 };
    await manager.startWindowDrag(fakeWin, { x: 200, y: 247 }, geometry);

    // Arm drag
    fakeCursor = { x: 224, y: 689 };
    manager.updateWindowPosition();

    // Mid-drag resize: 240x280 -> 208x120
    intendedSize = { width: 208, height: 120 };
    fakeWin._setLiveBoundsDirectly({ x: 14, y: 432, width: 208, height: 120 });

    fakeCursor = { x: 230, y: 700 };
    manager.updateWindowPosition();

    const lastCall = fakeWin.setBoundsCalls[fakeWin.setBoundsCalls.length - 1];
    assert.equal(lastCall.width, 208);
    assert.equal(lastCall.height, 120);

    // newWidth - oldWidth = 208 - 240 = -32 => offset.x: 200 - 32 = 168
    // newHeight - oldHeight = 120 - 280 = -160 => offset.y: 247 - 160 = 87
    assert.deepEqual(manager.getDragOffset(), { x: 168, y: 87 });
    assert.equal(lastCall.x, 230 - 168);
    assert.equal(lastCall.y, 700 - 87);

    await manager.stopWindowDrag();
  } finally {
    manager.cleanup();
  }
});

test("mid-drag resize with center anchor shifts offset.x by (newWidth - oldWidth) / 2", async () => {
  const manager = new DragManager();
  const fakeWin = createFakeWindow({ x: 14, y: 432, width: 240, height: 280, inflate: 1 });

  let intendedSize = { width: 240, height: 280 };
  const geometry = {
    getIntendedSize: () => intendedSize,
    getAnchor: () => "center",
  };

  try {
    fakeCursor = { x: 134, y: 679 };
    await manager.startWindowDrag(fakeWin, { x: 120, y: 247 }, geometry);

    fakeCursor = { x: 144, y: 689 };
    manager.updateWindowPosition();

    intendedSize = { width: 208, height: 120 };
    fakeWin._setLiveBoundsDirectly({ x: 14, y: 432, width: 208, height: 120 });

    fakeCursor = { x: 150, y: 700 };
    manager.updateWindowPosition();

    // (208 - 240) / 2 = -16 => offset.x: 120 - 16 = 104
    // 120 - 280 = -160 => offset.y: 247 - 160 = 87
    assert.deepEqual(manager.getDragOffset(), { x: 104, y: 87 });

    await manager.stopWindowDrag();
  } finally {
    manager.cleanup();
  }
});

test("d) no geometry (control panel path): live size locked at start, +1 inflation does not cause adoption", async () => {
  const manager = new DragManager();
  // Window size 500x600, inflated live is 501x601
  const fakeWin = createFakeWindow({ x: 100, y: 100, width: 500, height: 600, inflate: 1 });

  try {
    fakeCursor = { x: 150, y: 150 };
    // No geometry passed
    await manager.startWindowDrag(fakeWin, { x: 50, y: 50 });

    // Live size at start is 501x601
    assert.deepEqual(manager.dragSize, { width: 501, height: 601 });

    // Arm drag
    fakeCursor = { x: 160, y: 160 };
    manager.updateWindowPosition();

    let lastCall = fakeWin.setBoundsCalls[fakeWin.setBoundsCalls.length - 1];
    assert.equal(lastCall.width, 501);
    assert.equal(lastCall.height, 601);

    // Simulate another +1 inflation reported by OS getBounds (now 502x602)
    fakeWin._setLiveBoundsDirectly({ x: lastCall.x, y: lastCall.y, width: 501, height: 601 });
    // With inflate=1, getBounds() returns 502x602 (which is 1px drift, within tolerance)
    fakeCursor = { x: 170, y: 170 };
    manager.updateWindowPosition();

    // Size must remain locked at 501x601 (not ratcheted to 502x602)
    lastCall = fakeWin.setBoundsCalls[fakeWin.setBoundsCalls.length - 1];
    assert.equal(lastCall.width, 501);
    assert.equal(lastCall.height, 601);

    // However, a genuinely different size (e.g. 700x800) IS adopted mid-drag
    fakeWin._setLiveBoundsDirectly({ x: 80, y: 80, width: 700, height: 800 });
    fakeCursor = { x: 180, y: 180 };
    manager.updateWindowPosition();

    lastCall = fakeWin.setBoundsCalls[fakeWin.setBoundsCalls.length - 1];
    // Live was 700+1 x 800+1 = 701x801
    assert.equal(lastCall.width, 701);
    assert.equal(lastCall.height, 801);

    await manager.stopWindowDrag();
  } finally {
    manager.cleanup();
  }
});

test("mid-drag genuine resize without geometry adjusts offset using commanded vs live position fallback", async () => {
  const manager = new DragManager();
  const fakeWin = createFakeWindow({ x: 100, y: 100, width: 500, height: 600, inflate: 0 });

  try {
    fakeCursor = { x: 150, y: 150 };
    await manager.startWindowDrag(fakeWin, { x: 50, y: 50 });

    // Arm drag and command position: (160 - 50, 160 - 50) = (110, 110)
    fakeCursor = { x: 160, y: 160 };
    manager.updateWindowPosition();

    // Now window genuinely resizes and moves mid-drag to (140, 150, 700, 800)
    fakeWin._setLiveBoundsDirectly({ x: 140, y: 150, width: 700, height: 800 });
    fakeCursor = { x: 170, y: 170 };
    manager.updateWindowPosition();

    // Fallback: offset += (commanded - live) => (110 - 140 = -30, 110 - 150 = -40)
    // offset: { x: 50 - 30 = 20, y: 50 - 40 = 10 }
    assert.deepEqual(manager.getDragOffset(), { x: 20, y: 10 });

    await manager.stopWindowDrag();
  } finally {
    manager.cleanup();
  }
});

const WindowManager = require("../../src/helpers/windowManager.js");

test("WindowManager.startWindowDrag passes geometry with intended size and anchor", async () => {
  let capturedArgs = null;
  const fakeDragManager = {
    startWindowDrag: async (override, grabOffset, geometry) => {
      capturedArgs = { override, grabOffset, geometry };
      return { success: true };
    },
  };

  const context = {
    _mainWindowPlacementCoordinator: { cancelPending: () => {} },
    mainWindow: {
      isDestroyed: () => false,
      getBounds: () => ({ x: 10, y: 20, width: 208, height: 120 }),
    },
    _mainWindowSizeKey: "BASE",
    _panelStartPosition: "bottom-right",
    _activeHorizontalDirection: "left",
    getMainWindowHorizontalDirection: () => "right",
    dragManager: fakeDragManager,
  };

  await WindowManager.prototype.startWindowDrag.call(context, { x: 30, y: 40 });

  assert.ok(capturedArgs);
  assert.equal(capturedArgs.override, null);
  assert.deepEqual(capturedArgs.grabOffset, { x: 30, y: 40 });
  assert.ok(capturedArgs.geometry);
  assert.deepEqual(capturedArgs.geometry.getIntendedSize(), { width: 208, height: 120 });
  assert.equal(capturedArgs.geometry.getAnchor(), "left");

  // When panel start position is center, anchor is center
  context._panelStartPosition = "center";
  assert.equal(capturedArgs.geometry.getAnchor(), "center");

  // Content-sized key (not in WINDOW_SIZES) returns null
  context._mainWindowSizeKey = "ASSISTANT_CONTENT";
  assert.equal(capturedArgs.geometry.getIntendedSize(), null);
});
