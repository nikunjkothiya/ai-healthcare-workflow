const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);
const NON_SPEECH_ARTIFACT_REGEX = /\[(?:BLANK_AUDIO|SILENCE|NO_SPEECH|MUSIC)\]|\((?:SILENCE|NOISE|MUSIC)\)|<\|(?:nospeech|silence)\|>/gi;

class STTService {
  constructor() {
    this.whisperHost = process.env.WHISPER_HOST || 'whisper';
    this.whisperPort = parseInt(process.env.WHISPER_PORT, 10) || 9000;
    this.whisperBaseUrl = `http://${this.whisperHost}:${this.whisperPort}`;
    this.modelPath = process.env.WHISPER_MODEL_PATH || '/models/whisper/ggml-small.en.bin';
    this.whisperBinaryPath = process.env.WHISPER_BINARY_PATH || '/whisper.cpp/build/bin/whisper-cli';

    this.realtimeChunkMs = parseInt(process.env.STT_CHUNK_MS, 10) || 2500;
    this.chunkOverlapMs = parseInt(process.env.STT_CHUNK_OVERLAP_MS, 10) || 300;
    this.silenceFinalizeMs = parseInt(process.env.STT_SILENCE_MS, 10) || 800;
    this.silenceRmsThreshold = parseFloat(process.env.STT_VAD_SILENCE_RMS || '0.004');
  }

  /**
   * Standard transcription API kept for backward compatibility.
   * @param {string} audioFilePath
   * @returns {Promise<string>}
   */
  async transcribe(audioFilePath) {
    return this._transcribeSingle(audioFilePath);
  }

  /**
   * Realtime transcription path with fixed 1.5-2s chunking and silence finalization signal.
   * @param {string} audioFilePath
   * @param {object} options
   * @returns {Promise<object>}
   */
  async transcribeRealtime(audioFilePath, options = {}) {
    const chunkMs = parseInt(options.chunkMs, 10) || this.realtimeChunkMs;
    const overlapMs = parseInt(options.overlapMs, 10) || this.chunkOverlapMs;
    const silenceThresholdMs = parseInt(options.silenceThresholdMs, 10) || this.silenceFinalizeMs;

    if (!fs.existsSync(audioFilePath)) {
      return {
        partials: [],
        transcript: '',
        isFinal: false,
        trailingSilenceMs: 0,
        chunkMs,
        silenceThresholdMs
      };
    }

    const isValid = await this.validateAudio(audioFilePath);
    if (!isValid) {
      return {
        partials: [],
        transcript: '',
        isFinal: false,
        trailingSilenceMs: 0,
        chunkMs,
        silenceThresholdMs
      };
    }

    const wavBuffer = fs.readFileSync(audioFilePath);
    const chunks = this.splitWavIntoChunks(wavBuffer, chunkMs, overlapMs);
    const partials = [];

    for (let index = 0; index < chunks.length; index++) {
      const chunkPath = path.join(path.dirname(audioFilePath), `${path.basename(audioFilePath, '.wav')}_chunk_${index}.wav`);
      try {
        fs.writeFileSync(chunkPath, chunks[index]);
        const partial = await this._transcribeSingle(chunkPath);
        if (partial) {
          partials.push(partial);
        }
      } finally {
        try {
          if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);
        } catch (_) {
          // Ignore cleanup errors for temp chunk files.
        }
      }
    }

    // Deduplicate overlapping text between consecutive chunks
    const transcript = this.cleanTranscriptText(this.deduplicatePartials(partials));
    const trailingSilenceMs = this.detectTrailingSilenceMs(wavBuffer);
    const isFinal = trailingSilenceMs >= silenceThresholdMs;

