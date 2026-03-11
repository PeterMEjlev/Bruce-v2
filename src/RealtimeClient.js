'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

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
    this._streaming = false;
    // Accumulate function call arguments keyed by call_id
    this._pendingFunctionCalls = new Map();
    // Completed function calls waiting to be executed when response.done fires
    this._completedCalls = [];
    // Response phase: null | 'announce' | 'execute' | 'results'
    this._responsePhase = null;
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
        this._streaming = false;
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
    if (!this._sessionReady || !this._streaming) return;
    this._send({
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    });
  }

  /**
   * Begin accepting audio chunks for a new utterance.
   */
  startStreaming() {
    this._streaming = true;
  }

  /**
   * Finalize the audio input and trigger a model response.
   */
  commitAndRespond() {
    if (!this._sessionReady) return;
    this._streaming = false;
    this._send({ type: 'input_audio_buffer.commit' });
    // Phase 1: force speech-only so Bruce announces before calling functions
    this._responsePhase = 'announce';
    this._send({
      type: 'response.create',
      response: {
        tool_choice: 'none',
        instructions: 'Briefly announce what you are ABOUT to do (e.g. "Sure, let me turn those on for you"). Do NOT confirm completion or say you have done it — you have not performed the actions yet. Keep it to one short sentence.',
      },
    });
    this.emit('thinking');
  }

  /**
   * Inject a text message into the conversation and trigger a model response.
   * Used for unprompted speech (e.g. reminders) without requiring audio input.
   * @param {string} text - The text to send as a user message
   */
  sendText(text) {
    if (!this._sessionReady) return;
    this._send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this._responsePhase = null;
    this._send({ type: 'response.create' });
    this.emit('thinking');
  }

  /**
   * Cancel an in-progress response (for barge-in).
   */
  cancelResponse() {
    this._send({ type: 'response.cancel' });
  }

  /**
   * Clear the input audio buffer without committing (e.g. when no speech was detected).
   */
  clearAudioBuffer() {
    this._streaming = false;
    this._send({ type: 'input_audio_buffer.clear' });
  }

  get isReady() {
    return this._sessionReady;
  }

  get responsePhase() {
    return this._responsePhase;
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
        // Disable server-side VAD — we commit audio manually after wake word + silence detection
        turn_detection: null,
        tools: tools,
        tool_choice: tools.length > 0 ? 'auto' : 'none',
        temperature: 0.6,
      },
    });
  }

  async _handleServerEvent(event, resolveConnect, rejectConnect) {
    switch (event.type) {
      case 'session.created':
        // Server is ready — send our configuration
        this._configureSession();
        break;

      case 'session.updated':
        // Our config was accepted — session is fully ready
        this._sessionReady = true;
        this.emit('ready');
        if (resolveConnect) resolveConnect();
        break;

      case 'response.audio.delta': {
        // Incremental TTS audio chunk (Base64 PCM16)
        const audioBuffer = Buffer.from(event.delta, 'base64');
        this.emit('audioChunk', audioBuffer);
        break;
      }

      case 'response.audio.done':
        this.emit('audioDone');
        break;

      case 'response.output_item.added': {
        // Capture function name when the output item is first announced
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
        // Accumulate partial function call arguments
        const { call_id, delta } = event;
        if (!this._pendingFunctionCalls.has(call_id)) {
          this._pendingFunctionCalls.set(call_id, { name: null, argumentsStr: '' });
        }
        this._pendingFunctionCalls.get(call_id).argumentsStr += delta;
        break;
      }

      case 'response.function_call_arguments.done': {
        // All arguments have arrived — queue for batch execution at response.done
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
        this._completedCalls.push({ call_id, fnName, args });
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = event.transcript?.trim();
        if (transcript) this.emit('transcript', transcript);
        break;
      }

      case 'response.done': {
        const calls = this._completedCalls.splice(0);

        if (this._responsePhase === 'announce') {
          // Phase 1 done: Bruce spoke announcement, now let model call functions
          this._responsePhase = 'execute';
          this._send({
            type: 'response.create',
            response: { modalities: ['text'], tool_choice: 'auto' },
          });
        } else if (calls.length > 0) {
          // Functions were called — execute all in parallel
          const results = await Promise.all(
            calls.map(async ({ call_id, fnName, args }) => {
              let result;
              try {
                result = await this._registry.execute(fnName, args);
              } catch (err) {
                result = `Error executing ${fnName}: ${err.message}`;
              }
              return { call_id, fnName, result };
            })
          );

          const ended = results.some(r => r.fnName === 'end_conversation');

          for (const { call_id, result } of results) {
            this._send({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id, output: result },
            });
          }

          if (!ended) {
            // Stay in execute phase — model may need to call more functions
            this._responsePhase = 'execute';
            this._send({
              type: 'response.create',
              response: { modalities: ['text'], tool_choice: 'auto' },
            });
          } else {
            this._responsePhase = null;
          }
        } else if (this._responsePhase === 'execute') {
          // No more functions to call — Phase 3: let model share results with audio
          this._responsePhase = 'results';
          this._send({
            type: 'response.create',
            response: { tool_choice: 'none' },
          });
        } else if (this._responsePhase === 'results') {
          // Phase 2 done, no functions needed
          this._responsePhase = null;
          this.emit('responseDone');
        } else if (this._responsePhase === 'results') {
          // Phase 3 done
          this._responsePhase = null;
          this.emit('responseDone');
        } else {
          this.emit('responseDone');
        }
        break;
      }

      case 'error': {
        const err = new Error(`Realtime API error: ${event.error?.message || JSON.stringify(event.error)}`);
        this.emit('error', err);
        if (rejectConnect) rejectConnect(err);
        break;
      }

      default:
        // Silently ignore unhandled events (rate_limits.updated, input_audio_buffer.committed, etc.)
        break;
    }
  }
}

module.exports = RealtimeClient;
