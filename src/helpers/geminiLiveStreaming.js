const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const WEBSOCKET_TIMEOUT_MS = 15000;
const DISCONNECT_TIMEOUT_MS = 5000;
const DEFAULT_MODEL = "models/gemini-3.5-transcribe-live";
const GEMINI_LIVE_BASE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// What "auto" means for this transcriber. Hebrew plus English is a deliberate
// pairing, not a placeholder: the app's own Hebrew cleanup prompt asks to
// "preserve any English technical terms as the user spoke them", and the
// transcriber can only keep them in Latin script if English is one of the
// languages it is listening for. Every explicit language choice goes through
// resolveLanguageCodes below instead.
const AUTO_LANGUAGE_CODES = ["he-IL", "en-US"];

/** OpenWhispr stores bare language codes ("he"); Gemini's setup message takes
 *  region-qualified BCP-47 tags ("he-IL"). The bare form is accepted by the
 *  server -- but so was a snake_case field name that cannot possibly be right,
 *  which is how we know this server accepts setup it then ignores. So the
 *  known-good shape is kept and only its content follows the setting, with
 *  CLDR supplying the region rather than a hand-written table of guesses. */
function toRegionQualified(code) {
  try {
    const locale = new Intl.Locale(code);
    const region = locale.maximize().region;
    return region ? `${locale.language}-${region}` : code;
  } catch {
    // An unrecognised tag is passed through rather than dropped: the server
    // ignoring one code is a smaller failure than transcribing in the wrong
    // language because we silently removed it.
    return code;
  }
}

// Dictation captures at 16kHz; note recording runs the meeting pipeline at
// 24kHz. The rate is declared on every chunk rather than assumed, because the
// two are not interchangeable -- the same fifteen seconds of speech came back
// as different text at each rate, and each rate was deterministic across
// repeated runs, so that is the rate talking rather than model noise.
//
// Converting 24kHz down to 16kHz before sending was tried and measured WORSE
// than simply declaring 24kHz: a box-average decimation over a ratio of 1.5 is
// too short a filter to stop aliasing while still damaging the speech it
// keeps, and it turned a clean word into a garbled one. Sending the audio at
// the rate it was captured at is both simpler and better. A proper
// polyphase/windowed-sinc resampler might beat both, but a naive one is worse
// than nothing -- see GEMINI-LIVE-PATCH/FACTS.md for the three transcripts.
const DEFAULT_INPUT_RATE = 16000;

function resolveLanguageCodes(language) {
  if (!language || language === "auto") return AUTO_LANGUAGE_CODES;
  const primary = toRegionQualified(language);
  // English rides along with any other choice, for the same reason it is in
  // AUTO_LANGUAGE_CODES. A user who picked English needs no second entry --
  // and keeps the variety they picked, so en-GB is not quietly made en-US.
  return primary.startsWith("en") ? [primary] : [primary, "en-US"];
}

class GeminiLiveStreaming {
  constructor() {
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;

    this.providerLabel = "Gemini Live";

    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.completedSegments = [];
    this.isDisconnecting = false;
    this.bufferingAudio = false;
    this.coldStartBuffer = [];

    this.currentPartial = "";
    this.audioBytesSent = 0;
    this.model = DEFAULT_MODEL;
    this.connectionTimeout = null;
    this.pendingResolve = null;
    this.pendingReject = null;

    this._audioStreamEnded = false;
    this._disconnectResolve = null;
    this._disconnectTimeout = null;
    // The rate the caller feeds us, which is not always the rate Gemini wants.
    this.inputRate = DEFAULT_INPUT_RATE;
    // When the speech behind the segment being assembled began. Every other
    // engine hands this to onFinalTranscript, and meeting transcription uses
    // it to tell a real microphone segment from system audio bleeding back in.
    this._segmentStartedAt = null;
  }

  beginConnecting() {
    this.bufferingAudio = true;
    this.coldStartBuffer = [];
  }

  getFullTranscript() {
    return this.completedSegments.join(" ");
  }

