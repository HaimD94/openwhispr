// Voice conversation with a conversational Gemini Live model (gemini-3.8-live).
//
// Measured against the real server (GEMINI-LIVE-PATCH/probe-conversation.js):
// this model refuses TEXT output (close 1007) and answers only as AUDIO, with
// the words arriving as `outputAudioTranscription`. What the user said arrives
// as `inputAudioTranscription`. Both are incremental fragments, so consumers
// append; the dictation model (geminiLiveStreaming.js) revises instead.

export const LIVE_ASSISTANT_MODEL = "gemini-3.8-live";

export const LIVE_INPUT_SAMPLE_RATE = 16000;
export const LIVE_OUTPUT_SAMPLE_RATE = 24000;

const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const BASE_INSTRUCTION =
  "You are a voice assistant inside a desktop dictation app. Keep answers short and " +
  "conversational, since they are read aloud.";

// Without a language the model guesses from the first sounds and can land on a
// neighbouring language (Hebrew heard as Spanish), so the user's chosen language
// is stated outright. "auto" (no code) keeps the guess-and-follow behaviour.
export function buildSystemInstruction(language?: string): string {
  if (!language) {
    return `${BASE_INSTRUCTION} Answer in the language the user speaks.`;
  }
  let name = language;
  try {
    name = new Intl.DisplayNames(["en"], { type: "language" }).of(language) || language;
  } catch {
    // An unknown code is still passed through as written.
  }
  return (
    `${BASE_INSTRUCTION} The user speaks ${name} (${language}). Always listen for ${name} and ` +
    `answer in ${name}, unless the user clearly switches to another language.`
  );
}

export type LiveServerEvent =
  | { type: "ready" }
  | { type: "input"; text: string }
  | { type: "output"; text: string }
  | { type: "audio"; pcm: Int16Array }
  | { type: "interrupted" }
  | { type: "turnComplete" }
  | { type: "goAway"; timeLeft?: string };

export interface LiveTurn {
  user: string;
  assistant: string;
}

function decodeBase64Pcm(data: string): Int16Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

export function encodePcmBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

// One server message can carry several things at once (a transcript fragment
// next to audio), so this returns a list in the order they should be applied.
export function parseLiveServerMessage(raw: unknown): LiveServerEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const message = raw as Record<string, any>;
  const events: LiveServerEvent[] = [];

  if (message.setupComplete) events.push({ type: "ready" });
  if (message.goAway) events.push({ type: "goAway", timeLeft: message.goAway.timeLeft });

  const content = message.serverContent;
  if (!content) return events;

  // An interruption invalidates whatever audio was queued, so it goes first.
  if (content.interrupted) events.push({ type: "interrupted" });

  const heard = content.inputTranscription?.text;
  if (typeof heard === "string" && heard) events.push({ type: "input", text: heard });

  for (const part of content.modelTurn?.parts ?? []) {
    const data = part?.inlineData?.data;
    if (typeof data === "string" && data)
      events.push({ type: "audio", pcm: decodeBase64Pcm(data) });
  }

  const said = content.outputTranscription?.text;
  if (typeof said === "string" && said) events.push({ type: "output", text: said });

  if (content.turnComplete) events.push({ type: "turnComplete" });
  return events;
}

// Groups the transcript fragments into whole turns. A turn ends when the model
// finishes (turnComplete) or when the user cuts it off (interrupted); the
// speech that caused the interruption is transcribed after that event, so it
// starts the next turn rather than being glued onto the cut-off one.
export class LiveTurnCollector {
  private user = "";
  private assistant = "";

  push(event: LiveServerEvent): LiveTurn | null {
    switch (event.type) {
      case "input":
        this.user += event.text;
        return null;
      case "output":
        this.assistant += event.text;
        return null;
      case "interrupted":
      case "turnComplete":
        return this.flush();
      default:
        return null;
    }
  }

  flush(): LiveTurn | null {
    const turn = { user: this.user.trim(), assistant: this.assistant.trim() };
    this.user = "";
    this.assistant = "";
    return turn.user || turn.assistant ? turn : null;
  }

  get pending(): LiveTurn {
    return { user: this.user.trim(), assistant: this.assistant.trim() };
  }
}

export function buildLiveSetupMessage(model: string = LIVE_ASSISTANT_MODEL, language?: string) {
  return {
    setup: {
      model: `models/${model.replace(/^models\//, "")}`,
      generationConfig: { responseModalities: ["AUDIO"] },
      systemInstruction: { parts: [{ text: buildSystemInstruction(language) }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

export interface LiveSessionHandlers {
  onEvent: (event: LiveServerEvent) => void;
  onClose: (info: { code: number; reason: string; wasReady: boolean }) => void;
}

export class GeminiLiveAssistantSession {
  private ws: WebSocket | null = null;
  private ready = false;

  constructor(private readonly handlers: LiveSessionHandlers) {}

  get isReady() {
    return this.ready;
  }

  connect(apiKey: string, model: string = LIVE_ASSISTANT_MODEL, language?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(apiKey)}`);
      this.ws = ws;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      ws.onopen = () => ws.send(JSON.stringify(buildLiveSetupMessage(model, language)));

      ws.onmessage = async (message) => {
        // The browser delivers server frames as Blobs; the payload is JSON text.
        const text =
          typeof message.data === "string" ? message.data : await (message.data as Blob).text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        for (const event of parseLiveServerMessage(parsed)) {
          if (event.type === "ready") {
            this.ready = true;
            if (!settled) {
              settled = true;
              resolve();
            }
          }
          this.handlers.onEvent(event);
        }
      };

      ws.onerror = () => fail(new Error("Could not reach Gemini Live."));

      ws.onclose = (event) => {
        const wasReady = this.ready;
        this.ready = false;
        fail(new Error(event.reason || `Gemini Live closed before it was ready (${event.code}).`));
        this.handlers.onClose({ code: event.code, reason: event.reason, wasReady });
      };
    });
  }

  // Audio sent before setupComplete is discarded by the server, so callers
  // start the microphone only after connect() resolves.
  sendAudio(pcm: Int16Array) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: encodePcmBase64(pcm),
            mimeType: `audio/pcm;rate=${LIVE_INPUT_SAMPLE_RATE}`,
          },
        },
      })
    );
  }

  close() {
    this.ready = false;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onmessage = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }
}
