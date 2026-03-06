'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const recorder = require('node-record-lpcm16');
const Speaker = require('speaker');

const MIC_SAMPLE_RATE = 16000;    // Porcupine wake word requires 16kHz
const PLAYBACK_SAMPLE_RATE = 24000; // OpenAI Realtime API outputs 24kHz
const CHANNELS = 1;
const BIT_DEPTH = 16;

class AudioManager extends EventEmitter {
  constructor() {
    super();
    this._recording = null;
    this._speaker = null;
    this._isSpeaking = false;
    this._speakerQueue = [];
    this._speakerDraining = false;
  }

  /**
   * Start microphone capture. Emits 'data' with raw PCM16 Buffer chunks.
   * @param {object} [opts]
   * @param {string} [opts.device] - Audio device (e.g. 'plughw:1' on Linux)
   * @param {string} [opts.recorder] - Recorder backend ('sox' or 'arecord')
   */
  startMic(opts = {}) {
    if (this._recording) return;

    if (process.platform === 'win32') {
      // node-record-lpcm16 uses --default-device which fails on Windows.
      // Spawn sox directly with the waveaudio driver instead.
      const child = spawn('sox', [
        '-t', 'waveaudio', opts.device || 'default',
        '--rate', String(MIC_SAMPLE_RATE),
        '--channels', String(CHANNELS),
        '--encoding', 'signed-integer',
        '--bits', String(BIT_DEPTH),
        '--type', 'raw',
        '-',
      ]);

      child.stdout.on('data', (chunk) => this.emit('data', chunk));
      child.stderr.on('data', () => {}); // suppress sox progress output
      child.on('error', (err) => this.emit('error', err));
      child.on('exit', (code) => {
        if (code !== null && code !== 0) {
          this.emit('error', new Error(`sox exited with code ${code}`));
        }
      });

      this._recording = { stop: () => child.kill() };
      return;
    }

    this._recording = recorder.record({
      sampleRate: MIC_SAMPLE_RATE,
      channels: CHANNELS,
      audioType: 'raw',         // Raw PCM — no WAV header, required for Porcupine
      encoding: 'signed-integer',
      endian: 'little',
      bitwidth: BIT_DEPTH,
      device: opts.device || null,
      recorder: opts.recorder || 'sox',
    });

    this._recording
      .stream()
      .on('data', (chunk) => this.emit('data', chunk))
      .on('error', (err) => this.emit('error', err));
  }

  stopMic() {
    if (this._recording) {
      this._recording.stop();
      this._recording = null;
    }
  }

  /**
   * Queue a PCM16 audio chunk for playback.
   * @param {Buffer} chunk - Raw PCM16 LE audio at 16kHz mono
   */
  playChunk(chunk) {
    this._speakerQueue.push(chunk);
    if (!this._speakerDraining) {
      this._drainQueue();
    }
  }

  /**
   * Signal end of TTS stream. Speaker will close after all queued audio plays.
   */
  endPlayback() {
    this._speakerQueue.push(null); // sentinel
    if (!this._speakerDraining) {
      this._drainQueue();
    }
  }

  /**
   * Immediately stop playback (e.g. for barge-in interruption).
   */
  stopPlayback() {
    this._speakerQueue = [];
    this._speakerDraining = false;
    if (this._speaker) {
      this._speaker.destroy();
      this._speaker = null;
    }
    this._isSpeaking = false;
    this.emit('playbackStopped');
  }

  get isSpeaking() {
    return this._isSpeaking;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _ensureSpeaker() {
    if (this._speaker) return;

    this._speaker = new Speaker({
      channels: CHANNELS,
      bitDepth: BIT_DEPTH,
      sampleRate: PLAYBACK_SAMPLE_RATE,
      signed: true,
    });

    // Write a short silent preroll so the speaker warmup doesn't clip the first word
    const prerollMs = 250;
    const bytesPerSample = BIT_DEPTH / 8;
    const prerollBytes = Math.floor(PLAYBACK_SAMPLE_RATE * (prerollMs / 1000)) * bytesPerSample * CHANNELS;
    this._speaker.write(Buffer.alloc(prerollBytes));

    this._speaker.on('open', () => {
      this._isSpeaking = true;
      this.emit('speakingStart');
    });

    this._speaker.on('flush', () => {
      this._isSpeaking = false;
      this._speaker = null;
      this._speakerDraining = false;
      this.emit('speakingEnd');
    });

    this._speaker.on('error', (err) => {
      this._speaker = null;
      this._speakerDraining = false;
      this.emit('error', err);
    });
  }

  _drainQueue() {
    if (this._speakerQueue.length === 0) return;

    this._speakerDraining = true;
    this._ensureSpeaker();

    const writeNext = () => {
      if (this._speakerQueue.length === 0) {
        this._speakerDraining = false;
        return;
      }

      const chunk = this._speakerQueue.shift();

      if (chunk === null) {
        // End of TTS response — flush and close speaker
        this._speaker.end();
        return;
      }

      // Respect back-pressure: if write() returns false, wait for 'drain'
      const canContinue = this._speaker.write(chunk);
      if (canContinue) {
        setImmediate(writeNext);
      } else {
        this._speaker.once('drain', writeNext);
      }
    };

    writeNext();
  }
}

module.exports = AudioManager;
