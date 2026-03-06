'use strict';

require('dotenv').config();
const { EventEmitter } = require('events');
const WakeWordDetector = require('./WakeWordDetector');
const AudioManager = require('./AudioManager');
const RealtimeClient = require('./RealtimeClient');
const FunctionRegistry = require('./FunctionRegistry');

// Maximum utterance length before auto-committing (ms)
const MAX_UTTERANCE_MS = 10000;

// How long silence must persist before committing audio (ms)
const SILENCE_THRESHOLD_MS = 1500;

// RMS energy below this level is considered silence (Int16 scale: 0–32768)
// Tune upward in noisy environments
const SILENCE_ENERGY_THRESHOLD = 200;

/**
 * BruceAssistant
 *
 * Standalone voice assistant class. Orchestrates:
 *  - Offline wake word detection (Porcupine)
 *  - Audio capture (microphone via SoX)
 *  - OpenAI Realtime API (STT + LLM + TTS over WebSocket)
 *  - Audio playback (speaker)
 *  - Function/tool calling
 *
 * State machine: idle → listening → thinking → speaking → idle
 *
 * Events: ready | wake | listening | thinking | speaking | idle | functionCall | error
 */
class BruceAssistant extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.picovoiceKey - Picovoice access key
   * @param {string} config.openaiKey - OpenAI API key
   * @param {string} config.wakeWordPath - Path to .ppn wake word file
   * @param {string} [config.systemPrompt] - System instructions for Bruce
   * @param {string} [config.voice='alloy'] - TTS voice
   * @param {number} [config.sensitivity=0.5] - Wake word sensitivity (0.0–1.0)
   * @param {string} [config.micDevice] - Optional mic device (e.g. 'plughw:1' on Linux)
   */
  constructor(config) {
    super();
    this._config = config;
    this._state = 'idle';

    this._registry = new FunctionRegistry();

    this._wakeWord = new WakeWordDetector({
      accessKey: config.picovoiceKey,
      wakeWordPath: config.wakeWordPath,
      sensitivity: config.sensitivity ?? 0.5,
    });

    this._audio = new AudioManager();

    this._realtime = new RealtimeClient({
      apiKey: config.openaiKey,
      voice: config.voice || 'alloy',
      systemPrompt:
        config.systemPrompt ||
        'You are Bruce, a helpful AI assistant for a home brewing setup. Keep responses concise and conversational — you are speaking, not writing.',
      registry: this._registry,
    });

    this._silenceTimer = null;
    this._utteranceTimer = null;

    this._bindEvents();
  }

  /**
   * Connect to OpenAI, start wake word detector and microphone.
   */
  async start() {
    await this._realtime.connect();
    this._wakeWord.start();
    this._audio.startMic({ device: this._config.micDevice });
    this._setState('idle');
    this.emit('ready');
  }

  /**
   * Gracefully shut down all components.
   */
  async stop() {
    this._cancelTimers();
    this._audio.stopMic();
    this._audio.stopPlayback();
    this._wakeWord.stop();
    this._realtime.disconnect();
    this._setState('idle');
  }

  /**
   * Register a tool Bruce can call during conversation.
   * Can be called before or after start().
   * @param {string} name - snake_case function name
   * @param {string} description - Description for the LLM
   * @param {object} parameters - JSON Schema object
   * @param {Function} handler - async (args) => string
   */
  registerFunction(name, description, parameters, handler) {
    this._registry.register(name, description, parameters, handler);
  }

  get state() {
    return this._state;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _bindEvents() {
    // Mic audio is routed based on current state
    this._audio.on('data', (chunk) => {
      if (this._state === 'idle') {
        this._wakeWord.processAudio(chunk);
      } else if (this._state === 'listening') {
        this._realtime.sendAudioChunk(chunk);
        this._checkSilence(chunk);
      }
    });

    this._wakeWord.on('detected', () => {
      if (this._state !== 'idle') return;
      this._onWakeWordDetected();
    });

    // TTS audio chunks stream in as Base64-decoded PCM16 buffers
    this._realtime.on('audioChunk', (buffer) => {
      if (this._state !== 'speaking') this._setState('speaking');
      this._audio.playChunk(buffer);
    });

    this._realtime.on('audioDone', () => {
      this._audio.endPlayback();
    });

    // Speaker finished — back to idle
    this._audio.on('speakingEnd', () => {
      this._setState('idle');
      this.emit('idle');
    });

    this._realtime.on('thinking', () => {
      this._setState('thinking');
    });

    this._realtime.on('functionCall', (name, args) => {
      this.emit('functionCall', name, args);
    });

    this._audio.on('error', (err) => this.emit('error', err));
    this._realtime.on('error', (err) => this.emit('error', err));
    this._wakeWord.on('error', (err) => this.emit('error', err));
  }

  _onWakeWordDetected() {
    this.emit('wake');
    this._setState('listening');
    this.emit('listening');

    this._realtime.startStreaming();

    // Safety valve: auto-commit after MAX_UTTERANCE_MS even without silence
    this._utteranceTimer = setTimeout(() => this._commitAudio(), MAX_UTTERANCE_MS);
  }

  _checkSilence(chunk) {
    const rms = this._computeRMS(chunk);
    if (rms < SILENCE_ENERGY_THRESHOLD) {
      if (!this._silenceTimer) {
        this._silenceTimer = setTimeout(() => this._commitAudio(), SILENCE_THRESHOLD_MS);
      }
    } else {
      // Voice energy detected — reset silence timer
      if (this._silenceTimer) {
        clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
      }
    }
  }

  _commitAudio() {
    this._cancelTimers();
    if (this._state !== 'listening') return;
    this._realtime.commitAndRespond();
  }

  _computeRMS(buffer) {
    // PCM16 LE: 2 bytes per sample, signed
    let sum = 0;
    const samples = Math.floor(buffer.length / 2);
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += sample * sample;
    }
    return samples > 0 ? Math.sqrt(sum / samples) : 0;
  }

  _cancelTimers() {
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
    if (this._utteranceTimer) { clearTimeout(this._utteranceTimer); this._utteranceTimer = null; }
  }

  _setState(state) {
    this._state = state;
    if (state === 'thinking') this.emit('thinking');
    if (state === 'speaking') this.emit('speaking');
  }
}

module.exports = BruceAssistant;
module.exports.BruceAssistant = BruceAssistant;
