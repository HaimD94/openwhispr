const { net } = require("electron");
const debugLogger = require("./debugLogger");

// gemini-3.5-transcribe is only served by the Interactions API; there is no
// generateContent or OpenAI-compatible endpoint for it.
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

// The split runs the other way too: the live id is served only over the Live
// WebSocket API, and sending it here comes back as
//   400 Model 'gemini-3.5-transcribe-live' not found.
//       Did you mean 'gemini-3.5-transcribe'?
// Anyone whose dictation model is the live one hits that on every batch
// request -- re-transcribing from history, transcribing a file, the streaming
// fallback -- because the model travels with the route and nothing along the
// way knows the two endpoints offer different catalogues.
//
// The translation belongs here rather than in resolveByokModel: that resolver
// answers "which model did the user choose for this provider", and a test pins
// every registry model to survive it unchanged so nobody's pick is silently
// replaced. Batch-vs-streaming is a fact about *this* endpoint, and putting it
// at the endpoint means no call site can route around it.
const BATCH_MODEL_FOR_STREAMING_ONLY = {
  "gemini-3.5-transcribe-live": "gemini-3.5-transcribe",
  "models/gemini-3.5-transcribe-live": "gemini-3.5-transcribe",
};

// Gemini documents audio/mp3 and audio/aac instead of the audio/mpeg and
// audio/mp4 types the rest of the pipeline uses.
const GEMINI_MIME_TYPES = {
  "audio/mpeg": "audio/mp3",
  "audio/mp4": "audio/aac",
};

// The full transcript lives in output_text, but the documented sample response
// omits it — joining the steps' text content is the safe fallback.
function extractText(data) {
  const outputText = data?.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText;
  }
  return (data?.steps || [])
    .flatMap((step) => step?.content || [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

async function transcribeWithGemini(
  { audioBuffer, model, contentType, language, keyterms, apiKey, swapStreamingOnlyModel = true },
  fetchImpl
) {
  if (!apiKey?.trim()) {
    const error = new Error("Gemini API key not configured. Add your key in Settings.");
    error.code = "API_KEY_MISSING";
    throw error;
  }

  // The swap can be switched off from settings, to rule it out when chasing a
  // bug. Off means the live id goes to this endpoint as-is, and the 400 above
  // comes back -- that is the expected result, not a new failure.
  const requestedModel = (model || "").trim();
  const swapped = swapStreamingOnlyModel ? BATCH_MODEL_FOR_STREAMING_ONLY[requestedModel] : null;
  const resolvedModel = swapped || requestedModel || "gemini-3.5-transcribe";
  if (requestedModel && resolvedModel !== requestedModel) {
    debugLogger.info(
      "Gemini streaming-only model swapped for its batch equivalent",
      { requested: requestedModel, used: resolvedModel },
      "gemini"
    );
  }
  const transcriptionConfig = {};
  if (language && language !== "auto") {
    transcriptionConfig.language_codes = [language];
  }
  if (keyterms && keyterms.length > 0) {
    transcriptionConfig.custom_vocabulary = keyterms;
  }
  const requestBody = {
    model: resolvedModel,
    input: [
      {
        type: "audio",
        data: (Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer)).toString(
          "base64"
        ),
        mime_type: GEMINI_MIME_TYPES[contentType] || contentType,
      },
    ],
  };
  if (Object.keys(transcriptionConfig).length > 0) {
    requestBody.generation_config = { transcription_config: transcriptionConfig };
  }

  debugLogger.debug(
    "Gemini batch transcription starting",
    { model: resolvedModel, language, audioBytes: audioBuffer.byteLength },
    "transcription"
  );

  const doFetch = fetchImpl || ((url, init) => net.fetch(url, init));
  const response = await doFetch(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    // Google rejects a bad key with 400 + reason API_KEY_INVALID rather than 401,
    // so status alone would surface the raw JSON instead of a fixable message.
    if (
      response.status === 401 ||
      response.status === 403 ||
      errorText.includes("API_KEY_INVALID")
    ) {
      const error = new Error("Invalid Gemini API key. Check your key in Settings.");
      error.code = "INVALID_KEY";
      throw error;
    }
    const error = new Error(`Gemini API Error: ${response.status} ${errorText}`.trim());
    if (response.status === 429) {
      error.code = "PROVIDER_RATE_LIMITED";
      error.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
    } else if (response.status >= 500) {
      error.code = "SERVER_ERROR";
    }
    throw error;
  }

  const data = await response.json();
  // Anything short of "completed" (failed, cancelled, budget_exceeded, ...) must
  // not fall through to extractText, which would return empty or truncated text
  // as a successful transcription.
  if (data?.status && data.status !== "completed") {
    const detail = data?.error?.message;
    throw new Error(
      detail
        ? `Gemini transcription failed: ${detail}`
        : `Gemini transcription did not complete (status: ${data.status})`
    );
  }
  return { text: extractText(data), model: resolvedModel };
}

module.exports = { transcribeWithGemini };
