// Main-process helpers `require("electron")` at import time. Outside Electron
// that resolves to the *path of the binary* -- a string -- so the very first
// `const { app } = require("electron")` yields undefined, and any module that
// touches `app` while loading throws before a single assertion runs.
//
// debugLogger does exactly that (`app.isPackaged` in its constructor), and it
// is imported by most main-process helpers. The result was 177 failures across
// 41 files, all the same error, drowning every real regression in the suite.
//
// Registered once via --import in the `test` script, so no test file has to
// know about it. Only the surface tests actually reach is stubbed: an
// everything-Proxy would turn a genuine "you called the wrong API" into a
// silent no-op, which is the failure mode this file exists to end.
import Module from "node:module";
import os from "node:os";
import path from "node:path";

const noop = () => {};
const tmp = path.join(os.tmpdir(), "openwhispr-test");

const app = {
  isPackaged: false,
  isReady: () => false,
  whenReady: async () => {},
  getVersion: () => "0.0.0-test",
  getName: () => "OpenWhispr",
  getAppPath: () => process.cwd(),
  getPath: (name) => path.join(tmp, String(name)),
  getLocale: () => "en-US",
  on: noop,
  once: noop,
  off: noop,
  quit: noop,
  exit: noop,
  setLoginItemSettings: noop,
  getLoginItemSettings: () => ({ openAtLogin: false }),
};

const ipcMain = { handle: noop, handleOnce: noop, on: noop, once: noop, removeHandler: noop };
const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(String(s)),
  decryptString: (b) => Buffer.from(b).toString(),
};

// Anything a test genuinely exercises should be stubbed by that test, not here:
// these exist so that *importing* a module does not explode.
const electron = {
  app,
  ipcMain,
  ipcRenderer: { invoke: async () => undefined, on: noop, send: noop },
  safeStorage,
  net: undefined,
  shell: { openExternal: async () => {}, showItemInFolder: noop },
  clipboard: { readText: () => "", writeText: noop },
  dialog: { showErrorBox: noop, showMessageBox: async () => ({ response: 0 }) },
  globalShortcut: { register: () => true, unregister: noop, unregisterAll: noop, isRegistered: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({ isEmpty: () => true }) },
  powerMonitor: { on: noop },
  screen: {
    getPrimaryDisplay: () => ({
      id: 1,
      scaleFactor: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    }),
    getAllDisplays() {
      return [this.getPrimaryDisplay()];
    },
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint() {
      return this.getPrimaryDisplay();
    },
    getDisplayMatching() {
      return this.getPrimaryDisplay();
    },
    on: noop,
  },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: noop } } },
  systemPreferences: { getMediaAccessStatus: () => "granted", askForMediaAccess: async () => true },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  Notification: class Notification {
    static isSupported() {
      return false;
    }
    show() {}
  },
  Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
  Tray: class Tray {},
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A test's own members win; anything it did not define falls back to this
// stub, one level deep, so a test that plants only `app.getVersion` still gets
// the `app.isPackaged` that debugLogger reads while loading.
function layered(own, base) {
  return new Proxy(own, {
    get(target, key) {
      if (!(key in target)) return base[key];
      const value = target[key];
      return isPlainObject(value) && isPlainObject(base[key]) ? layered(value, base[key]) : value;
    },
  });
}

const originalLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "electron") {
    // Several tests plant their own electron in require.cache. Returning this
    // stub unconditionally overrode them: they ran against a fixed version and
    // a shared temp folder instead of their own, and one left a file behind
    // that made it fail on every later run.
    try {
      const own = Module._cache[Module._resolveFilename(request, parent)];
      if (own && isPlainObject(own.exports)) return layered(own.exports, electron);
    } catch {}
    return electron;
  }
  return originalLoad.call(this, request, parent, ...rest);
};
