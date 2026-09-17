const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The harness renders i18n keys verbatim (no i18next instance is initialized),
// so assertions match on the raw translation key rather than resolved copy.
async function renderMenu(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-pill-command-menu-test-",
  });
  const mod = await vite.ssrLoadModule("/components/dictation/PillCommandMenu.tsx");
  return renderToStaticMarkup(
    createElement(mod.PillCommandMenu, {
      buttonRef: { current: null },
      isRecording: false,
      agentAllowed: true,
      meetingAllowed: true,
      isHovered: false,
      setWindowInteractivity: () => {},
      onToggleListening: () => {},
      onAskAssistant: () => {},
      onStartMeeting: () => {},
      onHide: () => {},
      onClose: () => {},
      ...props,
    })
  );
}

test("the command menu hides Ask Assistant while a recording is active", async (t) => {
  const idleMarkup = await renderMenu(t, { isRecording: false });
  assert.match(idleMarkup, /askAssistant/);

  const recordingMarkup = await renderMenu(t, { isRecording: true });
  assert.doesNotMatch(recordingMarkup, /askAssistant/);
});

// #2064: a menu always anchored on the pill's right edge hung past the window's left edge (and
// was clipped) whenever the pill docked at the left or center.
test("the command menu anchors on the pill's docked side", async (t) => {
  const menuClasses = async (anchor) => {
    const markup = await renderMenu(t, { anchor });
    return markup.match(/^<div class="([^"]*)"/)[1].split(" ");
  };

  const right = await menuClasses("right");
  assert.ok(right.includes("right-0"));
  assert.ok(!right.includes("left-0"));

  const left = await menuClasses("left");
  assert.ok(left.includes("left-0"));
  assert.ok(!left.includes("right-0"));

  const center = await menuClasses("center");
  assert.ok(center.includes("left-1/2") && center.includes("-translate-x-1/2"));

  // The dock is a physical screen edge, so a logical anchor would flip sides in RTL.
  for (const classes of [right, left, center]) {
    assert.ok(!classes.includes("end-0") && !classes.includes("start-0"));
  }
});

test("the command menu offers a meeting recording only while idle and allowed", async (t) => {
  assert.match(await renderMenu(t, {}), /startMeetingRecording/);
  assert.doesNotMatch(await renderMenu(t, { isRecording: true }), /startMeetingRecording/);
  assert.doesNotMatch(await renderMenu(t, { meetingAllowed: false }), /startMeetingRecording/);
});

test("the command menu opens toward the side its window grows into", async (t) => {
  // A pill docked on the left sits at the window's left edge; the menu used to
  // be right-aligned always, so there it started at negative x and was clipped
  // away entirely.
  const leftMarkup = await renderMenu(t, { anchor: "left" });
  assert.match(leftMarkup, /\bleft-0\b/);
  assert.doesNotMatch(leftMarkup, /\bright-0\b/);
  assert.doesNotMatch(leftMarkup, /\bend-0\b/);

  const rightMarkup = await renderMenu(t, { anchor: "right" });
  assert.match(rightMarkup, /\bright-0\b/);
  assert.doesNotMatch(rightMarkup, /\bleft-0\b/);
  assert.doesNotMatch(rightMarkup, /\bend-0\b/);

  const defaultMarkup = await renderMenu(t, {});
  assert.match(defaultMarkup, /\bright-0\b/);
  assert.doesNotMatch(defaultMarkup, /\bleft-0\b/);
  assert.doesNotMatch(defaultMarkup, /\bend-0\b/);

  // A centered pill grows its window both ways, so the menu centers on it.
  const centerMarkup = await renderMenu(t, { anchor: "center" });
  assert.match(centerMarkup, /\bleft-1\/2\b/);
  assert.match(centerMarkup, /-translate-x-1\/2/);
  assert.doesNotMatch(centerMarkup, /\bright-0\b/);
});

test("the command menu renders below the pill when told it is top-docked", async (t) => {
  const topMarkup = await renderMenu(t, { verticalAnchor: "top" });
  assert.match(topMarkup, /\btop-full\b/);
  assert.match(topMarkup, /\bmt-3\b/);
  assert.doesNotMatch(topMarkup, /\bbottom-full\b/);
  assert.doesNotMatch(topMarkup, /\bmb-3\b/);

  const topDockedFlagMarkup = await renderMenu(t, { topDocked: true });
  assert.match(topDockedFlagMarkup, /\btop-full\b/);
  assert.match(topDockedFlagMarkup, /\bmt-3\b/);
  assert.doesNotMatch(topDockedFlagMarkup, /\bbottom-full\b/);
  assert.doesNotMatch(topDockedFlagMarkup, /\bmb-3\b/);

  const bottomMarkup = await renderMenu(t, { verticalAnchor: "bottom" });
  assert.match(bottomMarkup, /\bbottom-full\b/);
  assert.match(bottomMarkup, /\bmb-3\b/);
  assert.doesNotMatch(bottomMarkup, /\btop-full\b/);
  assert.doesNotMatch(bottomMarkup, /\bmt-3\b/);

  const defaultMarkup = await renderMenu(t, {});
  assert.match(defaultMarkup, /\bbottom-full\b/);
  assert.match(defaultMarkup, /\bmb-3\b/);
  assert.doesNotMatch(defaultMarkup, /\btop-full\b/);
  assert.doesNotMatch(defaultMarkup, /\bmt-3\b/);
});
