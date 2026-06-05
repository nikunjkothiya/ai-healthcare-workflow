const axios = require('axios');
const fs = require('fs');

class TTSService {
  constructor() {
    this.ttsProvider = (process.env.TTS_PROVIDER || 'kokoro').toLowerCase();
    this.ttsHost = process.env.TTS_HOST || 'tts';
    this.ttsPort = process.env.TTS_PORT || 5002;
    this.baseUrl = `http://${this.ttsHost}:${this.ttsPort}`;

    this.cache = new Map();
    this.maxCacheEntries = parseInt(process.env.TTS_CACHE_MAX_ITEMS, 10) || 100;
    this.commonPhraseCache = new Set([
      'thank you for your time.',
      'a care coordinator will follow up with you shortly.',
      'if this is a medical emergency, please contact emergency services immediately.',
      'could you please repeat that?',
      'goodbye and take care.'
    ]);
  }

  normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  toSentenceLevelText(text) {
    const normalized = this.normalizeText(text);
    if (!normalized) return '';

    const sentences = normalized.match(/[^.!?]+[.!?]/g) || [];
    if (sentences.length > 0) {
      return this.normalizeText(sentences.join(' '));
    }

    // Enforce full sentence output to avoid partial-token synthesis.
    return normalized.endsWith('.') ? normalized : `${normalized}.`;
  }

  getCacheKey(text) {
    return this.normalizeText(text).toLowerCase();
  }

  setCache(cacheKey, audioBuffer) {
    if (!cacheKey || !audioBuffer) return;

    if (this.cache.size >= this.maxCacheEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    this.cache.set(cacheKey, Buffer.from(audioBuffer));
  }

  async requestSynthesis(sentenceText, retries = 2) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await axios.get(`${this.baseUrl}/api/tts`, {
          params: { text: sentenceText },
          responseType: 'arraybuffer',
          timeout: 25000
        });
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          // Brief wait before retry — Tacotron2 recovers after a failed synthesis
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
    throw lastError;
  }

  /**
   * Split text into shorter sentences for Tacotron2 synthesis.
   * Long text causes tensor size mismatches in the attention layer.
   */
  splitIntoSentences(text) {
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (sentences.length === 0) {
      return [text];
    }
    // Hard-cap to a small number of sentences per synthesis call to keep latency predictable.
    return sentences.slice(0, 3);
  }

  /**
   * Concatenate multiple WAV buffers (assumes same sample rate / format).
   */
  concatenateWavBuffers(buffers) {
    if (buffers.length === 0) return Buffer.alloc(0);
    if (buffers.length === 1) return buffers[0];

    // Extract PCM data from each WAV (skip 44-byte header)
    const pcmChunks = buffers.map(buf => {
      if (buf.length <= 44) return buf;
      return buf.slice(44);
    });

    const totalPcmLength = pcmChunks.reduce((sum, c) => sum + c.length, 0);

    // Use header from the first buffer as template
    const header = Buffer.from(buffers[0].slice(0, 44));
    // Update file size (bytes 4-7): totalPcmLength + 36
    header.writeUInt32LE(totalPcmLength + 36, 4);
    // Update data chunk size (bytes 40-43): totalPcmLength
    header.writeUInt32LE(totalPcmLength, 40);

    return Buffer.concat([header, ...pcmChunks]);
  }

  /**
   * Convert text to speech with streaming support.
   * Returns first sentence audio immediately, synthesizes remaining sentences.
   * @param {string} text
   * @param {string} outputPath
   * @returns {Promise<string>}
   */
  async synthesize(text, outputPath) {
    const startedAt = Date.now();

    try {
      const sentenceText = this.toSentenceLevelText(text);
      if (!sentenceText) {
        throw new Error('No valid sentence-level text for synthesis');
      }

      if (this.ttsProvider === 'kokoro') {
        try {
          const kokoroService = require('./kokoroService');
          return await kokoroService.synthesize(sentenceText, outputPath);
        } catch (err) {
          console.warn(`TTS: Kokoro synthesis failed (${err.message}), falling back to Coqui...`);
        }
      }

      const cacheKey = this.getCacheKey(sentenceText);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        fs.writeFileSync(outputPath, cached);
        console.log(`[LATENCY][TTS] cache-hit ${Date.now() - startedAt}ms`);
        return outputPath;
      }

      const sentences = this.splitIntoSentences(sentenceText);
      if (sentences.length === 0) {
        throw new Error('No sentences to synthesize');
      }

      // Synthesize first sentence immediately for low latency
      const firstResponse = await this.requestSynthesis(sentences[0]);
      const firstBuffer = Buffer.from(firstResponse.data);
      fs.writeFileSync(outputPath, firstBuffer);

      // Synthesize remaining sentences and concatenate
      if (sentences.length > 1) {
        const remainingBuffers = [firstBuffer];
        for (let i = 1; i < sentences.length; i++) {
          const response = await this.requestSynthesis(sentences[i]);
          remainingBuffers.push(Buffer.from(response.data));
        }
        const fullBuffer = this.concatenateWavBuffers(remainingBuffers);
        fs.writeFileSync(outputPath, fullBuffer);
      }

      if (this.commonPhraseCache.has(cacheKey) || sentenceText.length <= 100) {
        this.setCache(cacheKey, fs.readFileSync(outputPath));
      }

      console.log(`[LATENCY][TTS] ${Date.now() - startedAt}ms (${sentences.length} sentences)`);
      return outputPath;
    } catch (error) {
      console.error('TTS error:', error.message);
      throw new Error('Failed to generate speech');
    }
  }

  /**
   * Check TTS service health
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    if (this.ttsProvider === 'kokoro') {
      try {
        const kokoroService = require('./kokoroService');
        const healthy = await kokoroService.isHealthy();
        if (healthy) return true;
      } catch (_) {}
    }

    try {
      const response = await axios.get(`${this.baseUrl}/`, { timeout: 3000 });
      return response.status === 200;
    } catch (error) {
      console.error('TTS health check failed:', error.message);
      return false;
    }
  }

  /**
   * Get supported languages
   * @returns {Promise<Array>}
   */
  async getSupportedLanguages() {
    return ['en'];
  }
}

module.exports = new TTSService();
