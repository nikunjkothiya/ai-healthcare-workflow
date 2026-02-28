const bcrypt = require('bcrypt');

async function generateHash() {
  const password = 'demo123';
  const hash = await bcrypt.hash(password, 10);
  console.log('Password:', password);
  console.log('Hash:', hash);
  console.log('\nUse this hash in db/init.sql');
}

generateHash();
