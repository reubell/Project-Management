'use strict';

// Google Drive storage. Uses Google's redirect sign-in (works the same on
// phones and desktops, no popups) and the drive.file permission, so the app
// can only see the files it created itself.

const Drive = (() => {
  const CLIENT_ID = (window.APP_CONFIG && window.APP_CONFIG.googleClientId) || '';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FOLDER = 'application/vnd.google-apps.folder';
  const KEY = 'driveSync';

  const secure = location.protocol === 'https:' || location.hostname === 'localhost';
  const enabled = !!CLIENT_ID && secure;

  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { cfg = {}; }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} };

  class AuthError extends Error {}
  class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  const tokenValid = () => !!cfg.token && Date.now() < cfg.expires;

  function authorize(silent) {
    const state = Math.random().toString(36).slice(2);
    localStorage.setItem('oauthState', state);
    const p = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: location.origin + location.pathname,
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      state,
    });
    if (cfg.email) p.set('login_hint', cfg.email);
    if (silent) p.set('prompt', 'none');
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p);
  }

  // On page load: pick up the token Google sends back in the URL.
  function handleRedirect() {
    if (!location.hash.includes('state=')) return;
    const p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    if (p.get('state') !== localStorage.getItem('oauthState')) return;
    localStorage.removeItem('oauthState');
    if (p.get('access_token')) {
      cfg.token = p.get('access_token');
      cfg.expires = Date.now() + (Number(p.get('expires_in')) - 120) * 1000;
      cfg.connected = true;
      persist();
    }
  }

  // Google tokens last one hour. If this device was connected before, bounce
  // through Google to get a fresh one; it comes straight back when access was
  // already granted. Returns true when the page is navigating away.
  function silentReauth() {
    if (!enabled || !cfg.connected || tokenValid() || !navigator.onLine) return false;
    if (Date.now() - (cfg.silentAt || 0) < 10 * 60_000) return false;
    cfg.silentAt = Date.now();
    persist();
    authorize(true);
    return true;
  }

  function disconnect() {
    cfg = {};
    persist();
  }

  async function api(url, opts = {}) {
    if (!tokenValid()) throw new AuthError('Google sign-in expired');
    const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + cfg.token, ...opts.headers } });
    if (res.status === 401) {
      cfg.token = null;
      persist();
      throw new AuthError('Google sign-in expired');
    }
    if (!res.ok) {
      let msg = 'Google Drive error ' + res.status;
      try { msg = (await res.json()).error.message || msg; } catch {}
      throw new HttpError(res.status, msg);
    }
    return res;
  }

  async function find(tag) {
    const q = `appProperties has { key='pt' and value='${tag}' } and trashed=false`;
    const res = await api(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
    return (await res.json()).files[0]?.id || null;
  }

  async function createFolder(meta) {
    const res = await api(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ ...meta, mimeType: FOLDER }),
    });
    return (await res.json()).id;
  }

  async function uploadNew(meta, blob) {
    const boundary = 'pt' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return (await res.json()).id;
  }

  async function ensureAccount() {
    if (cfg.email) return;
    const res = await api(`${API}/about?fields=user(emailAddress)`);
    cfg.email = (await res.json()).user.emailAddress;
    persist();
  }

  async function ensureFolders() {
    if (!cfg.rootId) {
      cfg.rootId = await find('root') || await createFolder({ name: 'Project Tasks', appProperties: { pt: 'root' } });
    }
    if (!cfg.filesId) {
      cfg.filesId = await find('files') || await createFolder({ name: 'Files', parents: [cfg.rootId], appProperties: { pt: 'files' } });
    }
    if (!cfg.dataId) cfg.dataId = await find('data');
    persist();
  }

  // The task list itself: one JSON file. Returns its text, or null if none yet.
  async function readData() {
    if (!cfg.dataId) return null;
    try {
      return await (await api(`${API}/files/${cfg.dataId}?alt=media`)).text();
    } catch (err) {
      // Deleted from Drive by hand: forget the folders so the next sync rebuilds them.
      if (err.status === 404) { cfg.rootId = cfg.filesId = cfg.dataId = null; persist(); }
      throw err;
    }
  }

  async function writeData(text) {
    const blob = new Blob([text], { type: 'application/json' });
    if (cfg.dataId) {
      await api(`${UPLOAD}/files/${cfg.dataId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: blob,
      });
    } else {
      cfg.dataId = await uploadNew({ name: 'tasks.json', parents: [cfg.rootId], appProperties: { pt: 'data' } }, blob);
      persist();
    }
  }

  const uploadFile = (blob, name, localId) =>
    uploadNew({ name, parents: [cfg.filesId], appProperties: { pt: 'file', ptId: localId } }, blob);

  const download = async driveId => (await api(`${API}/files/${driveId}?alt=media`)).blob();

  // Moves to Drive's trash (recoverable for 30 days) rather than deleting.
  async function trash(driveId) {
    try {
      await api(`${API}/files/${driveId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ trashed: true }),
      });
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  return {
    enabled,
    AuthError,
    isConnected: () => !!cfg.connected,
    email: () => cfg.email || '',
    tokenValid,
    authorize,
    handleRedirect,
    silentReauth,
    disconnect,
    ensureAccount,
    ensureFolders,
    readData,
    writeData,
    uploadFile,
    download,
    trash,
  };
})();
