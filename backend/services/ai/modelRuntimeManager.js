const axios = require('axios');
const os = require('os');

const GB = 1024 * 1024 * 1024;

class ModelRuntimeManager {
  constructor(options = {}) {
    this.ollamaUrl = options.ollamaUrl;
    this.realtimeModel = options.realtimeModel;
    this.analysisModel = options.analysisModel;
    this.maxRamGb = Number(options.maxRamGb || 14);
    this.activeRealtimeSessions = 0;
    this.currentStage = 'none';
    this.swapChain = Promise.resolve();
  }

  _serializeSwap(task) {
    const run = this.swapChain.then(task, task);
    this.swapChain = run.catch(() => {});
    return run;
  }

  _logMemory(stage) {
    const totalGb = os.totalmem() / GB;
    const usedGb = (os.totalmem() - os.freemem()) / GB;
    const rssGb = process.memoryUsage().rss / GB;

    console.log(
      `[MODEL-RUNTIME] stage=${stage} activeRealtime=${this.activeRealtimeSessions} hostUsed=${usedGb.toFixed(2)}GB/${totalGb.toFixed(2)}GB processRss=${rssGb.toFixed(2)}GB`
    );

    if (usedGb > this.maxRamGb) {
      console.warn(
        `[MODEL-RUNTIME] Memory guard warning: host memory ${usedGb.toFixed(2)}GB exceeds target ${this.maxRamGb.toFixed(2)}GB`
      );
    }
  }

  async _warmModel(modelName, keepAlive = '30m') {
    if (!modelName) {
      throw new Error('Cannot warm model: empty model name');
    }

    await axios.post(
      `${this.ollamaUrl}/api/generate`,
      {
        model: modelName,
        prompt: 'Return {"ok":true}',
        stream: false,
        keep_alive: keepAlive,
        options: {
          temperature: 0,
          top_p: 0.1,
          num_predict: 16,
          num_ctx: 256
        }
      },
      { timeout: 120000 }
    );
  }

  async _unloadModel(modelName) {
    if (!modelName) return;

    try {
      await axios.post(
        `${this.ollamaUrl}/api/generate`,
        {
          model: modelName,
          prompt: '',
          stream: false,
          keep_alive: 0,
          options: {
            num_predict: 1
          }
        },
        { timeout: 60000 }
      );
    } catch (error) {
      console.warn(`[MODEL-RUNTIME] unload failed for ${modelName}: ${error.message}`);
    }
  }

  async ensureRealtimeModel() {
    return this._serializeSwap(async () => {
      if (this.currentStage === 'realtime') {
        return;
      }

      await this._unloadModel(this.analysisModel);
      await this._warmModel(this.realtimeModel, '30m');
      this.currentStage = 'realtime';
      this._logMemory('realtime');
    });
  }

  async acquireRealtimeSession() {
    this.activeRealtimeSessions += 1;

    try {
      await this.ensureRealtimeModel();
    } catch (error) {
      this.activeRealtimeSessions = Math.max(0, this.activeRealtimeSessions - 1);
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.activeRealtimeSessions = Math.max(0, this.activeRealtimeSessions - 1);
    };
  }

  async waitForRealtimeDrain(timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;

    while (this.activeRealtimeSessions > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (this.activeRealtimeSessions > 0) {
      throw new Error(
        `Timed out waiting for realtime sessions to drain (${this.activeRealtimeSessions} still active)`
      );
    }
  }

  async ensureAnalysisModel(options = {}) {
    const waitForRealtime = options.waitForRealtime !== false;
    const timeoutMs = Number(options.timeoutMs || 180000);

    if (waitForRealtime) {
      await this.waitForRealtimeDrain(timeoutMs);
    }

    return this._serializeSwap(async () => {
      if (this.currentStage === 'analysis') {
        return;
      }

      await this._unloadModel(this.realtimeModel);
      await this._warmModel(this.analysisModel, '15m');
      this.currentStage = 'analysis';
      this._logMemory('analysis');
    });
  }

  async releaseAnalysisModel() {
    return this._serializeSwap(async () => {
      if (this.currentStage !== 'analysis') {
        return;
      }

      await this._unloadModel(this.analysisModel);
      this.currentStage = 'none';
      this._logMemory('none');
    });
  }

  getState() {
    return {
      stage: this.currentStage,
      activeRealtimeSessions: this.activeRealtimeSessions,
      realtimeModel: this.realtimeModel,
      analysisModel: this.analysisModel
    };
  }
}

module.exports = ModelRuntimeManager;
