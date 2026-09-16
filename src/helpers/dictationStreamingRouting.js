// Single source of truth for dictation/notes realtime STT routing: which
// streaming provider a settings state resolves to, and the exact session
// options every provider receives over IPC. Provider facts scattered across
// call sites is what broke default dictation in 1.8.2 (#1624: the
// openai-realtime entry never sent `provider`, and the hardened main-process
// allowlist rejected undefined). Pure module, mirrors meetingTranscriptionRouting.

export const REALTIME_MODELS = new Set(["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]);

export function defaultStreamingProviderName(context) {
  return context === "notes" ? "deepgram" : "openai-realtime";
}

export function resolveStreamingProviderName({ settings, context, sttConfig }) {
  if (
    settings.cloudTranscriptionProvider === "gemini" &&
    settings.cloudTranscriptionModel === "gemini-3.5-transcribe-live"
  ) {
    return "gemini-live";
  }
  if (settings.cloudTranscriptionProvider === "tinfoil") {
    return "tinfoil-realtime";
  }
  if (
    settings.cloudTranscriptionProvider === "corti" &&
    settings.cloudTranscriptionMode === "byok"
  ) {
    return "corti";
  }
  if (REALTIME_MODELS.has(settings.cloudTranscriptionModel)) {
    return "openai-realtime";
  }
  return sttConfig?.streamingProvider || defaultStreamingProviderName(context);
}

export function buildStreamingSessionOptions({
  providerName,
  settings,
  language,
  keyterms,
  voiceAgentRequested = false,
}) {
  const options = {
    provider: providerName,
    sampleRate: 16000,
    language: language && language !== "auto" ? language : undefined,
    keyterms,
    model: settings.cloudTranscriptionModel,
    mode: settings.cloudTranscriptionMode === "byok" ? "byok" : "openwhispr",
    environment: settings.cortiEnvironment,
    tenant: settings.cortiTenant,
  };
  // Tinfoil realtime shows the live preview for normal dictation (#1120), but
  // assistant voice skips it because the Assistant panel owns that surface.
  if ((providerName === "tinfoil-realtime" || providerName === "gemini-live") && !voiceAgentRequested) {
    options.preview = true;
  }
  return options;
}

// Providers whose streaming session, if it will not open, has an equally good
// non-streaming route through the same provider, the same key and the same
// price. For those, a failed connection is a reason to record the ordinary way
// and transcribe the file -- not a reason to lose what the user is about to
// say. Gemini Live is one: its batch sibling is also free of charge, and the
// batch route already translates the streaming-only model id for itself.
const PROVIDERS_WITH_A_BATCH_TWIN = new Set(["gemini-live"]);

/**
 * What to do when a streaming session fails to start.
 *
 * These three conditions grew inline inside startStreamingRecording, where the
 * only way to reach them is to stand up the whole microphone pipeline -- so the
 * rule that decides whether a user keeps their dictation had no test at all.
 *
 * Returns `{ fallback, notice }`. `fallback: true` means record normally and
 * transcribe the file afterwards; `notice` is shown first when the user should
 * know their words are taking a different route than usual. `fallback: false`
 * means the caller should throw, because nothing else would produce a
 * transcript.
 */
export function resolveStreamingStartFailure({ providerName, code, useLocalWhisper = false }) {
  // Nothing was configured to stream with; the batch path is simply the path.
  // No notice: this is the ordinary state of an app without a streaming key,
  // not a degradation of anything the user chose.
  if (code === "NO_API") {
    return { fallback: true, notice: null };
  }

  if (code === "NETWORK_ERROR" && useLocalWhisper) {
    return {
      fallback: true,
      notice: {
        code,
        title: "streaming.errors.cloudUnreachable.title",
        description: "Cloud unreachable — using local engine for this recording.",
        messageKey: "streaming.errors.cloudUnreachable.fallback",
      },
    };
  }

  if (PROVIDERS_WITH_A_BATCH_TWIN.has(providerName)) {
    return {
      fallback: true,
      notice: {
        code,
        title: "streaming.errors.liveUnavailable.title",
        description: "Gemini Live could not start — recording this one normally instead.",
        messageKey: "streaming.errors.liveUnavailable.fallback",
      },
    };
  }

  return { fallback: false, notice: null };
}
