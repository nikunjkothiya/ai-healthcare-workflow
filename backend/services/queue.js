const { Queue } = require('bullmq');
const Redis = require('ioredis');

const connection = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  maxRetriesPerRequest: null,
});

const callQueue = new Queue('calls', { connection });

async function addCallJob(patientId, extraData = {}, delayMs = 0) {
  const jobData = {
    patientId,
    timestamp: new Date().toISOString(),
    ...extraData
  };
  
  const job = await callQueue.add('process-call', jobData, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    delay: Math.max(0, parseInt(delayMs, 10) || 0)
  });
  
  console.log(`Added call job for patient ${patientId}, job ID: ${job.id}, callMode: ${jobData.callMode || 'not set'}, delayMs: ${delayMs}`);
  console.log(`Job data:`, JSON.stringify(jobData));
  return job;
}

module.exports = {
  callQueue,
  addCallJob
};
