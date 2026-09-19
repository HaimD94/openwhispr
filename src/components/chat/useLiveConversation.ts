import { useCallback, useEffect, useRef, useState } from "react";
import {
  GeminiLiveAssistantSession,
  LiveTurnCollector,
  LIVE_INPUT_SAMPLE_RATE,
  LIVE_OUTPUT_SAMPLE_RATE,
  type LiveServerEvent,
  type LiveTurn,
} from "../../services/geminiLiveAssistant";
import { PcmPlayer } from "../../utils/pcmPlayer";

export type LiveConversationStatus = "idle" | "connecting" | "listening" | "speaking";

interface UseLiveConversationOptions {
  apiKey: string;
  onTurn: (turn: LiveTurn) => void | Promise<void>;
  onError: (message: string) => void;
}

// 800 samples at 16 kHz is 50 ms of speech per message.
const WORKLET_SOURCE = `
class LiveMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(800);
    this._offset = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= this._buffer.length) {
        this.port.postMessage(this._buffer.buffer, [this._buffer.buffer]);
        this._buffer = new Int16Array(800);
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("live-mic-processor", LiveMicProcessor);
`;

interface Capture {
  stream: MediaStream;
  context: AudioContext;
}

/**
 * A hands-free voice conversation: the mic streams to the model continuously,
 * the model's reply is played aloud, and each finished exchange is handed to
 * `onTurn` so it can land in the chat. The server decides when a turn ends.
 */
export function useLiveConversation({ apiKey, onTurn, onError }: UseLiveConversationOptions) {
  const [status, setStatus] = useState<LiveConversationStatus>("idle");
  const [caption, setCaption] = useState("");

  const sessionRef = useRef<GeminiLiveAssistantSession | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const collectorRef = useRef(new LiveTurnCollector());
  // Turns are persisted one after another so a chat created by the first turn
  // exists before the second one is saved into it.
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const activeRef = useRef(false);

  const onTurnRef = useRef(onTurn);
  onTurnRef.current = onTurn;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const releaseAudio = useCallback(() => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) {
      capture.stream.getTracks().forEach((track) => track.stop());
      capture.context.close().catch(() => {});
    }
    playerRef.current?.close();
    playerRef.current = null;
  }, []);

  const deliver = useCallback((turn: LiveTurn | null) => {
    if (!turn) return;
    queueRef.current = queueRef.current
      .then(() => onTurnRef.current(turn))
      .catch((error) => {
        onErrorRef.current(error instanceof Error ? error.message : String(error));
      });
  }, []);

  const teardown = useCallback(() => {
    activeRef.current = false;
    sessionRef.current?.close();
    sessionRef.current = null;
    releaseAudio();
    // Whatever was said before the session ended is still a real exchange.
    deliver(collectorRef.current.flush());
    setCaption("");
    setStatus("idle");
  }, [deliver, releaseAudio]);

  const handleEvent = useCallback(
    (event: LiveServerEvent) => {
      if (!activeRef.current) return;
      const collector = collectorRef.current;

      if (event.type === "audio") {
        playerRef.current?.enqueue(event.pcm);
        setStatus("speaking");
        return;
      }
      if (event.type === "interrupted") playerRef.current?.flush();

      const finished = collector.push(event);
      deliver(finished);

      if (event.type === "input" || event.type === "output") {
        const { user, assistant } = collector.pending;
        setCaption(event.type === "output" ? assistant : user);
      }
      if (
        event.type === "interrupted" ||
        (event.type === "turnComplete" && !playerRef.current?.isPlaying)
      ) {
        setStatus("listening");
      }
    },
    [deliver]
  );

  const start = useCallback(async () => {
    if (activeRef.current) return;
    if (!apiKey) {
      onErrorRef.current("Gemini API key is missing.");
      return;
    }
    activeRef.current = true;
    collectorRef.current = new LiveTurnCollector();
    setCaption("");
    setStatus("connecting");

    try {
      const session = new GeminiLiveAssistantSession({
        onEvent: handleEvent,
        onClose: ({ reason, code, wasReady }) => {
          // A close we asked for has already reset everything.
          if (!activeRef.current) return;
          if (wasReady) onErrorRef.current(reason || `Live conversation ended (${code}).`);
          teardown();
        },
      });
      sessionRef.current = session;
      await session.connect(apiKey);
      if (!activeRef.current) return;

      playerRef.current = new PcmPlayer(LIVE_OUTPUT_SAMPLE_RATE, () => {
        if (activeRef.current) setStatus("listening");
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!activeRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const context = new AudioContext({ sampleRate: LIVE_INPUT_SAMPLE_RATE });
      const workletUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" })
      );
      try {
        await context.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "live-mic-processor", {
        channelCount: 1,
        channelCountMode: "explicit",
      });
      node.port.onmessage = (message) => {
        sessionRef.current?.sendAudio(new Int16Array(message.data as ArrayBuffer));
      };
      // Chrome only pulls a worklet whose graph reaches the destination.
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(context.destination);
      captureRef.current = { stream, context };

      setStatus("listening");
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : String(error));
      teardown();
    }
  }, [apiKey, handleEvent, teardown]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    teardown();
  }, [teardown]);

  useEffect(
    () => () => {
      activeRef.current = false;
      sessionRef.current?.close();
      releaseAudio();
    },
    [releaseAudio]
  );

  return { status, caption, start, stop, isActive: status !== "idle" };
}
