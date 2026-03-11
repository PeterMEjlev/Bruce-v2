'use strict';

require('dotenv').config();
const path = require('path');
const { EventEmitter } = require('events');
const WakeWordDetector = require('./WakeWordDetector');
const AudioManager = require('./AudioManager');
const RealtimeClient = require('./RealtimeClient');
const FunctionRegistry = require('./FunctionRegistry');
const cfg = require('../config');


const MAX_UTTERANCE_MS         = cfg.MAX_UTTERANCE_MS;
const SILENCE_THRESHOLD_MS     = cfg.SILENCE_THRESHOLD_MS;
const SILENCE_ENERGY_THRESHOLD = cfg.SILENCE_ENERGY_THRESHOLD;
const FOLLOW_UP_TIMEOUT_MS     = cfg.FOLLOW_UP_TIMEOUT_MS;
const MIN_SPEECH_ENERGY        = cfg.MIN_SPEECH_ENERGY;
const DEBUG_ENERGY             = cfg.DEBUG_ENERGY || 'off';

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
    this._followUpTimer = null;
    this._hasHeardVoice = false;
    this._skipFollowUp = false;
    this._peakEnergy = 0;
    this._audioPlayedThisTurn = false;

    this._bindEvents();
  }

  /**
   * Connect to OpenAI, start wake word detector and microphone.
   */
  async start() {
    // Built-in function: Bruce calls this when the user wants to end the conversation
    this._registry.register(
      'end_conversation',
      'End the current conversation and go back to sleep. You MUST call this whenever the user says goodbye, stop, that\'s it, thank you, no more questions, never mind, or any phrase indicating they are finished.',
      { type: 'object', properties: {}, required: [] },
      async () => {
        this._cancelTimers();
        this._audio.stopPlayback();
        this._realtime.clearAudioBuffer();
        this._setState('idle');
        this.emit('idle');
        return 'Conversation ended.';
      }
    );

    this._audio.loadNotificationSound(path.join(__dirname, '..', 'plop.wav'));
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

  /**
   * Make Bruce speak unprompted by injecting a text message into the conversation.
   * Bruce will respond with TTS audio as if the user had spoken to him.
   * @param {string} text - The text prompt for Bruce to respond to
   */
  speak(text) {
    if (!this._realtime.isReady) return;
    // If Bruce is busy (listening/thinking/speaking), wait for idle
    if (this._state !== 'idle') {
      const onIdle = () => {
        this.removeListener('idle', onIdle);
        this._doSpeak(text);
      };
      this.on('idle', onIdle);
      return;
    }
    this._doSpeak(text);
  }

  /** @private */
  async _doSpeak(text) {
    this._skipFollowUp = true;
    this._realtime.sendText(text);
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
      if (this._state === 'idle') {
        this._onWakeWordDetected();
      }
    });

    // TTS audio chunks stream in as Base64-decoded PCM16 buffers
    this._realtime.on('audioChunk', (buffer) => {
      if (this._state === 'idle') return;  // conversation already ended
      if (this._state !== 'speaking') this._setState('speaking');
      this._audioPlayedThisTurn = true;
      this._audio.playChunk(buffer);
    });

    this._realtime.on('audioDone', () => {
      if (this._state === 'idle') return;  // don't open a phantom speaker after conversation ended
      this._audio.endPlayback();
    });

    // Speaker finished — listen for follow-up instead of going idle
    this._audio.on('speakingEnd', () => {
      if (this._state === 'idle') return;  // conversation already ended
      if (this._skipFollowUp) {
        this._skipFollowUp = false;
        this._setState('idle');
        this.emit('idle');
        return;
      }
      // If more response phases are coming (functions to execute, results to share),
      // go back to thinking and wait instead of starting follow-up
      if (this._realtime.responsePhase) {
        this._setState('thinking');
        return;
      }
      this._startFollowUp();
    });

    this._realtime.on('thinking', () => {
      this._setState('thinking');
    });

    // When all response phases are complete:
    // - If audio was played this turn, start follow-up listening
    // - Otherwise (safety net), go idle
    this._realtime.on('responseDone', () => {
      if (this._state === 'thinking') {
        this._cancelTimers();
        if (this._audioPlayedThisTurn) {
          this._startFollowUp();
        } else {
          this._setState('idle');
          this.emit('idle');
        }
      }
    });

    this._realtime.on('transcript', (text) => {
      this.emit('transcript', text);
    });

    this._realtime.on('functionCall', (name, args) => {
      this.emit('functionCall', name, args);
    });

    this._audio.on('error', (err) => this.emit('error', err));
    this._realtime.on('error', (err) => this.emit('error', err));
    this._wakeWord.on('error', (err) => this.emit('error', err));
  }

  async _onWakeWordDetected() {
    this.emit('wake');

    // Play a short beep so the user knows Bruce is listening,
    // then start streaming — this way the mic won't send the beep to OpenAI.
    await this._audio.playNotification();

    this._setState('listening');
    this.emit('listening');

    this._hasHeardVoice = false;
    this._peakEnergy = 0;
    this._listeningStartedAt = Date.now();
    this._audioPlayedThisTurn = false;
    this._realtime.startStreaming();

    // Safety valve: auto-commit after MAX_UTTERANCE_MS even without silence
    this._utteranceTimer = setTimeout(() => this._commitAudio(), MAX_UTTERANCE_MS);
  }

  _checkSilence(chunk) {
    const rms = this._computeRMS(chunk);
    if (DEBUG_ENERGY === 'listening' || DEBUG_ENERGY === 'all') {
      process.stdout.write(`\r[Energy] listening: ${Math.round(rms).toString().padStart(5)} (threshold: ${SILENCE_ENERGY_THRESHOLD})`);
    }
    if (rms < SILENCE_ENERGY_THRESHOLD) {
      if (!this._silenceTimer) {
        this._silenceTimer = setTimeout(() => this._commitAudio(), SILENCE_THRESHOLD_MS);
      }
    } else {
      // Voice energy detected — reset silence timer
      this._hasHeardVoice = true;
      // Ignore energy for 300ms after listening starts to avoid plop bleed-through
      if (rms > this._peakEnergy && Date.now() - this._listeningStartedAt > 300) {
        this._peakEnergy = rms;
      }
      if (this._followUpTimer) {
        clearTimeout(this._followUpTimer);
        this._followUpTimer = null;
      }
      if (!this._utteranceTimer) {
        this._utteranceTimer = setTimeout(() => this._commitAudio(), MAX_UTTERANCE_MS);
      }
      if (this._silenceTimer) {
        clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
      }
    }
  }

  _commitAudio() {
    this._cancelTimers();
    if (this._state !== 'listening') return;
    console.log(`[Bruce] Peak energy: ${Math.round(this._peakEnergy)} (min: ${MIN_SPEECH_ENERGY})`);
    if (!this._hasHeardVoice || this._peakEnergy < MIN_SPEECH_ENERGY) {
      // No meaningful speech detected — go idle
      this._realtime.clearAudioBuffer();
      this._setState('idle');
      this.emit('idle');
      return;
    }
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

  async _startFollowUp() {
    await this._audio.playNotification();

    this._setState('listening');
    this.emit('listening');
    this._realtime.startStreaming();
    this._hasHeardVoice = false;
    this._peakEnergy = 0;
    this._listeningStartedAt = Date.now();

    this._followUpTimer = setTimeout(() => {
      if (this._state === 'listening' && !this._hasHeardVoice) {
        this._realtime.clearAudioBuffer();
        this._setState('idle');
        this.emit('idle');
      }
    }, FOLLOW_UP_TIMEOUT_MS);
  }

  _cancelTimers() {
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
    if (this._utteranceTimer) { clearTimeout(this._utteranceTimer); this._utteranceTimer = null; }
    if (this._followUpTimer) { clearTimeout(this._followUpTimer); this._followUpTimer = null; }
  }

  _setState(state) {
    this._state = state;
    if (state === 'thinking') this.emit('thinking');
    if (state === 'speaking') this.emit('speaking');
  }
}

module.exports = BruceAssistant;
module.exports.BruceAssistant = BruceAssistant;
