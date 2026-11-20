// drive.js — the only place that talks to storage.
// realDrive() calls the Google Drive REST API v3 directly with fetch().
// mockDrive() fakes the same interface in localStorage so you can try the
// lock flow with two "people" in two browser tabs, with no Google setup.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const META_FIELDS = 'id,name,md5Checksum,modifiedTime,appProperties,ownedByMe,lastModifyingUser(displayName,emailAddress)';

export function realDrive(getToken) {
  async function call(url, opts = {}, raw = false) {
    const res = await fetch(url, {
      cache: 'no-store',
      ...opts,
      headers: { Authorization: 'Bearer ' + getToken(), ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(res.status === 401 ? 'Google sign-in expired' : `Drive error ${res.status}: ${body.slice(0, 300)}`);
      e.code = res.status;
      throw e;
    }
    if (res.status === 204) return null;
    return raw ? res.text() : res.json();
  }
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const list = async query => {
    let files = [], pageToken = '';
    do {
      const r = await call(`${API}/files?q=${encodeURIComponent(query)}&orderBy=createdTime desc&pageSize=100` +
        `&fields=nextPageToken,files(id,name,createdTime,ownedByMe,owners(displayName,emailAddress))` +
        (pageToken ? `&pageToken=${pageToken}` : ''));
      files = files.concat(r.files);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return files;
  };

  return {
    async me() {
      const r = await call(`${API}/about?fields=user(displayName,emailAddress)`);
      return { name: r.user.displayName || r.user.emailAddress, email: r.user.emailAddress };
    },
    // Folders with this name that I own OR that were shared with me.
    findFolders: name => list(`name='${esc(name)}' and mimeType='${FOLDER}' and trashed=false`),
    findChild: async (parentId, name, isFolder) =>
      (await list(`'${parentId}' in parents and name='${esc(name)}' and trashed=false and mimeType${isFolder ? '=' : '!='}'${FOLDER}'`))[0] || null,
    listChildren: parentId => list(`'${parentId}' in parents and trashed=false`), // newest first
    createFolder: (name, parentId) =>
      call(`${API}/files?fields=id,name`, json({ name, mimeType: FOLDER, ...(parentId ? { parents: [parentId] } : {}) })),
    async createFile(parentId, name, text) {
      const boundary = 'poc' + Math.random().toString(36).slice(2);
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name, parents: [parentId], mimeType: 'application/json' }) +
        `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
      return call(`${UPLOAD}/files?uploadType=multipart&fields=id,name`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      });
    },
    getMeta: id => call(`${API}/files/${id}?fields=${META_FIELDS}`),
    readText: id => call(`${API}/files/${id}?alt=media`, {}, true),
    writeText: (id, text) => call(`${UPLOAD}/files/${id}?uploadType=media&fields=id,md5Checksum`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text,
    }),
    // appProperties are private to this OAuth app. A value of null deletes the key.
    setAppProps: (id, props, keepalive = false) => call(`${API}/files/${id}?fields=appProperties`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appProperties: props }), keepalive,
    }),
    copy: (id, parentId, name) => call(`${API}/files/${id}/copy?fields=id,name`, json({ name, parents: [parentId] })),
    del: id => call(`${API}/files/${id}`, { method: 'DELETE' }),
    share: (id, email) => call(`${API}/files/${id}/permissions?sendNotificationEmail=true`, json({ type: 'user', role: 'writer', emailAddress: email })),
  };
}

// ---------- Mock: same interface, stored in this browser's localStorage ----------
const MOCK_USERS = {
  alice: { name: 'Alice (demo)', email: 'alice@example.com' },
  bob: { name: 'Bob (demo)', email: 'bob@example.com' },
};

export function mockDrive(who) {
  const me = MOCK_USERS[who] || MOCK_USERS.alice;
  const KEY = 'poc-mockdrive';
  const load = () => JSON.parse(localStorage.getItem(KEY) || '{"files":{}}');
  const store = d => localStorage.setItem(KEY, JSON.stringify(d));
  const wait = () => new Promise(r => setTimeout(r, 120));
  const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0; return h.toString(16); };
  const uid = () => Math.random().toString(36).slice(2, 12);
  const visible = (d, f) => f.owner === me.email || (f.shared || []).includes(me.email) ||
    (f.parents || []).some(p => d.files[p] && visible(d, d.files[p]));
  const pub = f => ({ id: f.id, name: f.name, createdTime: f.createdTime, ownedByMe: f.owner === me.email, owners: [{ emailAddress: f.owner }] });
  const get = (d, id) => { const f = d.files[id]; if (!f || !visible(d, f)) { const e = new Error('Mock 404'); e.code = 404; throw e; } return f; };
  let seq = 0;
  const add = (d, f) => { const id = uid(); d.files[id] = { id, createdTime: new Date().toISOString() + String(seq++).padStart(4, '0'), owner: me.email, appProperties: {}, ...f }; return d.files[id]; };
  const newestFirst = (a, b) => (a.createdTime < b.createdTime ? 1 : -1);

  return {
    async me() { await wait(); return me; },
    async findFolders(name) { await wait(); const d = load(); return Object.values(d.files).filter(f => f.folder && f.name === name && visible(d, f)).sort(newestFirst).map(pub); },
    async findChild(parentId, name, isFolder) { await wait(); const d = load(); const f = Object.values(d.files).find(f => f.parents?.includes(parentId) && f.name === name && !!f.folder === !!isFolder); return f ? pub(f) : null; },
    async listChildren(parentId) { await wait(); const d = load(); return Object.values(d.files).filter(f => f.parents?.includes(parentId)).sort(newestFirst).map(pub); },
    async createFolder(name, parentId) { await wait(); const d = load(); const f = add(d, { name, folder: true, parents: parentId ? [parentId] : [] }); store(d); return pub(f); },
    async createFile(parentId, name, text) { await wait(); const d = load(); const f = add(d, { name, parents: [parentId], content: text }); store(d); return pub(f); },
    async getMeta(id) {
      await wait(); const f = get(load(), id);
      return { id, name: f.name, md5Checksum: hash(f.content || ''), modifiedTime: f.modifiedTime, appProperties: f.appProperties, ownedByMe: f.owner === me.email };
    },
    async readText(id) { await wait(); return get(load(), id).content; },
    async writeText(id, text) { await wait(); const d = load(); const f = get(d, id); f.content = text; f.modifiedTime = new Date().toISOString(); store(d); return { id }; },
    async setAppProps(id, props) {
      await wait(); const d = load(); const f = get(d, id);
      for (const [k, v] of Object.entries(props)) { if (v === null) delete f.appProperties[k]; else f.appProperties[k] = String(v); }
      store(d); return { appProperties: f.appProperties };
    },
    async copy(id, parentId, name) { await wait(); const d = load(); const src = get(d, id); const f = add(d, { name, parents: [parentId], content: src.content }); store(d); return pub(f); },
    async del(id) { await wait(); const d = load(); const f = get(d, id); if (f.owner !== me.email) { const e = new Error('Mock 403: only the owner can delete'); e.code = 403; throw e; } delete d.files[id]; store(d); return null; },
    async share(id, email) { await wait(); const d = load(); const f = get(d, id); f.shared = [...new Set([...(f.shared || []), email])]; store(d); return {}; },
  };
}
