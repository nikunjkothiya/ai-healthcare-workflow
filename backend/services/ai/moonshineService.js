const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

/**
 * Moonshine STT Service — 5x faster than Whisper for edge/real-time inference.
 * 
 * Moonshine is designed specifically for live voice agents:
 * - 27M-106M params (vs Whisper's 1.5B)
 * - Optimized encoder for streaming audio
 * - 5x lower latency than Whisper on same hardware
 * - Runs on CPU efficiently
 * 
 * Model sizes:
 * - moonshine/tiny  (27M)  — fastest, good for simple audio
 * - moonshine/base  (106M) — balanced speed/accuracy (recommended)
 * 
 * Provider: Useful Sensors (Apache 2.0 license)
 * Server: moonshine-server (Docker) or direct Python inference
 */
class MoonshineService {
  constructor() {
    this.host = process.env.MOONSHINE_HOST || 'moonshine';
    this.port = parseInt(process.env.MOONSHINE_PORT, 10) || 9001;
    this.baseUrl = `http://${this.host}:${this.port}`;
    this.model = process.env.MOONSHINE_MODEL || 'moonshine/base';
    this.enabled = String(process.env.STT_PROVIDER || 'whisper').toLowerCase() === 'moonshine';
  }

  /**
   * Transcribe audio file via Moonshine server.
   * @param {string} audioFilePath - Path to WAV file
   * @param {object} options - { language, task }
   * @returns {Promise<string>}
   */
  async transcribe(audioFilePath, options = {}) {
    if (!this.enabled) {
      throw new Error('Moonshine STT is not enabled. Set STT_PROVIDER=moonshine');
    }

    const formData = new FormData();
    formData.append('audio', fs.createReadStream(audioFilePath));
    formData.append('model', this.model);
    formData.append('language', options.language || 'en');
    formData.append('response_format', 'json');

    const response = await axios.post(
      `${this.baseUrl}/v1/audio/transcriptions`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: 10000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    return (response.data && response.data.text) ? response.data.text.trim() : '';
  }

  /**
   * Check if Moonshine service is healthy.
   * @returns {Promise<boolean>}
   */
  async isHealthy() {
    try {
      const response = await axios.get(`${this.baseUrl}/health`, { timeout: 3000 });
      if (response.status === 200) return true;
    } catch (_) {}

    try {
      const response = await axios.get(`${this.baseUrl}/`, { timeout: 3000 });
      return response.status === 200;
    } catch (_) {
      return false;
    }
  }

  /**
   * Get estimated latency for a given audio duration.
   * Moonshine is ~5x faster than Whisper base.
   * @param {number} audioDurationMs
   * @returns {number} estimated latency in ms
   */
  estimateLatency(audioDurationMs) {
    // Moonshine base achieves ~0.2x real-time on CPU
    return Math.max(150, audioDurationMs * 0.2);
  }
}

module.exports = new MoonshineService();
