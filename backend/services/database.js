const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,  // Increased to 10 seconds
});

async function initDatabase() {
  const maxRetries = 5;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      const client = await pool.connect();
      console.log('Database connection established');
      client.release();
      return;
    } catch (err) {
      retries++;
      console.error(`Database connection attempt ${retries}/${maxRetries} failed:`, err.message);
      
      if (retries < maxRetries) {
        console.log(`Retrying in ${retries * 2} seconds...`);
        await new Promise(resolve => setTimeout(resolve, retries * 2000));
      } else {
        console.error('Database connection failed after all retries');
        throw err;
      }
    }
  }
}

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (err) {
    console.error('Query error:', err);
    throw err;
  }
}

module.exports = {
  query,
  pool,
  initDatabase
};
