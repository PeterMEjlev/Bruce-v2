'use strict';

/**
 * Bruce Assistant — Tunable Parameters
 * Edit these values to adjust Bruce's behaviour.
 */
module.exports = {

  // ── Conversation Flow ────────────────────────────────────────────────────

  // How long (ms) of inactivity before Bruce ends the conversation and returns to idle.
  // Resets whenever the user speaks or Bruce responds.
  CONVERSATION_IDLE_TIMEOUT_MS: 15000,


  // ── Server-side VAD (Voice Activity Detection) ────────────────────────────
  // These are passed to OpenAI's Realtime API server_vad turn detection.

  // Activation threshold (0.0–1.0). Lower = more sensitive to speech.
  // Higher values reduce false interruptions from speaker echo / background noise.
  VAD_THRESHOLD: 0.8,

  // Amount of speech audio (ms) to include before the detected speech start.
  VAD_PREFIX_PADDING_MS: 300,

  // Duration of silence (ms) after speech before the server commits the turn.
  VAD_SILENCE_DURATION_MS: 500,


  // ── Debug ────────────────────────────────────────────────────────────────

  // Print microphone energy levels to the console
  // 'off'       — no energy logging
  // 'listening' — log energy while Bruce is in conversation
  DEBUG_ENERGY: 'off',

};
