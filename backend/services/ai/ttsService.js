class TTSService {
  constructor() {
    this.kokoroService = require('./kokoroService');
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

  /**
   * Convert text to speech with the fixed Kokoro server provider.
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

      return await this.kokoroService.synthesize(sentenceText, outputPath);
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
    try {
      return await this.kokoroService.isHealthy();
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