    return {
      partials,
      transcript,
      isFinal,
      trailingSilenceMs,
      chunkMs,
      silenceThresholdMs
    };
  }

  async _transcribeSingle(audioFilePath) {
    const startedAt = Date.now();

    try {
      if (!fs.existsSync(audioFilePath)) {
        return '';
      }

      const isValid = await this.validateAudio(audioFilePath);
      if (!isValid) {
        return '';
      }

      try {
        return this.cleanTranscriptText(await this.transcribeViaHTTP(audioFilePath));
      } catch (httpErr) {
        console.log(`STT: HTTP transcription unavailable (${httpErr.message}), trying local binary...`);
      }

      try {
        return this.cleanTranscriptText(await this.transcribeViaBinary(audioFilePath));
      } catch (_) {
        // continue to empty transcript fallback
      }

      return '';
    } catch (error) {
      console.error('STT transcription error:', error.message);
      return '';
    } finally {
      const latencyMs = Date.now() - startedAt;
      console.log(`[LATENCY][STT] ${latencyMs}ms`);
    }
  }

  splitWavIntoChunks(wavBuffer, chunkMs, overlapMs = 0) {
    const meta = this.parseWavMeta(wavBuffer);
    if (!meta) {
      return [wavBuffer];
    }

    const bytesPerSample = (meta.bitsPerSample / 8) * meta.channels;
    const bytesPerChunk = Math.max(bytesPerSample, Math.floor((meta.sampleRate * chunkMs / 1000) * bytesPerSample));
    const overlapBytes = overlapMs > 0
      ? Math.max(0, Math.floor((meta.sampleRate * overlapMs / 1000) * bytesPerSample))
      : 0;
    const stepBytes = Math.max(bytesPerSample, bytesPerChunk - overlapBytes);

    const chunks = [];
    for (let offset = 0; offset < meta.data.length; offset += stepBytes) {
      const end = Math.min(offset + bytesPerChunk, meta.data.length);
      const pcm = meta.data.slice(offset, end);
      if (pcm.length === 0) continue;
      chunks.push(this.createWavBuffer(pcm, meta));
    }

    return chunks.length > 0 ? chunks : [wavBuffer];
  }

  parseWavMeta(wavBuffer) {
    if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length < 44) {
      return null;
    }

    const riff = wavBuffer.toString('ascii', 0, 4);
    const wave = wavBuffer.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      return null;
    }

    const channels = wavBuffer.readUInt16LE(22);
    const sampleRate = wavBuffer.readUInt32LE(24);
    const bitsPerSample = wavBuffer.readUInt16LE(34);

    if (!channels || !sampleRate || !bitsPerSample) {
      return null;
    }

    let dataOffset = 36;
    while (dataOffset + 8 <= wavBuffer.length) {
      const chunkId = wavBuffer.toString('ascii', dataOffset, dataOffset + 4);
      const chunkSize = wavBuffer.readUInt32LE(dataOffset + 4);

      if (chunkId === 'data') {
        const start = dataOffset + 8;
        const end = Math.min(start + chunkSize, wavBuffer.length);
        return {
          channels,
          sampleRate,
          bitsPerSample,
          data: wavBuffer.slice(start, end)
        };
      }

      dataOffset += 8 + chunkSize + (chunkSize % 2);
    }

    return null;
  }

  createWavBuffer(pcmData, meta) {
    const header = Buffer.alloc(44);
    const dataLength = pcmData.length;
    const byteRate = meta.sampleRate * meta.channels * (meta.bitsPerSample / 8);
    const blockAlign = meta.channels * (meta.bitsPerSample / 8);

    header.write('RIFF', 0, 4, 'ascii');
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8, 4, 'ascii');
    header.write('fmt ', 12, 4, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(meta.channels, 22);
    header.writeUInt32LE(meta.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(meta.bitsPerSample, 34);
    header.write('data', 36, 4, 'ascii');
    header.writeUInt32LE(dataLength, 40);

    return Buffer.concat([header, pcmData]);
  }

  detectTrailingSilenceMs(wavBuffer) {
    const meta = this.parseWavMeta(wavBuffer);
    if (!meta || meta.bitsPerSample !== 16) {
      return 0;
    }

    const bytesPerSample = 2 * meta.channels;
    const frameSamples = Math.max(1, Math.floor(meta.sampleRate * 0.02)); // 20ms frames
    const frameBytes = frameSamples * bytesPerSample;

    let silenceFrames = 0;

    for (let offset = meta.data.length - frameBytes; offset >= 0; offset -= frameBytes) {
      let sumSq = 0;
      let count = 0;

      for (let i = 0; i < frameBytes; i += bytesPerSample) {
        const sample = meta.data.readInt16LE(offset + i);
        const normalized = sample / 32768;
        sumSq += normalized * normalized;
        count += 1;
      }

      if (count === 0) break;
      const rms = Math.sqrt(sumSq / count);
      if (rms <= this.silenceRmsThreshold) {
        silenceFrames += 1;
      } else {
        break;
      }
    }

    return silenceFrames * 20;
  }

  /**
   * Transcribe via HTTP API.
   * Supports modern whisper.cpp server (/inference) and legacy (/asr) endpoints.
   * @param {string} audioFilePath - Path to WAV file
   * @returns {Promise<string>} Transcribed text
   */
  async transcribeViaHTTP(audioFilePath) {
    try {
      return await this.transcribeViaInferenceEndpoint(audioFilePath);
    } catch (error) {
      console.log(`STT: /inference endpoint failed (${error.message}), trying legacy /asr endpoint...`);
      return this.transcribeViaLegacyEndpoint(audioFilePath);
    }
  }

  async transcribeViaInferenceEndpoint(audioFilePath) {
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioFilePath), {
      filename: path.basename(audioFilePath),
      contentType: 'audio/wav'
    });
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');
    formData.append('temperature_inc', '0.2');

    const response = await axios.post(
      `${this.whisperBaseUrl}/inference`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: 45000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    return this.extractTranscript(response.data).trim();
  }

  async transcribeViaLegacyEndpoint(audioFilePath) {
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('audio_file', fs.createReadStream(audioFilePath), {
      filename: path.basename(audioFilePath),
      contentType: 'audio/wav'
    });

    const response = await axios.post(
      `${this.whisperBaseUrl}/asr?task=transcribe&language=en&output=json`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: 45000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    return this.extractTranscript(response.data).trim();
  }

  /**
   * Transcribe using whisper.cpp binary directly (if binary path is accessible)
   * @param {string} audioFilePath
   * @returns {Promise<string>}
   */
  async transcribeViaBinary(audioFilePath) {
    if (!fs.existsSync(this.whisperBinaryPath)) {
      throw new Error(`Whisper binary not found at ${this.whisperBinaryPath}`);
    }

    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Whisper model not found at ${this.modelPath}`);
    }

    const command = `${this.whisperBinaryPath} -m ${this.modelPath} -f ${audioFilePath} --no-timestamps 2>/dev/null`;
    const { stdout } = await execAsync(command, { timeout: 30000 });

    const lines = stdout.split('\n');
    const transcriptLines = lines.filter((line) =>
      !line.includes('[') &&
      !line.includes('whisper_') &&
      !line.includes('load time') &&
      !line.includes('system_info') &&
      line.trim().length > 0
    );

    return transcriptLines.join(' ').trim();
  }

  /**
   * Normalize known STT API response shapes into plain transcript text.
   * @param {any} data
   * @returns {string}
   */
  extractTranscript(data) {
    if (!data) return '';

    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        return this.extractTranscript(parsed);
      } catch (_) {
        return data.trim();
      }
    }

    if (typeof data.text === 'string') {
      return data.text.trim();
    }

    if (data.result && typeof data.result.text === 'string') {
      return data.result.text.trim();
    }

    if (Array.isArray(data.segments)) {
      return data.segments
        .map((segment) => (typeof segment?.text === 'string' ? segment.text.trim() : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
    }

    return '';
  }

  cleanTranscriptText(input) {
    const text = String(input || '')
      .replace(NON_SPEECH_ARTIFACT_REGEX, ' ')
      .replace(/\b(?:blank[_ ]audio|no[_ ]speech)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) return '';
    return text.replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, '').trim();
  }

  /**
   * Check if audio file is valid
   * @param {string} audioFilePath
   * @returns {Promise<boolean>}
   */
  async validateAudio(audioFilePath) {
    try {
      const stats = fs.statSync(audioFilePath);
      if (stats.size < 512) {
        return false;
      }
      return true;
    } catch (error) {
      console.error('STT: Audio validation error:', error.message);
      return false;
    }
  }

  /**
   * Remove duplicate text at chunk boundaries caused by overlapping audio.
   * Uses suffix-prefix matching to find and remove repeated words.
   * @param {string[]} partials - Array of transcribed text from overlapping chunks
   * @returns {string} Merged text with duplicates removed
   */
  deduplicatePartials(partials) {
    if (!Array.isArray(partials) || partials.length === 0) return '';
    if (partials.length === 1) return partials[0];

    let merged = partials[0] || '';

    for (let i = 1; i < partials.length; i++) {
      const current = partials[i] || '';
      if (!current) continue;
      if (!merged) {
        merged = current;
        continue;
      }

      const prevWords = merged.split(/\s+/);
      const currWords = current.split(/\s+/);

      // Look for the longest overlap (up to 6 words) at the boundary
      let bestOverlap = 0;
      const maxCheck = Math.min(6, prevWords.length, currWords.length);

      for (let overlapLen = 1; overlapLen <= maxCheck; overlapLen++) {
        const tailOfPrev = prevWords.slice(-overlapLen).map(w => w.toLowerCase()).join(' ');
        const headOfCurr = currWords.slice(0, overlapLen).map(w => w.toLowerCase()).join(' ');

        if (tailOfPrev === headOfCurr) {
          bestOverlap = overlapLen;
        }
      }

      if (bestOverlap > 0) {
        // Remove the overlapping words from the start of current chunk
        merged += ' ' + currWords.slice(bestOverlap).join(' ');
      } else {
        merged += ' ' + current;
      }
    }

    return merged.replace(/\s+/g, ' ').trim();
  }
}

module.exports = new STTService();
