'use strict';

const { EventEmitter } = require('events');
const { Porcupine } = require('@picovoice/porcupine-node');
const path = require('path');

class WakeWordDetector extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.accessKey - Picovoice access key
   * @param {string} opts.wakeWordPath - Path to .ppn wake word file
   * @param {number} [opts.sensitivity=0.5] - Detection sensitivity 0.0–1.0
   */
  constructor({ accessKey, wakeWordPath, sensitivity = 0.5 }) {
    super();
    this._accessKey = accessKey;
    this._wakeWordPath = path.resolve(wakeWordPath);
    this._sensitivity = sensitivity;
    this._porcupine = null;
    this._active = false;

    // Accumulate mic bytes until we have a full Porcupine frame
    this._buffer = Buffer.alloc(0);
  }

  get frameLength() {
    return this._porcupine ? this._porcupine.frameLength : 512;
  }

  get sampleRate() {
    return this._porcupine ? this._porcupine.sampleRate : 16000;
  }

  start() {
    this._porcupine = new Porcupine(
      this._accessKey,
      [this._wakeWordPath],
      [this._sensitivity]
    );
    this._active = true;
  }

  stop() {
    this._active = false;
    this._buffer = Buffer.alloc(0);
    if (this._porcupine) {
      this._porcupine.release();
      this._porcupine = null;
    }
  }

  /**
   * Feed raw PCM16 LE bytes from the mic stream.
   * Internally accumulates bytes and slices into exact Porcupine frames (512 Int16 samples).
   * Emits 'detected' when the wake word is recognized.
   * @param {Buffer} chunk
   */
  processAudio(chunk) {
    if (!this._active || !this._porcupine) return;

    this._buffer = Buffer.concat([this._buffer, chunk]);

    // Each sample is 2 bytes (Int16); Porcupine requires exactly frameLength samples
    const frameSizeBytes = this._porcupine.frameLength * 2;

    while (this._buffer.length >= frameSizeBytes) {
      const frameBytes = this._buffer.slice(0, frameSizeBytes);
      this._buffer = this._buffer.slice(frameSizeBytes);

      // Convert Buffer -> Int16Array using byteOffset to handle Buffer's internal offset correctly
      const frame = new Int16Array(
        frameBytes.buffer,
        frameBytes.byteOffset,
        this._porcupine.frameLength
      );

      const keywordIndex = this._porcupine.process(frame);
      if (keywordIndex !== -1) {
        this.emit('detected', keywordIndex);
      }
    }
  }
}

module.exports = WakeWordDetector;
