/**
 * SageTV MiniClient WebSocket-to-TCP Bridge
 *
 * Bridges browser WebSocket connections to the SageTV server's raw TCP protocol.
 * Supports two channels per client: GFX (UI) and Media (playback).
 *
 * Usage:
 *   node ws-bridge.js [--serve-static] [--port 8099] [--sage-host 192.168.1.x] [--sage-port 31099]
 */

import { WebSocketServer, WebSocket } from 'ws';
import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
const BRIDGE_PORT = parseInt(getArg('port', '8099'), 10);
const SAGE_HOST = getArg('sage-host', '');
const SAGE_PORT = parseInt(getArg('sage-port', '31099'), 10);
const SERVE_STATIC = args.includes('--serve-static');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const server = http.createServer((req, res) => {
  if (!SERVE_STATIC) {
    res.writeHead(404);
    res.end();
    return;
  }

  let filePath = path.join(__dirname, '..', 'public', req.url === '/' ? 'index.html' : req.url);
  filePath = path.normalize(filePath);

  // Prevent directory traversal
  const publicDir = path.resolve(path.join(__dirname, '..', 'public'));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
});

// WebSocket server on paths: /gfx, /media
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const channelPath = url.pathname; // /gfx or /media
  const sageHost = url.searchParams.get('host') || SAGE_HOST;
  const sagePort = parseInt(url.searchParams.get('port') || SAGE_PORT, 10);

  if (!sageHost) {
    ws.close(4001, 'Missing sage-host parameter');
    return;
  }

  if (channelPath !== '/gfx' && channelPath !== '/media' && channelPath !== '/reconnect') {
    ws.close(4002, 'Invalid channel path. Use /gfx, /media, or /reconnect');
    return;
  }

  console.log(`[Bridge] New ${channelPath} connection → ${sageHost}:${sagePort}`);

  const tcpStartTime = Date.now();
  let bytesSentToTcp = 0;
  let bytesRecvFromTcp = 0;

  const tcpSocket = net.createConnection({ host: sageHost, port: sagePort }, () => {
    console.log(`[Bridge] TCP connected to ${sageHost}:${sagePort} for ${channelPath} (${Date.now() - tcpStartTime}ms)`);
  });

  tcpSocket.on('error', (err) => {
    console.error(`[Bridge] TCP error (${channelPath}):`, err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(4003, `TCP error: ${err.message}`);
    }
  });

  tcpSocket.on('close', () => {
    console.log(`[Bridge] TCP closed for ${channelPath}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'TCP connection closed');
    }
  });

  // Forward TCP data → WebSocket (binary frames)
  tcpSocket.on('data', (chunk) => {
    bytesRecvFromTcp += chunk.length;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });

  // Forward WebSocket data → TCP
  // IMPORTANT: In the ws library, `data` is always a Buffer for both text and
  // binary frames. Use `isBinary` (not instanceof) to distinguish them.
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // Text frame — handle control messages, NEVER forward to TCP
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        console.warn(`[Bridge] Unexpected text frame on ${channelPath}: ${data.toString().substring(0, 80)}`);
      }
      return;
    }
    // Binary frame — forward to TCP
    if (tcpSocket.writable) {
      bytesSentToTcp += data.length;
      tcpSocket.write(Buffer.from(data));
    } else {
      console.warn(`[Bridge] TCP not writable for ${channelPath}, dropping ${data.length} bytes`);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[Bridge] WebSocket closed for ${channelPath} (code=${code}, sent=${bytesSentToTcp}B, recv=${bytesRecvFromTcp}B)`);
    tcpSocket.destroy();
  });

  ws.on('error', (err) => {
    console.error(`[Bridge] WebSocket error (${channelPath}):`, err.message);
    tcpSocket.destroy();
  });
});

server.listen(BRIDGE_PORT, () => {
  console.log(`[Bridge] SageTV MiniClient Bridge running on port ${BRIDGE_PORT}`);
  if (SERVE_STATIC) {
    console.log(`[Bridge] Serving PWA at http://localhost:${BRIDGE_PORT}/`);
  }
  console.log(`[Bridge] WebSocket endpoints: ws://localhost:${BRIDGE_PORT}/gfx, /media`);
  if (SAGE_HOST) {
    console.log(`[Bridge] Default SageTV server: ${SAGE_HOST}:${SAGE_PORT}`);
  } else {
    console.log(`[Bridge] Pass ?host=IP&port=31099 in WebSocket URL to specify server`);
  }
});
