import dgram from 'node:dgram';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const osc = require('osc');

const port = Number(process.argv[2] || process.env.OSC_PORT || 9000);
const host = process.argv[3] || '0.0.0.0';

const sock = dgram.createSocket('udp4');

function printPacket(packet, prefix = '') {
  if (packet.packets && Array.isArray(packet.packets)) {
    for (const child of packet.packets) {
      printPacket(child, `${prefix}[bundle] `);
    }
    return;
  }
  const formattedArgs = (packet.args || [])
    .map((a) => (typeof a.value === 'number' ? Number(a.value.toFixed(3)) : a.value))
    .join(', ');
  console.log(`${prefix}${packet.address}  (${formattedArgs})`);
}

sock.on('error', (err) => {
  console.error(`[OSC-Listen] Error: ${err.message}`);
  process.exit(1);
});

sock.on('message', (msg, rinfo) => {
  try {
    const packet = osc.readPacket(msg, { metadata: true });
    console.log(`--- ${new Date().toLocaleTimeString()} | ${rinfo.address}:${rinfo.port} (${msg.length}B) ---`);
    printPacket(packet);
  } catch (err) {
    console.error(`[OSC-Listen] Failed to decode (${msg.length}B):`, err.message);
  }
});

sock.bind(port, host, () => {
  console.log(`[OSC-Listen] Listening for UDP OSC packets on ${host}:${port}`);
  console.log('Press Ctrl+C to stop.');
});
