// What the dictation realtime stop handler hands back to the renderer.
//
// Gemini Live, OpenAI Realtime and Tinfoil share one stop channel, and it used
// to return the transcript and nothing else. The renderer fills a missing model
// with Deepgram's "nova-3", so every dictation through these engines was saved
// to history under a model that never touched it. Deepgram and Corti already
// report their model from their own stop handlers; this brings the shared
// channel in line with them.

// Gemini's wire format wants "models/<id>", but the id everywhere else in the
// app (the registry, settings, the history row) is the bare name.
function reportedModelName(model) {
  if (typeof model !== "string") return undefined;
  const name = model.trim().replace(/^models\//, "");
  return name || undefined;
}

async function stopRealtimeSession(streaming) {
  if (!streaming) return { success: true, text: "" };
  // Read before disconnect(): tearing a session down is exactly the kind of
  // step that may reset client state, and the Deepgram and Corti handlers
  // snapshot their model first for the same reason.
  const model = reportedModelName(streaming.model);
  const result = await streaming.disconnect().catch(() => ({ text: "" }));
  const stopped = { success: true, text: result?.text || "" };
  // Left out rather than null when unknown, so the renderer's own fallback
  // still applies exactly as it did before.
  if (model) stopped.model = model;
  return stopped;
}

module.exports = { reportedModelName, stopRealtimeSession };
