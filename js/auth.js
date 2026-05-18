/**
 * auth.js — Authentication module
 * Handles: OTP request, OTP verify, JWT storage, keep-alive, logout
 */

const API_BASE = window.APP_CONFIG?.apiBase || 'http://localhost:7860';
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let _keepAliveTimer = null;

// ── JWT storage (sessionStorage — clears on tab close) ──────────────── //
function saveToken(token) { sessionStorage.setItem('iup_token', token); }
function getToken()       { return sessionStorage.getItem('iup_token'); }
function clearToken()     { sessionStorage.removeItem('iup_token'); sessionStorage.removeItem('iup_email'); }
function saveEmail(e)     { sessionStorage.setItem('iup_email', e); }
export function getEmail()       { return sessionStorage.getItem('iup_email'); }
export function isLoggedIn()     { return !!getToken(); }
export function isAdmin()        { return sessionStorage.getItem('iup_is_admin') === 'true'; }

// ── API request helper ───────────────────────────────────────────────── //
async function apiCall(method, path, body = null, requireAuth = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (requireAuth) {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

// ── Step 1: Request OTP ──────────────────────────────────────────────── //
export async function requestOTP(email) {
  return apiCall('POST', '/auth/request-otp', { email });
}

// ── Step 2: Verify OTP → get JWT ────────────────────────────────────── //
export async function verifyOTP(email, otp) {
  const data = await apiCall('POST', '/auth/verify-otp', { email, otp });
  saveToken(data.access_token);
  saveEmail(data.email);
  sessionStorage.setItem('iup_is_admin', data.is_admin ? 'true' : 'false');
  startKeepAlive();
  return data;
}

// ── Keep-alive: validate token every 5 min, logout if fail ──────────── //
function startKeepAlive() {
  stopKeepAlive();
  _keepAliveTimer = setInterval(async () => {
    try {
      await apiCall('GET', '/auth/validate', null, true);
    } catch {
      // Token invalid or server unreachable → force logout
      logout('Session expired or internet connection lost.');
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepAlive() {
  if (_keepAliveTimer) {
    clearInterval(_keepAliveTimer);
    _keepAliveTimer = null;
  }
}

// ── Logout ───────────────────────────────────────────────────────────── //
export async function logout(reason = '') {
  stopKeepAlive();
  try {
    await apiCall('POST', '/auth/logout', null, true);
  } catch { /* ignore */ }
  clearToken();
  const url = reason
    ? `index.html?reason=${encodeURIComponent(reason)}`
    : 'index.html';
  window.location.href = url;
}

// ── Auth guard: redirect to login if not authenticated ──────────────── //
export function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = 'index.html';
    return false;
  }
  startKeepAlive(); // resume keep-alive on page load
  return true;
}

// ── Authenticated API call shorthand ────────────────────────────────── //
export function authGet(path)        { return apiCall('GET',  path, null, true); }
export function authPost(path, body) { return apiCall('POST', path, body, true); }
