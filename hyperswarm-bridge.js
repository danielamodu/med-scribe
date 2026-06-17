const Hyperswarm = require('hyperswarm');
const crypto = require('crypto');

const TOPIC = crypto.createHash('sha256').update('med-scribe-v1').digest();

async function createProvider(onData) {
  const swarm = new Hyperswarm();
  swarm.join(TOPIC, { server: true, client: false });
  
  swarm.on('connection', (conn) => {
    console.log('Phone connected via P2P');
    conn.on('data', async (data) => {
      const msg = JSON.parse(data.toString());
      console.log('Received:', msg.type);
      const result = await onData(msg);
      conn.write(JSON.stringify(result));
    });
    conn.on('error', (e) => console.error('P2P error:', e.message));
  });

  await swarm.flush();
  console.log('Provider listening on DHT topic');
  return swarm;
}

async function createClient(onResult) {
  const swarm = new Hyperswarm();
  swarm.join(TOPIC, { server: false, client: true });

  swarm.on('connection', (conn) => {
    console.log('Connected to laptop provider');
    conn.on('data', (data) => onResult(JSON.parse(data.toString())));
    return conn;
  });

  await swarm.flush();
  return swarm;
}

module.exports = { createProvider, createClient };
