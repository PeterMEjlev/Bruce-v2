'use strict';

/**
 * Bruce Assistant — Tunable Parameters
 * Edit these values to adjust Bruce's behaviour.
 */
module.exports = {

  // ── Voice Activity Detection ─────────────────────────────────────────────

  // RMS energy below this level is treated as silence (scale: 0–32768)
  // Increase if background noise causes false "speech detected" triggers
  SILENCE_ENERGY_THRESHOLD: 200,

  // How long (ms) of continuous silence before committing audio to OpenAI
  // Shorter = Bruce responds faster; longer = more natural pauses allowed
  SILENCE_THRESHOLD_MS: 1500,

  // Maximum time (ms) Bruce will listen before force-committing audio
  // Safety valve to prevent endless listening if silence detection fails
  MAX_UTTERANCE_MS: 10000,


  // ── Conversation Flow ────────────────────────────────────────────────────

  // How long (ms) to wait for a follow-up question after Bruce finishes speaking
  // If no voice is detected in this window, Bruce goes back to idle
  FOLLOW_UP_TIMEOUT_MS: 5000,


  // ── Debug ────────────────────────────────────────────────────────────────

  // Print microphone energy levels to the console
  // Useful for tuning SILENCE_ENERGY_THRESHOLD and BARGE_IN_ENERGY_THRESHOLD
  // 'off'      — no energy logging
  // 'listening' — log energy while Bruce is listening for your speech
  DEBUG_ENERGY: 'off',

};
