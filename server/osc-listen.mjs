import dgram from 'node:dgram';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const osc = require('osc');

const cliPorts = process.argv
  .slice(2)
  .map((v) => Number(v))
  .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);

const ports = cliPorts.length > 0 ? cliPorts : [9000, 9001, 9002];
const host = process.env.OSC_LISTEN_HOST || '0.0.0.0';

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

for (const port of ports) {
  const sock = dgram.createSocket('udp4');

  sock.on('error', (err) => {
    console.error(`[OSC-Listen:${port}] Error: ${err.message}`);
  });

  sock.on('message', (msg, rinfo) => {
    try {
      const packet = osc.readPacket(msg, { metadata: true });
      console.log(
        `--- [PORT ${port}] ${new Date().toLocaleTimeString()} | ${rinfo.address}:${rinfo.port} (${msg.length}B) ---`
      );
      printPacket(packet);
    } catch (err) {
      console.error(`[OSC-Listen:${port}] Failed to decode (${msg.length}B):`, err.message);
    }
  });

  sock.bind(port, host, () => {
    console.log(`[OSC-Listen] Listening for UDP OSC packets on ${host}:${port}`);
  });
}

console.log('Press Ctrl+C to stop.');
