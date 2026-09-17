const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/swallowedPressClickRecovery.ts");

/** Minimal stand-in for `window`: records the capture-phase listeners. */
function makeTarget() {
  const listeners = new Map();
  return {
    removed: [],
    addEventListener(type, listener, capture) {
      listeners.set(type, { listener, capture });
    },
    removeEventListener(type, listener, capture) {
      const entry = listeners.get(type);
      if (entry && entry.listener === listener) {
        listeners.delete(type);
        this.removed.push({ type, capture });
      }
    },
    emit(type, event) {
      const entry = listeners.get(type);
      if (!entry) return;
      entry.listener(event);
    },
    has(type) {
      return listeners.has(type);
    },
    captureOf(type) {
      return listeners.get(type)?.capture;
    },
  };
}

function makeNode(name, { connected = true } = {}) {
  return {
    name,
    isConnected: connected,
    dispatched: [],
    dispatchEvent(event) {
      this.dispatched.push(event);
      return true;
    },
  };
}

const press = (timeStamp, overrides = {}) => ({ button: 0, timeStamp, ...overrides });
const release = (timeStamp, target, overrides = {}) => ({
  button: 0,
  timeStamp,
  target,
  clientX: 30,
  clientY: 807,
  screenX: 30,
  screenY: 807,
  ...overrides,
});

/** Installs with every side effect captured: nothing runs until `flush()`. */
async function install(options = {}) {
  const { installSwallowedPressClickRecovery } = await load();
  const target = makeTarget();
  const queue = [];
  const created = [];
  const recovered = [];
  const uninstall = installSwallowedPressClickRecovery({
    target,
    document: options.document ?? null,
    schedule: (callback) => queue.push(callback),
    createClickEvent: (init) => {
      const event = { type: "click", init };
      created.push(event);
      return event;
    },
    onRecovered: (info) => recovered.push(info),
    ...options.recoveryOptions,
  });
  return {
    target,
    created,
    recovered,
    uninstall,
    flush: () => {
      while (queue.length) queue.shift()();
    },
    pending: () => queue.length,
  };
}

test("a mouseup with no mousedown dispatches the click Windows ate", async () => {
  const { target, created, recovered, flush } = await install();
  const node = makeNode("pill");

  // What the debug log shows for a swallowed press: the release, alone.
  target.emit("mouseup", release(4186, node));
  flush();

  assert.equal(node.dispatched.length, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].init.bubbles, true);
  assert.equal(created[0].init.cancelable, true);
  assert.equal(created[0].init.button, 0);
  assert.equal(created[0].init.detail, 1);
  assert.equal(created[0].init.clientX, 30);
  assert.equal(created[0].init.clientY, 807);
  assert.deepEqual(recovered, [{ target: node, retargeted: false }]);
});

test("a mouseup that had its mousedown is left to the browser's own click", async () => {
  const { target, created, recovered, flush, pending } = await install();
  const node = makeNode("pill");

  target.emit("mousedown", press(20620));
  target.emit("mouseup", release(22467, node));

  assert.equal(pending(), 0);
  flush();
  assert.equal(node.dispatched.length, 0);
  assert.equal(created.length, 0);
  assert.deepEqual(recovered, []);
});

test("each press covers only its own release", async () => {
  const { target, flush } = await install();
  const first = makeNode("first");
  const second = makeNode("second");

  target.emit("mousedown", press(1000));
  target.emit("mouseup", release(1100, first));
  // The next press is swallowed; the earlier one must not vouch for it.
  target.emit("mouseup", release(1400, second));
  flush();

  assert.equal(first.dispatched.length, 0);
  assert.equal(second.dispatched.length, 1);
});

test("a press whose release never arrived expires instead of eating the next recovery", async () => {
  const { target, flush } = await install();
  const node = makeNode("pill");

  // Pressed, then let go outside the window: no mouseup ever reaches us.
  target.emit("mousedown", press(1000));
  target.emit("mouseup", release(1000 + 30001, node));
  flush();

  assert.equal(node.dispatched.length, 1);
});

test("only the left button is recovered", async () => {
  const { target, flush } = await install();
  const node = makeNode("pill");

  // Right-click already works: Windows raises contextmenu off the button-up.
  target.emit("mouseup", release(500, node, { button: 2 }));
  target.emit("mouseup", release(600, node, { button: 1 }));
  flush();

  assert.equal(node.dispatched.length, 0);
});

test("a right-button press does not vouch for the next left release", async () => {
  const { target, flush } = await install();
  const node = makeNode("pill");

  target.emit("mousedown", press(900, { button: 2 }));
  target.emit("mouseup", release(1000, node));
  flush();

  assert.equal(node.dispatched.length, 1);
});

test("the click follows the cursor when the pressed element is gone by then", async () => {
  const underCursor = makeNode("chevron-replacement");
  const points = [];
  const { target, recovered, flush } = await install({
    document: {
      elementFromPoint(x, y) {
        points.push([x, y]);
        return underCursor;
      },
    },
  });
  const detached = makeNode("hover-only-chevron", { connected: false });

  target.emit("mouseup", release(4186, detached));
  flush();

  assert.equal(detached.dispatched.length, 0);
  assert.equal(underCursor.dispatched.length, 1);
  assert.deepEqual(points, [[30, 807]]);
  assert.deepEqual(recovered, [{ target: underCursor, retargeted: true }]);
});

test("a detached element with nothing under the cursor dispatches nothing", async () => {
  const { target, recovered, flush } = await install({
    document: { elementFromPoint: () => null },
  });
  const detached = makeNode("gone", { connected: false });

  target.emit("mouseup", release(4186, detached));
  flush();

  assert.deepEqual(recovered, []);
});

test("the click is deferred, so the page's own mouseup handlers run first", async () => {
  const { target, pending, flush } = await install();
  const node = makeNode("pill");

  target.emit("mouseup", release(4186, node));
  assert.equal(node.dispatched.length, 0, "must not dispatch inside the capture listener");
  assert.equal(pending(), 1);
  flush();
  assert.equal(node.dispatched.length, 1);
});

test("it listens in the capture phase and unhooks both listeners", async () => {
  const { target, uninstall } = await install();

  assert.equal(target.captureOf("mousedown"), true);
  assert.equal(target.captureOf("mouseup"), true);

  uninstall();
  assert.equal(target.has("mousedown"), false);
  assert.equal(target.has("mouseup"), false);
  assert.deepEqual(
    target.removed.map((entry) => entry.type),
    ["mousedown", "mouseup"]
  );
});

test("installing without a usable target is a no-op", async () => {
  const { installSwallowedPressClickRecovery } = await load();

  assert.doesNotThrow(() => installSwallowedPressClickRecovery({ target: null })());
  assert.doesNotThrow(() => installSwallowedPressClickRecovery({ target: {} })());
});
