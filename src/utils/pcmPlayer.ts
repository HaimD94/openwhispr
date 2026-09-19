// Plays a stream of 16-bit mono PCM chunks back to back, and can drop whatever
// is still queued the moment the user talks over it.
export class PcmPlayer {
  private context: AudioContext;
  private nextStart = 0;
  private sources = new Set<AudioBufferSourceNode>();

  constructor(
    private readonly sampleRate: number,
    private readonly onDrained: () => void
  ) {
    this.context = new AudioContext({ sampleRate });
  }

  enqueue(pcm: Int16Array) {
    if (!pcm.length) return;
    // resume() can be refused until a user gesture; the session starts from a
    // click, so this normally succeeds. Not awaited: it can hang on a wedged device.
    if (this.context.state === "suspended") this.context.resume().catch(() => {});

    const buffer = this.context.createBuffer(1, pcm.length, this.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.onDrained();
    };

    // A small lead keeps the first chunk from being scheduled in the past.
    this.nextStart = Math.max(this.nextStart, this.context.currentTime + 0.02);
    source.start(this.nextStart);
    this.nextStart += buffer.duration;
    this.sources.add(source);
  }

  get isPlaying() {
    return this.sources.size > 0;
  }

  // Stops everything queued. onended still fires for each source, so detach it
  // first: an interruption is not the same as the reply finishing.
  flush() {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Not started yet.
      }
    }
    this.sources.clear();
    this.nextStart = 0;
  }

  close() {
    this.flush();
    this.context.close().catch(() => {});
  }
}
