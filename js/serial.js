/**
 * serial.js — Web Serial API + Modbus RTU frame builder
 * Handles: port open/close, Modbus FC06 (write), FC03 (read), CRC16, Auto-Scan
 */

// ── CRC16 (Modbus) ───────────────────────────────────────────────────── //
function crc16(buffer) {
  let crc = 0xFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x0001) { crc = (crc >> 1) ^ 0xA001; }
      else              { crc >>= 1; }
    }
  }
  return crc;
}

function appendCRC(bytes) {
  const crc = crc16(bytes);
  return new Uint8Array([...bytes, crc & 0xFF, (crc >> 8) & 0xFF]);
}

function verifyCRC(frame) {
  if (frame.length < 2) return false;
  const body = frame.slice(0, -2);
  const received = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
  return crc16(body) === received;
}

// ── Frame format parser ───────────────────────────────────────────────── //
// '8N1' → { dataBits:8, parity:'none', stopBits:1 }
export function parseFrame(frameStr = '8N1') {
  const m = (frameStr || '8N1').match(/^(\d)(N|E|O)(\d)$/i);
  if (!m) return { dataBits: 8, parity: 'none', stopBits: 1 };
  const pMap = { N: 'none', E: 'even', O: 'odd' };
  return { dataBits: parseInt(m[1]), parity: pMap[m[2].toUpperCase()], stopBits: parseInt(m[3]) };
}

// ── Modbus RTU frame builders ────────────────────────────────────────── //
function buildFC06(slaveId, register, value) {
  const frame = [slaveId, 0x06, (register >> 8) & 0xFF, register & 0xFF,
                 (value >> 8) & 0xFF, value & 0xFF];
  return appendCRC(frame);
}

function buildFC03(slaveId, register, count = 1) {
  const frame = [slaveId, 0x03, (register >> 8) & 0xFF, register & 0xFF,
                 (count >> 8) & 0xFF, count & 0xFF];
  return appendCRC(frame);
}

function parseFC03Response(frame) {
  if (!frame || frame.length < 7) return null;
  if (!verifyCRC(frame)) return null;
  if (frame[1] !== 0x03) return null;
  return (frame[3] << 8) | frame[4];
}

// ── Serial port state ────────────────────────────────────────────────── //
let _port    = null;
let _reader  = null;
let _writer  = null;
let _slaveId = 1;

function _clearState() {
  _reader = null;
  _writer = null;
  _port = null;
}

// ── Open port ────────────────────────────────────────────────────────── //
export async function openPort(baud = 9600, slaveId = 1, frame = '8N1') {
  if (!('serial' in navigator)) {
    throw new Error('Web Serial API not supported. Use Chrome or Edge.');
  }
  // Defensive cleanup: avoid stale locks from previous session.
  await closePort();

  _slaveId = slaveId;
  const selectedPort = await navigator.serial.requestPort();
  const { dataBits, parity, stopBits } = parseFrame(frame);
  await selectedPort.open({ baudRate: baud, dataBits, parity, stopBits });
  _port = selectedPort;
  _writer = selectedPort.writable.getWriter();
  _reader = selectedPort.readable.getReader();
  return true;
}

// ── Close port ───────────────────────────────────────────────────────── //
export async function closePort() {
  const reader = _reader;
  const writer = _writer;
  const port = _port;

  try { if (reader) { await reader.cancel(); } } catch {}
  try { if (reader) { reader.releaseLock(); } } catch {}
  try { if (writer) { writer.releaseLock(); } } catch {}
  try { if (port) { await port.close(); } } catch {}

  _clearState();
}

export function isPortOpen() { return _port !== null; }

// ── Read with timeout (uses module _reader) ──────────────────────────── //
async function readBytes(expectedLen, timeoutMs = 700) {
  const deadline = Date.now() + timeoutMs;
  let buf = new Uint8Array(0);
  while (buf.length < expectedLen && Date.now() < deadline) {
    try {
      const { value, done } = await Promise.race([
        _reader.read(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 120)),
      ]);
      if (done) break;
      if (value) {
        const t = new Uint8Array(buf.length + value.length);
        t.set(buf);
        t.set(value, buf.length);
        buf = t;
      }
    } catch (err) {
      if (err?.message === 'timeout') continue;
      break;
    }
  }
  return buf;
}

async function drainInput(maxMs = 60) {
  const stopAt = Date.now() + maxMs;
  while (Date.now() < stopAt) {
    try {
      const { value, done } = await Promise.race([
        _reader.read(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 15)),
      ]);
      if (done || !value || value.length === 0) break;
    } catch (err) {
      if (err?.message === 'timeout') break;
      break;
    }
  }
}

async function readModbusFrame(timeoutMs = 900) {
  const deadline = Date.now() + timeoutMs;
  const buf = [];

  while (Date.now() < deadline) {
    try {
      const { value, done } = await Promise.race([
        _reader.read(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 120)),
      ]);
      if (done) break;
      if (value && value.length) {
        buf.push(...value);
      } else {
        continue;
      }
    } catch (err) {
      if (err?.message === 'timeout') continue;
      break;
    }

    while (buf.length >= 5) {
      const func = buf[1];
      let expected = 0;
      if (func === 0x03 && buf.length >= 3) expected = 5 + buf[2];
      else if (func === 0x83) expected = 5;
      else if (func === 0x06) expected = 8;
      if (!expected || buf.length < expected) break;

      const frame = buf.slice(0, expected);
      if (verifyCRC(frame)) return frame;

      // Re-sync on noisy line.
      buf.shift();
    }
  }
  return null;
}