  async connect(options = {}) {
    // Two callers, two names for the same number: dictation passes inputRate
    // (matching the tinfoil path), meeting transcription passes sampleRate.
    const { apiKey, model, language, keyterms, inputRate, sampleRate } = options;
    if (!apiKey) throw new Error(`${this.providerLabel} API key is required`);

    if (this.isConnected || this.isConnecting) {
      debugLogger.debug(`${this.providerLabel} already connected/connecting`);
      return;
    }

    if (!this.bufferingAudio) this.beginConnecting();

    this.isConnecting = true;

    let selectedModel = model || DEFAULT_MODEL;
    if (!selectedModel.startsWith("models/")) {
      selectedModel = `models/${selectedModel}`;
    }
    this.model = selectedModel;

    this.completedSegments = [];
    this.currentPartial = "";
    this.audioBytesSent = 0;
    this._audioStreamEnded = false;
    this._segmentStartedAt = null;
    const declaredRate = inputRate ?? sampleRate;
    this.inputRate =
      Number.isFinite(declaredRate) && declaredRate > 0 ? declaredRate : DEFAULT_INPUT_RATE;
    if (this.inputRate !== DEFAULT_INPUT_RATE) {
      debugLogger.debug(`${this.providerLabel} input rate`, { rate: this.inputRate });
    }

    const url = `${GEMINI_LIVE_BASE_URL}?key=${encodeURIComponent(apiKey)}`;
    debugLogger.debug(`${this.providerLabel} connecting`, { model: this.model });

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.isConnecting = false;
      this.cleanup();
      throw err;
    }

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.isConnecting = false;
        this.cleanup();
        if (this.pendingReject) {
          this.pendingReject(new Error(`${this.providerLabel} connection timeout`));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = ws;

      this.ws.on("open", () => {
        debugLogger.debug(`${this.providerLabel} WebSocket opened`);
        try {
          const setupMessage = {
            setup: {
              model: this.model,
              generationConfig: {
                responseModalities: ["TEXT"],
              },
              inputAudioTranscription: {
                languageCodes: resolveLanguageCodes(language),
                mode: "SMART",
                customVocabulary: (keyterms || []).slice(0, 1000),
              },
            },
          };
          this.ws.send(JSON.stringify(setupMessage));
        } catch (err) {
          debugLogger.error(`${this.providerLabel} failed to send setup message`, {
            error: err.message,
          });
          this.cleanup();
          if (this.pendingReject) {
            this.pendingReject(err);
            this.pendingReject = null;
            this.pendingResolve = null;
          }
        }
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (error) => {
        const wasActive = this.isConnected;
        debugLogger.error(`${this.providerLabel} WebSocket error`, {
          error: error.message,
          wasActive,
          isDisconnecting: this.isDisconnecting,
        });
        this.isConnecting = false;
        if (this.pendingReject) {
          this.pendingReject(error);
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        if (this._disconnectResolve) {
          this._disconnectResolve();
        }
        this.cleanup();
        if (!this.isDisconnecting) {
          this.onError?.(error);
        }
      });

      this.ws.on("close", (code, reason) => {
        const wasActive = this.isConnected;
        this.isConnecting = false;
        debugLogger.debug(`${this.providerLabel} WebSocket closed`, {
          code,
          reason: reason?.toString(),
          wasActive,
          isDisconnecting: this.isDisconnecting,
        });
        if (this.pendingReject) {
          this.pendingReject(new Error(`WebSocket closed before ready (code: ${code})`));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        if (this._disconnectResolve) {
          this._disconnectResolve();
        }
        this.cleanup();
        if (wasActive && !this.isDisconnecting) {
          this.onSessionEnd?.({ text: this.getFullTranscript() });
        }
      });
    });
  }

  _markConnected() {
    this.isConnected = true;
    this.isConnecting = false;
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }

    if (this.coldStartBuffer.length > 0) {
      debugLogger.debug(
        `${this.providerLabel} flushing cold-start buffer`,
        { chunks: this.coldStartBuffer.length }
      );
      for (const chunk of this.coldStartBuffer) {
        this._sendChunk(chunk);
      }
      this.coldStartBuffer = [];
    }

    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
      this.pendingReject = null;
    }
  }

  _sendChunk(pcmBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const buf = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    const payload = JSON.stringify({
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: `audio/pcm;rate=${this.inputRate}`,
            data: buf.toString("base64"),
          },
        ],
      },
    });
    this.ws.send(payload);
    this.audioBytesSent += buf.length;
  }

  sendAudio(pcmBuffer) {
    const isReady = this.isConnected && this.ws?.readyState === WebSocket.OPEN;

    if (!isReady) {
      if (this.bufferingAudio) {
        this.coldStartBuffer.push(Buffer.from(pcmBuffer));
      }
      return false;
    }

    if (this.coldStartBuffer.length > 0) {
      debugLogger.debug(
        `${this.providerLabel} flushing cold-start buffer`,
        { chunks: this.coldStartBuffer.length }
      );
      for (const buf of this.coldStartBuffer) {
        this._sendChunk(buf);
      }
      this.coldStartBuffer = [];
    }

    this._sendChunk(pcmBuffer);
    return true;
  }

  handleMessage(data) {
    try {
      const event = JSON.parse(data.toString());

      if (event.setupComplete) {
        debugLogger.debug(`${this.providerLabel} setup complete`);
        this._markConnected();
        return;
      }

      if (event.serverContent) {
        const { serverContent } = event;

        if (serverContent.interimInputTranscription) {
          const text = serverContent.interimInputTranscription.text;
          if (typeof text === "string") {
            // The first partial after a final is the closest thing this
            // protocol offers to "when this stretch of speech began".
            if (this._segmentStartedAt === null) this._segmentStartedAt = Date.now();
            this.currentPartial = text;
            this.onPartialTranscript?.(text);
          }
        }

        if (serverContent.inputTranscription) {
          const text = serverContent.inputTranscription.text;
          const transcript = typeof text === "string" ? text.trim() : "";
          if (transcript) {
            this.completedSegments.push(transcript);
            this.currentPartial = "";
            const fullTranscript = this.getFullTranscript();
            this.onFinalTranscript?.(fullTranscript, this._segmentStartedAt ?? Date.now());
            this._segmentStartedAt = null;
            debugLogger.debug(`${this.providerLabel} segment completed`, {
              segment: transcript,
              totalSegments: this.completedSegments.length,
              fullTranscriptLength: fullTranscript.length,
            });
          }
        }

        if (serverContent.generationComplete) {
          debugLogger.debug(`${this.providerLabel} generationComplete received`, {
            audioStreamEnded: this._audioStreamEnded,
          });
          if (this._audioStreamEnded && this._disconnectResolve) {
            this._disconnectResolve();
          }
        }
      }

      if (event.error) {
        const errMsg = event.error.message || `${this.providerLabel} error`;
        debugLogger.error(`${this.providerLabel} server error event`, { error: event.error });
        // A protocol error arriving before setupComplete means the session
        // never came up -- reject connect() now instead of leaving the
        // caller waiting out the full WEBSOCKET_TIMEOUT_MS for a generic
        // timeout that would hide the real error.
        if (this.pendingReject) {
          this.pendingReject(new Error(errMsg));
          this.pendingReject = null;
          this.pendingResolve = null;
        } else if (!this.isDisconnecting) {
          this.onError?.(new Error(errMsg));
        }
      }
    } catch (err) {
      debugLogger.error(`${this.providerLabel} message parse error`, {
        error: err.message,
      });
    }
  }

  async disconnect({ commit = true } = {}) {
    debugLogger.debug(`${this.providerLabel} disconnect`, {
      audioBytesSent: this.audioBytesSent,
      segments: this.completedSegments.length,
      readyState: this.ws?.readyState,
      commit,
    });

    if (!this.ws) {
      return { text: this.getFullTranscript() };
    }

    this.isDisconnecting = true;

    if (this.ws.readyState === WebSocket.CONNECTING) {
      // Do not call cleanup() here: this.ws must stay set until the socket
      // actually finishes connecting, or the deferred close below closes
      // nothing (this.ws would already be null) and the setup-message "open"
      // handler registered in connect() throws trying to send on a null
      // socket. isDisconnecting also stays true so the already-registered
      // "close" handler -- which does the real cleanup() once this socket
      // genuinely closes -- knows not to fire onSessionEnd for a disconnect
      // we asked for ourselves.
      this.ws.once("open", () => {
        try {
          this.ws?.close();
        } catch {}
      });
      return { text: this.getFullTranscript() };
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      if (commit && this.audioBytesSent > 0) {
        this._audioStreamEnded = true;

        await new Promise((resolve) => {
          this._disconnectTimeout = setTimeout(() => {
            debugLogger.debug(
              `${this.providerLabel} disconnect timeout (5000ms), resolving with accumulated text`
            );
            this._disconnectResolve = null;
            resolve();
          }, DISCONNECT_TIMEOUT_MS);

          this._disconnectResolve = () => {
            if (this._disconnectTimeout) {
              clearTimeout(this._disconnectTimeout);
              this._disconnectTimeout = null;
            }
            this._disconnectResolve = null;
            resolve();
          };

          try {
            this.ws.send(
              JSON.stringify({
                realtimeInput: { audioStreamEnd: true },
              })
            );
          } catch (err) {
            debugLogger.error(`${this.providerLabel} failed to send audioStreamEnd`, {
              error: err.message,
            });
            if (this._disconnectResolve) {
              this._disconnectResolve();
            }
          }
        });
      }

      try {
        this.ws.close();
      } catch {}
    }

    const result = { text: this.getFullTranscript() };
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  cleanup() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    if (this._disconnectTimeout) {
      clearTimeout(this._disconnectTimeout);
      this._disconnectTimeout = null;
    }
    this._disconnectResolve = null;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.bufferingAudio = false;
    this._audioStreamEnded = false;
  }
}

module.exports = GeminiLiveStreaming;
// Exported for tests: the language mapping is the part with a wrong answer.
module.exports.resolveLanguageCodes = resolveLanguageCodes;
module.exports.DEFAULT_INPUT_RATE = DEFAULT_INPUT_RATE;
module.exports.AUTO_LANGUAGE_CODES = AUTO_LANGUAGE_CODES;
