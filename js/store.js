// Thin client for reading/writing this site's data.
//
// Reads go straight to the raw.githubusercontent.com CDN (no auth, generous
// limits) since the repo is public. Writes go through a small Cloudflare
// Worker (see /worker) that holds the GitHub write token server-side, so no
// secret ever ships in this static site — anyone can upload without any
// setup.

import { SITE_CONFIG } from './config.js';

const NAME_KEY = 'bo_tracker_name';

function detectRepoFromLocation() {
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.split('.')[0];
    const parts = location.pathname.split('/').filter(Boolean);
    const repo = parts.length > 0 ? parts[0] : `${owner}.github.io`;
    return { owner, repo };
  }
  return null;
}

export function getRepoInfo() {
  const detected = detectRepoFromLocation();
  return {
    owner: detected?.owner || SITE_CONFIG.fallbackOwner,
    repo: detected?.repo || SITE_CONFIG.fallbackRepo,
    branch: SITE_CONFIG.fallbackBranch || 'main'
  };
}

export function getLastName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
}

export function setLastName(name) {
  try { localStorage.setItem(NAME_KEY, name || ''); } catch (e) { /* ignore */ }
}

export function rawUrl(path) {
  const { owner, repo, branch } = getRepoInfo();
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Read-only fetch of a JSON data file via the raw CDN. Falls back to `fallback`
// if the file doesn't exist yet (e.g. an empty trades.json before the first entry).
export async function getJson(path, fallback = []) {
  const { owner, repo } = getRepoInfo();
  if (!owner || !repo) return fallback;
  const res = await fetch(`${rawUrl(path)}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return fallback;
  if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status})`);
  const text = await res.text();
  if (!text.trim()) return fallback;
  return JSON.parse(text);
}

function workerFileUrl(path) {
  return `${SITE_CONFIG.workerUrl}/api/file?path=${encodeURIComponent(path)}`;
}

async function getFileForWrite(path) {
  let res;
  try {
    res = await fetch(workerFileUrl(path), { cache: 'no-store' });
  } catch (e) {
    throw new UploadError(0, 'Could not reach the upload service. Check your connection and try again.');
  }
  if (res.status === 404) return { text: null, sha: null };
  if (!res.ok) throw await uploadError(res);
  return res.json();
}

async function uploadError(res) {
  let detail = '';
  try { const body = await res.json(); detail = body.error || ''; } catch (e) { /* ignore */ }
  return new UploadError(res.status, `Upload service error ${res.status}${detail ? ': ' + detail : ''}`);
}

async function putFileRaw(path, base64Content, sha, message) {
  let res;
  try {
    res = await fetch(`${SITE_CONFIG.workerUrl}/api/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: base64Content, message, ...(sha ? { sha } : {}) })
    });
  } catch (e) {
    throw new UploadError(0, 'Could not reach the upload service. Check your connection and try again.');
  }
  if (!res.ok) throw await uploadError(res);
  return res.json();
}

export async function deleteFile(path, sha, message) {
  let res;
  try {
    res = await fetch(`${SITE_CONFIG.workerUrl}/api/file`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, sha, message })
    });
  } catch (e) {
    throw new UploadError(0, 'Could not reach the upload service. Check your connection and try again.');
  }
  if (!res.ok) throw await uploadError(res);
  return res.json();
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

// Read-modify-write a JSON data file, retrying if someone else committed in
// between (the PUT will 409/422 on a stale sha) by re-fetching and re-applying.
export async function updateJsonFile(path, mutateFn, message, maxRetries = 4) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { text, sha } = await getFileForWrite(path);
    const data = text ? JSON.parse(text) : [];
    const updated = mutateFn(data);
    try {
      await putFileRaw(path, utf8ToBase64(JSON.stringify(updated, null, 2)), sha, message);
      return updated;
    } catch (e) {
      lastErr = e;
      if (e.status === 409 || e.status === 422) continue;
      throw e;
    }
  }
  throw lastErr || new Error('Could not save changes after multiple attempts.');
}

export function resizeImageToBase64(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image file.'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image file.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

export async function uploadImageFile(file, path, message) {
  const base64 = await resizeImageToBase64(file);
  return putFileRaw(path, base64, null, message);
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function toast(message, kind = 'info', duration = 4500) {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    document.body.appendChild(root);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, duration);
}