// ── Read with timeout (uses a given reader) ──────────────────────────── //
async function readBytesRaw(reader, expectedLen, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let buf = new Uint8Array(0);
  while (buf.length < expectedLen && Date.now() < deadline) {
    try {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 80)),
      ]);
      if (done) break;
      if (value) { const t = new Uint8Array(buf.length + value.length); t.set(buf); t.set(value, buf.length); buf = t; }
    } catch (err) {
      if (err?.message === 'timeout') continue;
      break;
    }
  }
  return buf;
}

// ── Write register (FC06) ────────────────────────────────────────────── //
export async function writeRegister(register, value) {
  if (!_writer) throw new Error('Port not open');
  await _writer.write(buildFC06(_slaveId, register, value));
}

// ── Read register (FC03) → value or null ────────────────────────────── //
export async function readRegister(register) {
  if (!_writer || !_reader) throw new Error('Port not open');
  await drainInput();
  await _writer.write(buildFC03(_slaveId, register, 1));
  const response = await readModbusFrame(900);
  if (!response) return null;
  if (response[1] === 0x83) return null;
  return parseFC03Response(response);
}

// ── Read multiple registers sequentially → [{reg, value}] ───────────── //
// regList: [{reg, name, scale, unit}]
export async function readMultipleRegs(regList, interDelay = 90) {
  const results = [];
  for (const item of regList) {
    const raw = await readRegister(item.reg);
    results.push({ ...item, raw, value: raw !== null ? (raw * item.scale).toFixed(2) : null });
    await sleep(interDelay);
  }
  return results;
}

// ── Write + verify (core unlock operation) ──────────────────────────── //
export async function writeAndVerify(pwdReg, verifyReg, value, checkType, delayMs) {
  await writeRegister(pwdReg, value);
  // Wait for inverter to process password — minimum 150ms (was 20ms, too short)
  await sleep(Math.max(delayMs, 150));
  const raw = await readRegister(verifyReg);
  return { unlocked: checkUnlock(raw, checkType), raw };
}

function checkUnlock(raw, checkType) {
  if (raw === null) return false;
  if (checkType === 'eq_zero')     return raw === 0x0000;
  if (checkType === 'neq_ffff')    return raw !== 0xFFFF;
  if (checkType === 'any_nonzero') return raw > 0;
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Auto Scan ────────────────────────────────────────────────────────── //
// Priority-ordered combos: most common inverter settings first
const SCAN_BAUDS  = [9600, 19200, 38400, 4800, 115200];
const SCAN_FRAMES = ['8N1', '8E1', '8O1', '8N2'];
const SCAN_SLAVES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export const SCAN_COMBOS = [];
for (const baud of SCAN_BAUDS)
  for (const frame of SCAN_FRAMES)
    for (const slaveId of SCAN_SLAVES)
      SCAN_COMBOS.push({ baud, frame, slaveId });

export const SCAN_TOTAL = SCAN_COMBOS.length;

/**
 * autoScan — Request port once (user gesture), then probe all combinations.
 * Returns a port object so caller can update UI without re-requesting.
 */
export async function autoScan({ onProgress, onFound, onNotFound }) {
  if (!('serial' in navigator)) throw new Error('Web Serial API not supported.');

  // One user gesture to select the port
  const port = await navigator.serial.requestPort();

  for (let i = 0; i < SCAN_COMBOS.length; i++) {
    const { baud, frame, slaveId } = SCAN_COMBOS[i];
    onProgress?.(i + 1, SCAN_TOTAL, { baud, frame, slaveId });

    const result = await _probeCombo(port, baud, frame, slaveId);
    if (result) {
      // Store in module state — port is already open
      _port    = port;
      _reader  = result.reader;
      _writer  = result.writer;
      _slaveId = slaveId;
      onFound?.({ baud, frame, slaveId });
      return;
    }
  }
  onNotFound?.();
}

/**
 * _probeCombo — Open port with given settings, send FC03, verify response.
 * Returns { reader, writer } if valid Modbus reply, null otherwise.
 * Closes port on failure; leaves it open on success (caller manages state).
 */
async function _probeCombo(port, baud, frame, slaveId) {
  let reader = null, writer = null;
  try {
    const { dataBits, parity, stopBits } = parseFrame(frame);
    await port.open({ baudRate: baud, dataBits, parity, stopBits });
    await sleep(120);
    writer = port.writable.getWriter();
    reader = port.readable.getReader();

    await writer.write(buildFC03(slaveId, 0x0000, 1));
    const resp = await readBytesRaw(reader, 7, 700);
    const frameBytes = Array.from(resp);
    const hasValidCrc = frameBytes.length >= 5 && verifyCRC(frameBytes);
    const isForSlave = frameBytes.length >= 1 && frameBytes[0] === slaveId;
    const isNormalOrException =
      frameBytes.length >= 2 && (frameBytes[1] === 0x03 || frameBytes[1] === 0x83);
    const valid = hasValidCrc && isForSlave && isNormalOrException;

    if (valid) return { reader, writer };   // ← keep open, caller stores these
  } catch { /* probe failed, fall through */ }

  // Clean up on failure
  try { if (reader) { await reader.cancel(); reader.releaseLock(); } } catch {}
  try { if (writer) { writer.releaseLock(); } } catch {}
  try { await port.close(); } catch {}
  return null;
}
