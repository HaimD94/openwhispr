const DEFAULT_MANAGED_PROVIDER = {
  id: "openai",
  models: [{ id: "gpt-4o-mini-transcribe", default: true }],
};

// Every other provider's streaming id is "<id>-realtime". Gemini's is not:
// its engine, its token entry and its dictation routing all call it
// "gemini-live", so the generic rule produced a name no allowlist knew and the
// connection failed even though the picker offered the provider.
const STREAMING_PROVIDER_ID = { gemini: "gemini-live" };
const streamingProviderId = (providerId) =>
  STREAMING_PROVIDER_ID[providerId] || `${providerId}-realtime`;

const resolveModel = (provider, selectedModel) =>
  provider.models.find((model) => model.id === selectedModel)?.id ??
  provider.models.find((model) => model.default)?.id ??
  provider.models[0]?.id;

export function resolveMeetingTranscriptionOptions({
  transcriptionMode,
  language,
  localProvider,
  whisperModel,
  parakeetModel,
  cohereModel,
  selectedProvider,
  selectedModel,
  byokProviders,
  managedProviders,
  cortiEnvironment,
  cortiTenant,
  keyterms,
}) {
  if (transcriptionMode === "local") {
    return {
      provider: "local",
      localProvider,
      localModel:
        localProvider === "nvidia"
          ? parakeetModel || "parakeet-tdt-0.6b-v3"
          : localProvider === "cohere"
            ? cohereModel || "cohere-transcribe-03-2026"
            : whisperModel || "base",
      language,
    };
  }

  if (transcriptionMode === "openwhispr") {
    const provider = managedProviders?.[0] ?? DEFAULT_MANAGED_PROVIDER;
    return {
      provider: streamingProviderId(provider.id),
      model: resolveModel(provider, selectedModel),
      mode: "openwhispr",
      language,
    };
  }

  if (transcriptionMode === "self-hosted") {
    throw new Error(
      "Self-hosted realtime transcription is not supported for Note Recording. Choose Local or Cloud Providers."
    );
  }

  if (transcriptionMode !== "providers") {
    throw new Error(`Unsupported Note Recording transcription mode: ${transcriptionMode}`);
  }

  const provider = byokProviders.find((candidate) => candidate.id === selectedProvider);
  if (!provider) {
    throw new Error(`Unsupported Note Recording provider: ${selectedProvider || "none selected"}`);
  }

  const options = {
    provider: streamingProviderId(provider.id),
    model: resolveModel(provider, selectedModel),
    mode: "byok",
    language,
  };

  if (provider.id === "corti") {
    return {
      ...options,
      environment: cortiEnvironment,
      tenant: cortiTenant,
      keyterms,
    };
  }

  return options;
}
