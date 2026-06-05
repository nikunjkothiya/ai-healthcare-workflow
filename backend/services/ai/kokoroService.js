const axios = require('axios');
const fs = require('fs');

/**
 * Kokoro-82M TTS Service — #1 on TTS Arena, only 82M parameters.
 * 
 * Key advantages over Tacotron2 (current):
 * - 82M params vs 28M (Tacotron2) + 14M (HiFiGAN) = 42M combined
 * - But: significantly higher quality (ranks above XTTS 467M, MetaVoice 1.2B)
 * - Apache 2.0 license (fully permissive)
 * - 50+ built-in voices
 * - Faster inference on CPU
 * - Natural prosody and emotion
 * 
 * Voice packs (Kokoro v0.19+):
 * - af_bella, af_sarah, af_sky       (American female)
 * - am_adam, am_michael              (American male)
 * - bf_emma, bf_isabella             (British female)
 * - bm_george, bm_lewis              (British male)
 * 
 * Server: Kokoro-FastAPI (Docker) or direct ONNX inference
 * Model: hexgrad/Kokoro-82M on Hugging Face
 */
class KokoroService {
  constructor() {
    this.host = process.env.KOKORO_HOST || 'kokoro';
    this.port = parseInt(process.env.KOKORO_PORT, 10) || 8880;
    this.baseUrl = `http://${this.host}:${this.port}`;
    this.voice = process.env.KOKORO_VOICE || 'af_bella';
    this.lang = process.env.KOKORO_LANG || 'en-us';
    this.enabled = String(process.env.TTS_PROVIDER || 'kokoro').toLowerCase() === 'kokoro';
    
    // Simple in-memory cache for common phrases
    this.cache = new Map();
    this.maxCacheSize = 200;
  }

  /**
   * Synthesize text to speech via Kokoro server.
   * @param {string} text - Text to synthesize
   * @param {string} outputPath - Output WAV file path
   * @returns {Promise<string>} - Path to output file
   */
  async synthesize(text, outputPath) {
    if (!this.enabled) {
      throw new Error('Kokoro TTS is not enabled. Set TTS_PROVIDER=kokoro');
    }

    const startedAt = Date.now();
    const text_clean = String(text || '').trim();
    if (!text_clean) {
      throw new Error('No text provided for synthesis');
    }

    // Check cache
    const cacheKey = `${this.voice}:${text_clean.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      fs.writeFileSync(outputPath, cached);
      console.log(`[LATENCY][KOKORO] cache-hit ${Date.now() - startedAt}ms`);
      return outputPath;
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/v1/audio/speech`,
        {
          model: 'kokoro',
          input: text_clean,
          voice: this.voice,
          response_format: 'wav',
          speed: 1.0
        },
        {
          responseType: 'arraybuffer',
          timeout: 15000
        }
      );

      const audioBuffer = Buffer.from(response.data);
      fs.writeFileSync(outputPath, audioBuffer);

      // Cache short/common phrases
      if (text_clean.length <= 200) {
        if (this.cache.size >= this.maxCacheSize) {
          const firstKey = this.cache.keys().next().value;
          this.cache.delete(firstKey);
        }
        this.cache.set(cacheKey, audioBuffer);
      }

      console.log(`[LATENCY][KOKORO] ${Date.now() - startedAt}ms`);
      return outputPath;
    } catch (error) {
      console.error('Kokoro TTS error:', error.message);
      throw new Error(`Kokoro TTS synthesis failed: ${error.message}`);
    }
  }

  /**
   * Check if Kokoro service is healthy.
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
   * List available voices from the server.
   * @returns {Promise<string[]>}
   */
  async listVoices() {
    try {
      const response = await axios.get(`${this.baseUrl}/v1/voices`, { timeout: 5000 });
      return Array.isArray(response.data) ? response.data : [];
    } catch {
      return [];
    }
  }
}

module.exports = new KokoroService();
