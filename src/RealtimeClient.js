'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const cfg = require('../config');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview';
const AUDIO_FORMAT = 'pcm16';

class RealtimeClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey - OpenAI API key
   * @param {string} [opts.voice='alloy'] - TTS voice
   * @param {string} [opts.systemPrompt=''] - System instructions for the assistant
   * @param {import('./FunctionRegistry')} opts.registry - Function registry instance
   */
  constructor({ apiKey, voice = 'alloy', systemPrompt = '', registry }) {
    super();
    this._apiKey = apiKey;
    this._voice = voice;
    this._systemPrompt = systemPrompt;
    this._registry = registry;
    this._ws = null;
    this._sessionReady = false;
    // Accumulate function call arguments keyed by call_id
    this._pendingFunctionCalls = new Map();
  }

  /**
   * Open WebSocket and configure the session.
   * Resolves when the session is ready to receive audio.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${this._apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this._ws.on('message', (data) => {
        let event;
        try {
          event = JSON.parse(data.toString());
        } catch {
          return;
        }
        this._handleServerEvent(event, resolve, reject);
      });

      this._ws.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this._ws.on('close', (code, reason) => {
        this._sessionReady = false;
        this.emit('disconnected', { code, reason: reason.toString() });
      });
    });
  }

  disconnect() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  /**
   * Stream a PCM16 audio chunk to the Realtime API input buffer.
   * @param {Buffer} chunk - Raw PCM16 LE bytes
   */
  sendAudioChunk(chunk) {
    if (!this._sessionReady) return;
    this._send({
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    });
  }

  /**
   * Cancel an in-progress response (for barge-in interruption).
   */
  cancelResponse() {
    this._send({ type: 'response.cancel' });
  }

  /**
   * Clear the input audio buffer without committing.
   */
  clearAudioBuffer() {
    this._send({ type: 'input_audio_buffer.clear' });
  }

  get isReady() {
    return this._sessionReady;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _send(event) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(event));
    }
  }

  _configureSession() {
    const tools = this._registry.getToolDefinitions();
    this._send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this._systemPrompt,
        voice: this._voice,
        input_audio_format: AUDIO_FORMAT,
        output_audio_format: AUDIO_FORMAT,
        input_audio_transcription: { model: 'whisper-1' },
        // Server-side VAD: OpenAI detects speech start/stop and auto-commits
        turn_detection: {
          type: 'server_vad',
          threshold: cfg.VAD_THRESHOLD,
          prefix_padding_ms: cfg.VAD_PREFIX_PADDING_MS,
          silence_duration_ms: cfg.VAD_SILENCE_DURATION_MS,
        },
        tools: tools,
        tool_choice: tools.length > 0 ? 'auto' : 'none',
        temperature: 0.8,
      },
    });
  }

  async _handleServerEvent(event, resolveConnect, rejectConnect) {
    switch (event.type) {
      case 'session.created':
        this._configureSession();
        break;

      case 'session.updated':
        this._sessionReady = true;
        this.emit('ready');
        if (resolveConnect) resolveConnect();
        break;

      // ── Server VAD events ───────────────────────────────────────────────

      case 'input_audio_buffer.speech_started':
        // User started talking — emit so BruceAssistant can handle barge-in
        this.emit('speechStarted');
        break;

      case 'input_audio_buffer.speech_stopped':
        // User stopped talking — server will auto-commit and create response
        this.emit('speechStopped');
        break;

      // ── Response audio ──────────────────────────────────────────────────

      case 'response.audio.delta': {
        const audioBuffer = Buffer.from(event.delta, 'base64');
        this.emit('audioChunk', audioBuffer);
        break;
      }

      case 'response.audio.done':
        this.emit('audioDone');
        break;

      // ── Function calls ──────────────────────────────────────────────────

      case 'response.output_item.added': {
        const item = event.item;
        if (item && item.type === 'function_call') {
          if (!this._pendingFunctionCalls.has(item.call_id)) {
            this._pendingFunctionCalls.set(item.call_id, { name: item.name, argumentsStr: '' });
          } else {
            this._pendingFunctionCalls.get(item.call_id).name = item.name;
          }
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const { call_id, delta } = event;
        if (!this._pendingFunctionCalls.has(call_id)) {
          this._pendingFunctionCalls.set(call_id, { name: null, argumentsStr: '' });
        }
        this._pendingFunctionCalls.get(call_id).argumentsStr += delta;
        break;
      }

      case 'response.function_call_arguments.done': {
        const { call_id } = event;
        const pending = this._pendingFunctionCalls.get(call_id);
        if (!pending) break;

        const fnName = pending.name;
        let args = {};
        try {
          args = JSON.parse(pending.argumentsStr || '{}');
        } catch {
          args = {};
        }

        this._pendingFunctionCalls.delete(call_id);
        this.emit('functionCall', fnName, args);

        let result;
        try {
          result = await this._registry.execute(fnName, args);
        } catch (err) {
          result = `Error executing ${fnName}: ${err.message}`;
        }

        // Submit the function output back to the conversation
        this._send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id,
            output: result,
          },
        });

        // The API does NOT auto-continue after a function call — we must request a new response
        this._send({ type: 'response.create' });
        break;
      }

      // ── Transcription & completion ──────────────────────────────────────

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = event.transcript?.trim();
        if (transcript) this.emit('transcript', transcript);
        break;
      }

      case 'response.done':
        this.emit('responseDone');
        break;

      case 'error': {
        const msg = event.error?.message || JSON.stringify(event.error);
        // With server VAD, cancellation race conditions are expected — don't treat as errors
        if (msg && msg.includes('Cancellation failed')) break;
        const err = new Error(`Realtime API error: ${msg}`);
        this.emit('error', err);
        if (rejectConnect) rejectConnect(err);
        break;
      }

      default:
        break;
    }
  }
}

module.exports = RealtimeClient;
