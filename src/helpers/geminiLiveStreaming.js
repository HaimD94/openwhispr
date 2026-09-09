const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const WEBSOCKET_TIMEOUT_MS = 15000;
const DISCONNECT_TIMEOUT_MS = 5000;
const DEFAULT_MODEL = "models/gemini-3.5-transcribe-live";
const GEMINI_LIVE_BASE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

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
  }

  beginConnecting() {
    this.bufferingAudio = true;
    this.coldStartBuffer = [];
  }

  getFullTranscript() {
    return this.completedSegments.join(" ");
  }

  async connect(options = {}) {
    const { apiKey, model, language, keyterms } = options;
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
                languageCodes: ["he-IL", "en-US"],
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
            mimeType: "audio/pcm;rate=16000",
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
            this.onFinalTranscript?.(fullTranscript);
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
        if (!this.isDisconnecting) {
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
      this.ws.once("open", () => {
        try {
          this.ws?.close();
        } catch {}
      });
      const result = { text: this.getFullTranscript() };
      this.cleanup();
      this.isDisconnecting = false;
      return result;
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
