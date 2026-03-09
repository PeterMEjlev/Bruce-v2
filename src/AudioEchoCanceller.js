'use strict';

/**
 * AudioEchoCanceller
 *
 * Energy-based echo gate for barge-in detection.
 *
 * Monitors speaker output energy and microphone input energy.
 * Auto-calibrates the speaker→mic echo coupling ratio during early playback.
 * Detects barge-in when mic energy has significant EXCESS above expected echo.
 *
 * The microphone stays muted to the server while Bruce speaks — this module only
 * decides WHEN to interrupt, not what audio to send.
 */

class AudioEchoCanceller {
  /**
   * @param {object} [opts]
   * @param {number} [opts.speechThreshold=400]     - Minimum excess RMS above expected
   *        echo to count as user speech. In PCM16 amplitude units (0–32768).
   *        Lower = easier to interrupt. Higher = more resistant to false triggers.
   * @param {number} [opts.triggerLevel=3.0]        - Accumulated confidence needed to
   *        trigger barge-in. Uses a leaky integrator: +1 per frame above threshold,
   *        -0.3 per frame below. Tolerates gaps between syllables.
   * @param {number} [opts.initialEchoCoupling=0.3] - Starting echo coupling estimate.
   *        Auto-calibrates during playback.
   * @param {boolean} [opts.debug=false]            - Log energy values to console.
   */
  constructor(opts = {}) {
    this._speechThreshold = opts.speechThreshold || 400;
    this._triggerLevel = opts.triggerLevel || 3.0;
    this._adaptRate = 0.05;
    this._debug = opts.debug || false;

    // Echo coupling = mic_echo_rms / speaker_rms
    this._echoCoupling = opts.initialEchoCoupling || 0.3;

    // Far-end peak energy with decay (compensates for speaker output latency)
    this._farEndPeak = 0;
    this._farEndDecay = 0.97;

    // Barge-in detection state — leaky integrator (float, not integer count)
    this._confidence = 0;
    this._playbackFrameCount = 0;

    // Calibration: skip first N frames, then calibrate for M frames
    this._calibrationSkip = 15;
    this._calibrationEnd = 50;

    // Debug: throttle logging to every Nth frame
    this._debugInterval = 5;
  }

  /**
   * Feed far-end (speaker) audio to track its energy.
   * @param {Buffer} chunk - Raw PCM16 LE audio
   */
  feedFarEnd(chunk) {
    const rms = this._computeRMS(chunk);
    this._farEndPeak = Math.max(rms, this._farEndPeak * this._farEndDecay);
  }

  /**
   * Analyse a microphone chunk and decide whether the user is speaking (barge-in).
   * @param {Buffer} micChunk - Raw PCM16 LE audio from the microphone
   * @returns {boolean} true if a genuine barge-in is detected
   */
  detectBargeIn(micChunk) {
    const micRMS = this._computeRMS(micChunk);
    this._playbackFrameCount++;

    // ── Auto-calibrate echo coupling ──────────────────────────────────────
    if (
      this._playbackFrameCount > this._calibrationSkip &&
      this._playbackFrameCount <= this._calibrationEnd &&
      this._farEndPeak > 100
    ) {
      const measured = micRMS / this._farEndPeak;
      this._echoCoupling += this._adaptRate * (measured - this._echoCoupling);
      this._echoCoupling = Math.max(0.01, Math.min(2.0, this._echoCoupling));

      if (this._debug && this._playbackFrameCount === this._calibrationEnd) {
        console.log(`[AEC] calibration done — echoCoupling=${this._echoCoupling.toFixed(3)}`);
      }
    }

    // Don't allow barge-in during calibration
    if (this._playbackFrameCount <= this._calibrationSkip + 5) {
      return false;
    }

    // ── Barge-in decision ─────────────────────────────────────────────────
    // Expected echo = how loud the mic SHOULD be from speaker bleed alone.
    const expectedEcho = this._farEndPeak * this._echoCoupling;

    // Excess = how much louder the mic is than expected echo.
    // If excess > speechThreshold, the extra energy is likely user speech.
    const excess = micRMS - expectedEcho;

    // Leaky integrator: accumulate confidence when excess is above threshold,
    // decay slowly when below. This tolerates energy dips between syllables.
    if (excess > this._speechThreshold) {
      this._confidence += 1.0;
    } else {
      this._confidence = Math.max(0, this._confidence - 0.3);
    }

    if (this._debug && this._playbackFrameCount % this._debugInterval === 0) {
      console.log(
        `[AEC] mic=${micRMS.toFixed(0)} farEnd=${this._farEndPeak.toFixed(0)} ` +
        `echo=${expectedEcho.toFixed(0)} excess=${excess.toFixed(0)} ` +
        `thresh=${this._speechThreshold} conf=${this._confidence.toFixed(1)}/${this._triggerLevel}`
      );
    }

    if (this._confidence >= this._triggerLevel) {
      if (this._debug) {
        console.log(`[AEC] BARGE-IN TRIGGERED — excess=${excess.toFixed(0)} conf=${this._confidence.toFixed(1)}`);
      }
      return true;
    }

    return false;
  }

  /**
   * Call when a new assistant utterance begins.
   * Resets barge-in counters. Echo coupling carries over.
   */
  resetForUtterance() {
    this._confidence = 0;
    this._playbackFrameCount = 0;
  }

  /**
   * Full reset for a new conversation.
   */
  reset() {
    this._confidence = 0;
    this._playbackFrameCount = 0;
    this._farEndPeak = 0;
    this._echoCoupling = 0.3;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _computeRMS(chunk) {
    const numSamples = Math.floor(chunk.length / 2);
    if (numSamples === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < chunk.length; i += 2) {
      const s = chunk.readInt16LE(i);
      sumSq += s * s;
    }
    return Math.sqrt(sumSq / numSamples);
  }
}

module.exports = AudioEchoCanceller;
