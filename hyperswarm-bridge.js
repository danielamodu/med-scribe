const Hyperswarm = require('hyperswarm');
const crypto = require('crypto');

const TOPIC = crypto.createHash('sha256').update('med-scribe-v1').digest();

async function createProvider(onData) {
  const swarm = new Hyperswarm();
  swarm.join(TOPIC, { server: true, client: false });
  
  swarm.on('connection', (conn) => {
    console.log('Phone connected via P2P');
    conn.on('data', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log('Received P2P msg type:', msg.type);
        const result = await onData(msg);
        conn.write(JSON.stringify(result));
      } catch (err) {
        console.error('P2P provider message processing error:', err.message);
        try {
          conn.write(JSON.stringify({ type: 'error', error: err.message }));
        } catch (writeErr) {
          console.error('Failed to send error response over P2P:', writeErr.message);
        }
      }
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
    conn.on('data', (data) => {
      try {
        onResult(JSON.parse(data.toString()));
      } catch (err) {
        console.error('P2P client data parsing error:', err.message);
      }
    });
    return conn;
  });

  await swarm.flush();
  return swarm;
}

module.exports = { createProvider, createClient };
