const test = require("node:test");
const assert = require("node:assert/strict");

// The gap this closes: Note Recording's provider list is derived from the model
// registry (any provider with a `streaming: true` model), while what can
// actually connect is decided by two hand-maintained tables in the main
// process. Adding gemini-3.5-transcribe-live put Gemini in the picker and
// nowhere else, so choosing it offered the user a provider that failed at
// connect time. Nothing tied the three together, so nothing complained.

const loadRegistry = () => import("../../src/models/ModelRegistry.ts");
const loadRouting = () => import("../../src/helpers/meetingTranscriptionRouting.js");
const loadProviders = () => import("../../src/helpers/meetingStreamingProviders.js");
const loadTokens = () => import("../../src/helpers/realtimeTokenProviders.js");

// Mirrors MeetingSettings.tsx, which builds its list exactly this way.
async function providersOfferedForNoteRecording() {
  const { getStreamingTranscriptionProviders } = await loadRegistry();
  return getStreamingTranscriptionProviders();
}

async function routeFor(provider) {
  const { resolveMeetingTranscriptionOptions } = await loadRouting();
  return resolveMeetingTranscriptionOptions({
    transcriptionMode: "providers",
    language: "auto",
    selectedProvider: provider.id,
    selectedModel: provider.models[0].id,
    byokProviders: [provider],
  });
}

test("the picker offers at least one streaming provider", async () => {
  const offered = await providersOfferedForNoteRecording();
  assert.ok(offered.length > 0, "no streaming providers in the registry at all");
});

test("every provider the picker offers can actually be connected", async () => {
  const offered = await providersOfferedForNoteRecording();
  const { STREAMING_CLIENT_BY_PROVIDER, ALLOWED_MEETING_PROVIDERS } = await loadProviders();
  const { REALTIME_TOKEN_PROVIDERS } = await loadTokens();

  const broken = [];
  for (const provider of offered) {
    const route = await routeFor(provider);
    const id = route.provider;
    if (!ALLOWED_MEETING_PROVIDERS.has(id)) broken.push(`${provider.id} -> ${id}: not allow-listed`);
    if (!STREAMING_CLIENT_BY_PROVIDER[id]) broken.push(`${provider.id} -> ${id}: no streaming client`);
    if (typeof REALTIME_TOKEN_PROVIDERS[id] !== "function") {
      broken.push(`${provider.id} -> ${id}: no token entry`);
    }
  }

  assert.deepEqual(broken, [], `Note Recording offers providers it cannot run:\n${broken.join("\n")}`);
});

test("Gemini specifically routes to the name the rest of the app already uses", async () => {
  // The regression itself: the generic "<id>-realtime" rule produced
  // "gemini-realtime", but the engine, the token entry and dictation routing
  // all call it "gemini-live".
  const offered = await providersOfferedForNoteRecording();
  const gemini = offered.find((p) => p.id === "gemini");
  assert.ok(gemini, "gemini is no longer offered for note recording - update this test");

  const route = await routeFor(gemini);
  assert.equal(route.provider, "gemini-live");
  assert.equal(route.model, "gemini-3.5-transcribe-live");
});

test("providers with no streaming model are not offered", async () => {
  const offered = await providersOfferedForNoteRecording();
  for (const provider of offered) {
    assert.ok(
      provider.models.some((m) => m.streaming),
      `${provider.id} is offered for note recording with no streaming model`
    );
  }
});
