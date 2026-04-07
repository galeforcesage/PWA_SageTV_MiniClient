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
import { spawn } from 'child_process';

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

// Track active transcode processes
const activeTranscodes = new Map();

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // ── Transcode endpoint ──────────────────────────────────
  if (reqUrl.pathname === '/transcode') {
    const filePath = reqUrl.searchParams.get('file');
    const seekSec = parseFloat(reqUrl.searchParams.get('seek') || '0') || 0;
    const sessionId = reqUrl.searchParams.get('session') || 'default';

    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing file parameter');
      return;
    }

    // Validate path exists (prevent path traversal — only allow absolute paths)
    if (!path.isAbsolute(filePath)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('File path must be absolute');
      return;
    }

    // Kill any existing transcode for this session
    const existing = activeTranscodes.get(sessionId);
    if (existing) {
      console.log(`[Transcode] Killing previous session ${sessionId} (pid=${existing.pid})`);
      existing.kill('SIGTERM');
      activeTranscodes.delete(sessionId);
    }

    // Check file exists before spawning ffmpeg
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }

    console.log(`[Transcode] Starting: file=${filePath} seek=${seekSec}s session=${sessionId}`);

    const ffmpegArgs = [
      ...(seekSec > 0 ? ['-ss', String(seekSec)] : []),
      '-probesize', '5000000',   // probe enough for corrupt MPEG-PS
      '-analyzeduration', '5000000',
      '-err_detect', 'ignore_err',  // tolerate corrupt input
      '-ec', 'deblock+guess_mvs',   // error concealment for damaged frames
      '-v', 'warning',
      '-y',
      '-threads', '4',
      '-sn',                    // no subtitles
      '-i', filePath,
      '-f', 'mp4',              // Fragmented MP4 container (direct to MSE)
      '-vcodec', 'libx264',    // H.264 video
      '-preset', 'veryfast',   // fast encoding for real-time
      '-tune', 'zerolatency',  // low latency
      '-b:v', '2000000',       // 2Mbps video
      '-maxrate', '2500000',
      '-bufsize', '4000000',
      '-r', '30',              // 30fps
      '-s', '1280x720',       // 720p
      '-g', '60',             // keyframe every 2 seconds
      '-bf', '0',             // no B-frames (lower latency)
      '-acodec', 'aac',       // AAC audio
      '-b:a', '128000',       // 128kbps audio
      '-ar', '48000',         // 48kHz
      '-ac', '2',             // stereo
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',               // output to stdout
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeTranscodes.set(sessionId, ffmpeg);

    let stderrBuf = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      // Log first stderr output and errors
      if (stderrBuf.length < 2000) {
        const lines = stderrBuf.split('\n');
        for (const line of lines) {
          if (line.trim()) console.log(`[ffmpeg:${sessionId}] ${line.trim()}`);
        }
        stderrBuf = '';
      }
    });

    ffmpeg.on('error', (err) => {
      console.error(`[Transcode] ffmpeg spawn error: ${err.message}`);
      activeTranscodes.delete(sessionId);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`ffmpeg error: ${err.message}`);
      }
    });

    ffmpeg.on('close', (code) => {
      console.log(`[Transcode] ffmpeg exited (code=${code}) session=${sessionId}`);
      activeTranscodes.delete(sessionId);
      if (!res.writableEnded) {
        res.end();
      }
    });

    // Stream ffmpeg stdout → HTTP response
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache, no-store',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
    });

    ffmpeg.stdout.pipe(res);

    // If client disconnects, kill ffmpeg
    req.on('close', () => {
      console.log(`[Transcode] Client disconnected, killing session ${sessionId}`);
      ffmpeg.kill('SIGTERM');
      activeTranscodes.delete(sessionId);
    });

    return;
  }

  // ── Stop transcode endpoint ─────────────────────────────
  if (reqUrl.pathname === '/transcode/stop') {
    const sessionId = reqUrl.searchParams.get('session') || 'default';
    const existing = activeTranscodes.get(sessionId);
    if (existing) {
      console.log(`[Transcode] Stopping session ${sessionId}`);
      existing.kill('SIGTERM');
      activeTranscodes.delete(sessionId);
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
    });
    res.end('OK');
    return;
  }

  // ── CORS preflight ──────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── Static file serving ─────────────────────────────────
  if (!SERVE_STATIC) {
    res.writeHead(404);
    res.end();
    return;
  }

  let filePath = path.join(__dirname, '..', 'public', reqUrl.pathname === '/' ? 'index.html' : reqUrl.pathname);
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
  console.log(`[Bridge] Transcode endpoint: http://localhost:${BRIDGE_PORT}/transcode?file=<path>&seek=<sec>`);
  if (SAGE_HOST) {
    console.log(`[Bridge] Default SageTV server: ${SAGE_HOST}:${SAGE_PORT}`);
  } else {
    console.log(`[Bridge] Pass ?host=IP&port=31099 in WebSocket URL to specify server`);
  }
});
