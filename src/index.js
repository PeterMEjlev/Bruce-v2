'use strict';

require('dotenv').config();
const path = require('path');
const { EventEmitter } = require('events');
const WakeWordDetector = require('./WakeWordDetector');
const AudioManager = require('./AudioManager');
const RealtimeClient = require('./RealtimeClient');
const FunctionRegistry = require('./FunctionRegistry');
const cfg = require('../config');

const CONVERSATION_IDLE_TIMEOUT_MS = cfg.CONVERSATION_IDLE_TIMEOUT_MS;

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
 * Uses OpenAI server-side VAD for real-time conversation with barge-in support.
 * The user can interrupt Bruce at any time by speaking.
 *
 * State machine: idle → conversing → idle
 *
 * Events: ready | wake | listening | thinking | speaking | idle | interrupted | functionCall | transcript | error
 */
class BruceAssistant extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.picovoiceKey - Picovoice access key
   * @param {string} config.openaiKey - OpenAI API key
   * @param {string} config.wakeWordPath - Path to .ppn wake word file
   * @param {string} [config.systemPrompt] - System instructions for Bruce
   * @param {string} [config.voice='alloy'] - TTS voice
   * @param {number} [config.sensitivity=0.5] - Wake word sensitivity (0.0-1.0)
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

    this._idleTimer = null;
    this._isSpeaking = false;

    this._bindEvents();
  }

  /**
   * Connect to OpenAI, start wake word detector and microphone.
   */
  async start() {
    // Built-in function: Bruce calls this when the user wants to end the conversation
    this._registry.register(
      'end_conversation',
      'End the current conversation and go back to sleep. Call this when the user says goodbye, stop, no more questions, or otherwise indicates they are done.',
      { type: 'object', properties: {}, required: [] },
      async () => {
        this._endConversation();
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
   */
  registerFunction(name, description, parameters, handler) {
    this._registry.register(name, description, parameters, handler);
  }

  get state() {
    return this._state;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _bindEvents() {
    // Mic audio routing based on current state
    this._audio.on('data', (chunk) => {
      if (this._state === 'idle') {
        // In idle mode, only feed audio to wake word detector
        this._wakeWord.processAudio(chunk);
      } else if (this._state === 'conversing') {
        // Mute mic → server while Bruce is speaking to prevent his own voice
        // from being picked up by the mic and causing false interruptions (echo).
        // Audio resumes as soon as Bruce finishes speaking.
        if (this._isSpeaking) return;
        this._realtime.sendAudioChunk(chunk);
      }
    });

    this._wakeWord.on('detected', () => {
      if (this._state === 'idle') {
        this._onWakeWordDetected();
      }
    });

    // ── Server VAD events ───────────────────────────────────────────────

    this._realtime.on('speechStarted', () => {
      console.log(`[DEBUG] speechStarted | state=${this._state} isSpeaking=${this._isSpeaking}`);
      if (this._state !== 'conversing') return;

      // Reset the idle timer — user is speaking
      this._resetIdleTimer();
    });

    this._realtime.on('speechStopped', () => {
      console.log(`[DEBUG] speechStopped | state=${this._state} isSpeaking=${this._isSpeaking} interrupted=${this._interrupted}`);
      if (this._state !== 'conversing') return;
      // Server will auto-commit and create a response — nothing to do here
    });

    // ── Response events ─────────────────────────────────────────────────

    this._realtime.on('audioChunk', (buffer) => {
      if (this._state !== 'conversing') {
        console.log(`[DEBUG] audioChunk DROPPED (state=${this._state})`);
        return;
      }
      if (!this._isSpeaking) {
        this._isSpeaking = true;
        console.log(`[DEBUG] audioChunk — first chunk, Bruce starts speaking (mic muted to server)`);
        this.emit('speaking');
      }
      this._audio.playChunk(buffer);
    });

    this._realtime.on('audioDone', () => {
      console.log(`[DEBUG] audioDone | isSpeaking=${this._isSpeaking}`);
      this._audio.endPlayback();
    });

    // Speaker finished playing all audio
    this._audio.on('speakingEnd', () => {
      console.log(`[DEBUG] speakingEnd — speaker finished playback`);
      this._isSpeaking = false;
      // Reset idle timer after Bruce finishes speaking — wait for follow-up
      this._resetIdleTimer();
    });

    this._audio.on('playbackStopped', () => {
      console.log(`[DEBUG] playbackStopped — speaker destroyed (barge-in or end_conversation)`);
      this._isSpeaking = false;
    });

    this._realtime.on('responseDone', () => {
      console.log(`[DEBUG] responseDone | state=${this._state}`);
      // Reset idle timer after each complete response
      if (this._state === 'conversing') {
        this._resetIdleTimer();
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

    // Play notification so the user knows Bruce is listening
    await this._audio.playNotification();

    this._setState('conversing');
    this.emit('listening');

    // Start the idle timer — if no activity, go back to sleep
    this._resetIdleTimer();
  }

  _endConversation() {
    console.log(`[DEBUG] _endConversation called | isSpeaking=${this._isSpeaking}`);
    this._cancelTimers();
    this._audio.stopPlayback();
    this._realtime.clearAudioBuffer();
    this._isSpeaking = false;
    this._setState('idle');
    this.emit('idle');
  }

  _resetIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
    }
    console.log(`[DEBUG] idleTimer reset (${CONVERSATION_IDLE_TIMEOUT_MS}ms)`);
    this._idleTimer = setTimeout(() => {
      if (this._state === 'conversing') {
        console.log(`[DEBUG] idleTimer EXPIRED — ending conversation`);
        this._endConversation();
      }
    }, CONVERSATION_IDLE_TIMEOUT_MS);
  }

  _cancelTimers() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _setState(state) {
    if (this._state !== state) {
      console.log(`[DEBUG] STATE: ${this._state} → ${state}`);
    }
    this._state = state;
  }
}

module.exports = BruceAssistant;
module.exports.BruceAssistant = BruceAssistant;
