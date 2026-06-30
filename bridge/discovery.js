/**
 * SageTV LAN discovery for the PWA bridge.
 *
 * Browsers cannot do UDP/multicast, so the bridge runs the locator protocol
 * on behalf of the PWA. Mirrors what SageTV.java's discovery and
 * MiniDiscovery servers expect (see java/sage/SageTV.java
 * launchExtraServers / launchMiniDiscoveryServer).
 *
 * Two probes go out in parallel:
 *   • UDP 8270  "STV" + version bytes  → fat-client locator
 *       reply: STV, maj, min, micro, portHi, portLo, nameLen, name…
 *       gives us hostname + SageTV client port (7818 by default).
 *   • UDP 31100 "STV" + 0x01           → mini-client locator
 *       reply (15B): STV, 0x02, 0x01, guid[8], portHi, portLo
 *       gives us systemGuid + Placeshifter port (31099 by default).
 *
 * Replies are merged per source IP. The PWA only needs (host, port=31099) to
 * make the bridge connect; everything else is for display.
 */

import dgram from 'dgram';
import os from 'os';

const STV_MAGIC = Buffer.from([0x53, 0x54, 0x56]); // 'S','T','V'

// Probe version reported to the fat-client locator. Must be >= the server's
// CLIENT_COMPATIBLE_*_VERSION (currently 9.0.14 in Sage.java) or the server
// drops the probe silently. 9.9.99 leaves headroom without claiming a future
// major. The mini-client locator only checks the magic + 0x01 marker.
const PROBE_MAJOR = 9;
const PROBE_MINOR = 9;
const PROBE_MICRO = 99;

/**
 * Compute IPv4 subnet-directed broadcast addresses for every non-internal
 * interface. Windows in particular tends to drop replies to
 * `255.255.255.255` when the host has multiple NICs because it picks a
 * single (often wrong) interface; sending to each subnet's local broadcast
 * (e.g. 192.168.0.255) works reliably.
 */
function _localBroadcastAddrs() {
  const out = new Set();
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      // Derive broadcast addr from address + netmask.
      const ip = ni.address.split('.').map((p) => parseInt(p, 10));
      const mask = (ni.netmask || '255.255.255.0').split('.').map((p) => parseInt(p, 10));
      if (ip.length !== 4 || mask.length !== 4) continue;
      const bcast = ip.map((octet, i) => (octet & mask[i]) | (~mask[i] & 0xff));
      out.add(bcast.join('.'));
    }
  }
  return [...out];
}

/**
 * @typedef {Object} DiscoveredServer
 * @property {string} host          Source IP that replied.
 * @property {number} port          Placeshifter / MiniClient port (default 31099).
 * @property {string} name          Hostname from fat-client reply, else host.
 * @property {string|null} guid     Hex systemGuid (8 bytes) from mini reply.
 * @property {string|null} sageVersion  e.g. "9.2.7".
 * @property {number|null} sagePort     SageTV client/control port (default 7818).
 * @property {string[]} sources     Which locators answered: any of 'fat','mini'.
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=2000]
 * @param {string} [opts.broadcastAddr='255.255.255.255']
 * @returns {Promise<DiscoveredServer[]>}
 */
export function discoverServers({
  timeoutMs = 2000,
  broadcastAddr = '255.255.255.255',
  extraTargets = [],
} = {}) {
  return new Promise((resolve) => {
    // Probe destinations: caller's broadcastAddr, every interface's
    // subnet-directed broadcast (helps multi-NIC Windows hosts), plus any
    // explicit unicast targets the caller passes.
    const targets = new Set([broadcastAddr, ..._localBroadcastAddrs(), ...extraTargets]);
    /** @type {Map<string, DiscoveredServer>} */
    const byHost = new Map();

    const upsert = (host, patch, source) => {
      const existing = byHost.get(host) || {
        host,
        port: 31099,
        name: host,
        guid: null,
        sageVersion: null,
        sagePort: null,
        sources: [],
      };
      Object.assign(existing, patch);
      if (!existing.sources.includes(source)) existing.sources.push(source);
      byHost.set(host, existing);
    };

    let fatSock = null;
    let miniSock = null;
    let timer = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { fatSock?.close(); } catch { /* ignore */ }
      try { miniSock?.close(); } catch { /* ignore */ }
      const results = [...byHost.values()].sort((a, b) =>
        (a.name || '').localeCompare(b.name || ''));
      resolve(results);
    };

    // ── Fat-client locator (UDP 8270) ──
    fatSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    fatSock.on('error', (err) => {
      console.warn('[Discovery] fat-client socket error:', err.message);
    });
    fatSock.on('message', (msg, rinfo) => {
      if (msg.length < 9) return;
      if (msg[0] !== 0x53 || msg[1] !== 0x54 || msg[2] !== 0x56) return;
      const major = msg[3], minor = msg[4], micro = msg[5];
      const sagePort = (msg[6] << 8) | msg[7];
      const nameLen = msg[8];
      let name = rinfo.address;
      if (nameLen > 0 && msg.length >= 9 + nameLen) {
        try {
          name = msg.slice(9, 9 + nameLen).toString('utf8').replace(/\u0000+$/g, '');
        } catch { /* keep IP */ }
      }
      upsert(rinfo.address, {
        name: name || rinfo.address,
        sagePort: sagePort > 0 ? sagePort : null,
        sageVersion: `${major}.${minor}.${micro}`,
      }, 'fat');
    });
    fatSock.bind(0, () => {
      try { fatSock.setBroadcast(true); } catch { /* ignore */ }
      const probe = Buffer.alloc(32);
      STV_MAGIC.copy(probe, 0);
      probe[3] = PROBE_MAJOR;
      probe[4] = PROBE_MINOR;
      probe[5] = PROBE_MICRO;
      for (const dst of targets) {
        fatSock.send(probe, 0, probe.length, 8270, dst, (err) => {
          if (err) console.warn(`[Discovery] fat probe → ${dst} failed:`, err.message);
        });
      }
    });

    // ── Mini-client locator (UDP 31100) ──
    miniSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    miniSock.on('error', (err) => {
      console.warn('[Discovery] mini-client socket error:', err.message);
    });
    miniSock.on('message', (msg, rinfo) => {
      if (msg.length < 15) return;
      if (msg[0] !== 0x53 || msg[1] !== 0x54 || msg[2] !== 0x56) return;
      // Server stamps 0x02 in the response marker, 0x01 in the response version.
      if (msg[3] !== 0x02) return;
      const guidBytes = msg.slice(5, 13);
      const guid = guidBytes.toString('hex');
      const port = (msg[13] << 8) | msg[14];
      upsert(rinfo.address, { guid, port: port > 0 ? port : 31099 }, 'mini');
    });
    miniSock.bind(0, () => {
      try { miniSock.setBroadcast(true); } catch { /* ignore */ }
      const probe = Buffer.alloc(10);
      STV_MAGIC.copy(probe, 0);
      probe[3] = 0x01; // mini-discovery request marker
      for (const dst of targets) {
        miniSock.send(probe, 0, probe.length, 31100, dst, (err) => {
          if (err) console.warn(`[Discovery] mini probe → ${dst} failed:`, err.message);
        });
      }
    });

    timer = setTimeout(finish, timeoutMs);
  });
}
