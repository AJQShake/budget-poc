'use strict';
/* =====================================================================
   cloud.js: Google sign-in, Google Drive storage, check-in / check-out
   (one editor at a time), dated backups and optional passphrase
   encryption for Dúchas.

   The data lives in ONE file (duchas-data.json) inside a Google Drive
   folder (Duchas) that one of you owns and shares with the other.
   Data only travels between your device and Google. Nothing else.

   The rest of Dúchas talks to this file through two calls only:
     Store.load()  -> Cloud.takeDoc()
     Store.save()  -> Cloud.onSave()
   ===================================================================== */
(function () {
  const CFG = Object.assign({
    clientId: '', folderName: 'Duchas', dataFileName: 'duchas-data.json',
    maxBackups: 30, lockMinutes: 5, idleMinutes: 15, autoCheckOut: true,
  }, window.DUCHAS_CONFIG || {});
  const params = new URLSearchParams(location.search);
  const MOCK = params.get('mock');                       // ?mock=alice or ?mock=bob : demo with a fake Drive in this browser
  if (MOCK && params.get('maxBackups')) CFG.maxBackups = +params.get('maxBackups');
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const HEARTBEAT_MS = 60000, POLL_MS = MOCK ? 4000 : 20000, WRITE_DELAY = 1200;
  const NS = MOCK ? '.mock-' + MOCK : '';
  const LS_LOCK = 'duchas.cloud.lock' + NS, LS_UNSAVED = 'duchas.cloud.unsaved' + NS, LS_HINT = 'duchas.cloud.email' + NS, LS_PASS = 'duchas.cloud.pass' + NS;

  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const el = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hhmm = t => new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  const when = t => t ? new Date(t).toLocaleString([], {weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}) : '';
  const newToken = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const say = (m, type = '', ms) => (typeof toast === 'function' ? toast(m, type, ms) : console.log(m));

  /* ---------------- Google Drive REST API v3 ---------------- */
  const API = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FOLDER = 'application/vnd.google-apps.folder';
  const META_FIELDS = 'id,name,md5Checksum,modifiedTime,appProperties,ownedByMe,lastModifyingUser(displayName,emailAddress)';

  function realDrive(getToken) {
    async function call(url, opts = {}, raw = false) {
      const res = await fetch(url, {cache: 'no-store', ...opts, headers: {Authorization: 'Bearer ' + getToken(), ...(opts.headers || {})}});
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const e = new Error(res.status === 401 ? 'Google sign-in expired' : `Google Drive said no (${res.status}): ${body.slice(0, 200)}`);
        e.code = res.status; throw e;
      }
      if (res.status === 204) return null;
      return raw ? res.text() : res.json();
    }
    const json = body => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const qe = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const list = async query => {
      let files = [], pageToken = '';
      do {
        const r = await call(`${API}/files?q=${encodeURIComponent(query)}&orderBy=createdTime desc&pageSize=100` +
          `&fields=nextPageToken,files(id,name,createdTime,ownedByMe,owners(displayName,emailAddress))` + (pageToken ? `&pageToken=${pageToken}` : ''));
        files = files.concat(r.files); pageToken = r.nextPageToken;
      } while (pageToken);
      return files;
    };
    return {
      async me() { const r = await call(`${API}/about?fields=user(displayName,emailAddress)`); return {name: r.user.displayName || r.user.emailAddress, email: r.user.emailAddress}; },
      findFolders: name => list(`name='${qe(name)}' and mimeType='${FOLDER}' and trashed=false`),
      findChild: async (parentId, name, isFolder) => (await list(`'${parentId}' in parents and name='${qe(name)}' and trashed=false and mimeType${isFolder ? '=' : '!='}'${FOLDER}'`))[0] || null,
      listChildren: parentId => list(`'${parentId}' in parents and trashed=false`), // newest first
      createFolder: (name, parentId) => call(`${API}/files?fields=id,name,ownedByMe`, json({name, mimeType: FOLDER, ...(parentId ? {parents: [parentId]} : {})})),
      async createFile(parentId, name, text) {
        const b = 'duchas' + Math.random().toString(36).slice(2);
        const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` + JSON.stringify({name, parents: [parentId], mimeType: 'application/json'}) +
          `\r\n--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${b}--`;
        return call(`${UPLOAD}/files?uploadType=multipart&fields=id,name`, {method: 'POST', headers: {'Content-Type': `multipart/related; boundary=${b}`}, body});
      },
      getMeta: id => call(`${API}/files/${id}?fields=${META_FIELDS}`),
      readText: id => call(`${API}/files/${id}?alt=media`, {}, true),
      writeText: (id, text) => call(`${UPLOAD}/files/${id}?uploadType=media&fields=id,md5Checksum`, {method: 'PATCH', headers: {'Content-Type': 'application/json; charset=UTF-8'}, body: text}),
      // appProperties are private to this app. A value of null deletes the key.
      setAppProps: (id, props, keepalive = false) => call(`${API}/files/${id}?fields=appProperties`, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({appProperties: props}), keepalive}),
      copy: (id, parentId, name) => call(`${API}/files/${id}/copy?fields=id,name`, json({name, parents: [parentId]})),
      del: id => call(`${API}/files/${id}`, {method: 'DELETE'}),
      share: (id, email) => call(`${API}/files/${id}/permissions?sendNotificationEmail=true`, json({type: 'user', role: 'writer', emailAddress: email})),
    };
  }

  /* ---------------- Demo Drive (only with ?mock=alice / ?mock=bob) ---------------- */
  function mockDrive(who) {
    const USERS = {alice: {name: 'Alice (demo)', email: 'alice@example.com'}, bob: {name: 'Bob (demo)', email: 'bob@example.com'}};
    const me = USERS[who] || USERS.alice, KEY = 'duchas-mockdrive';
    const load = () => JSON.parse(localStorage.getItem(KEY) || '{"files":{}}');
    const store = d => localStorage.setItem(KEY, JSON.stringify(d));
    const wait = () => new Promise(r => setTimeout(r, 60));
    const hash = s => { let x = 5381; for (let i = 0; i < s.length; i++) x = (x * 33 ^ s.charCodeAt(i)) >>> 0; return x.toString(16) + ':' + s.length; };
    const uid = () => Math.random().toString(36).slice(2, 12);
    const visible = (d, f) => f.owner === me.email || (f.shared || []).includes(me.email) || (f.parents || []).some(p => d.files[p] && visible(d, d.files[p]));
    const pub = f => ({id: f.id, name: f.name, createdTime: f.createdTime, ownedByMe: f.owner === me.email, owners: [{emailAddress: f.owner, displayName: f.owner}]});
    const get = (d, id) => { const f = d.files[id]; if (!f || !visible(d, f)) { const e = new Error('Demo 404'); e.code = 404; throw e; } return f; };
    let seq = 0;
    const add = (d, f) => { const id = uid(); d.files[id] = {id, createdTime: new Date().toISOString().slice(0, 23) + String(seq++).padStart(4, '0') + 'Z', owner: me.email, appProperties: {}, ...f}; return d.files[id]; };
    const newest = (a, b) => (a.createdTime < b.createdTime ? 1 : -1);
    return {
      async me() { await wait(); return me; },
      async findFolders(name) { await wait(); const d = load(); return Object.values(d.files).filter(f => f.folder && f.name === name && visible(d, f)).sort(newest).map(pub); },
      async findChild(pid, name, isFolder) { await wait(); const d = load(); const f = Object.values(d.files).sort(newest).find(f => f.parents?.includes(pid) && f.name === name && !!f.folder === !!isFolder); return f ? pub(f) : null; },
      async listChildren(pid) { await wait(); const d = load(); return Object.values(d.files).filter(f => f.parents?.includes(pid)).sort(newest).map(pub); },
      async createFolder(name, pid) { await wait(); const d = load(); const f = add(d, {name, folder: true, parents: pid ? [pid] : []}); store(d); return pub(f); },
      async createFile(pid, name, text) { await wait(); const d = load(); const f = add(d, {name, parents: [pid], content: text}); store(d); return pub(f); },
      async getMeta(id) { await wait(); const f = get(load(), id); return {id, name: f.name, md5Checksum: hash(f.content || ''), modifiedTime: f.modifiedTime, appProperties: f.appProperties, ownedByMe: f.owner === me.email, lastModifyingUser: {displayName: f.modifiedBy}}; },
      async readText(id) { await wait(); return get(load(), id).content; },
      async writeText(id, text) { await wait(); const d = load(); const f = get(d, id); f.content = text; f.modifiedTime = new Date().toISOString(); f.modifiedBy = me.name; store(d); return {id, md5Checksum: hash(text)}; },
      async setAppProps(id, props) { await wait(); const d = load(); const f = get(d, id); for (const [k, v] of Object.entries(props)) { if (v === null) delete f.appProperties[k]; else f.appProperties[k] = String(v); } store(d); return {appProperties: f.appProperties}; },
      async copy(id, pid, name) { await wait(); const d = load(); const src = get(d, id); const f = add(d, {name, parents: [pid], content: src.content}); store(d); return pub(f); },
      async del(id) { await wait(); const d = load(); const f = get(d, id); if (f.owner !== me.email) { const e = new Error('Demo 403'); e.code = 403; throw e; } delete d.files[id]; store(d); return null; },
      async share(id, email) { await wait(); const d = load(); const f = get(d, id); f.shared = [...new Set([...(f.shared || []), email])]; store(d); return {}; },
    };
  }

  /* ---------------- Optional passphrase encryption (AES-256-GCM, PBKDF2-SHA256) ---------------- */
  const ITER = 310000, te = new TextEncoder(), td = new TextDecoder();
  const b64 = buf => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function aesKey(pass, salt, iterations = ITER) {
    const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations, hash: 'SHA-256'}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  }
  const isEncrypted = text => { try { const o = JSON.parse(text); return o.duchasEncrypted === 1 || o.pocEncrypted === 1; } catch { return false; } };
  async function encryptText(plain, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await aesKey(pass, salt), te.encode(plain));
    return JSON.stringify({duchasEncrypted: 1, kdf: 'PBKDF2-SHA256', iterations: ITER, salt: b64(salt), iv: b64(iv), data: b64(ct)});
  }
  async function decryptText(text, pass) {
    const o = JSON.parse(text);
    try { return td.decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(o.iv)}, await aesKey(pass, unb64(o.salt), o.iterations || ITER), unb64(o.data))); }
    catch { const e = new Error('Wrong passphrase'); e.needPass = true; e.wrong = true; throw e; }
  }

  /* ---------------- State ---------------- */
  const C = {
    token: null, tokenClient: null, me: null, drive: null, expired: false, renewDue: false,
    folder: null, dataId: null, backupsId: null,
    lock: null, lockToken: null, editing: false, busy: false,
    loadedMd5: null, base: null, lastModified: null, lastBy: null,
    passphrase: null, encrypted: false,
    dirty: 0, writing: null, again: false, writeTimer: null, lastSaved: null,
    lastActivity: Date.now(), started: false, initFn: null, doc: null, timers: [],
  };

  /* ---------------- Lock: stored as private appProperties on the data file ----------------
     lockToken = random id of the device that checked out; lockEmail / lockName = who;
     lockUntil = time after which the check-out is stale and anyone may take it. */
  const lockOf = meta => { const p = meta?.appProperties || {}; return p.lockToken ? {token: p.lockToken, email: p.lockEmail, name: p.lockName, until: +p.lockUntil} : null; };
  const isLive = l => !!l && l.until > Date.now();
  const mine = l => !!l && !!C.lockToken && l.token === C.lockToken;
  const heldByOther = () => isLive(C.lock) && !mine(C.lock);
  const sameMe = l => !!l && C.me && l.email === C.me.email;
  const who = l => sameMe(l) ? 'You (on another device)' : (l?.name || 'Someone');
  const lockProps = token => ({lockToken: token, lockEmail: C.me.email, lockName: String((typeof ME !== 'undefined' && ME?.name) || C.me.name).slice(0, 40), lockUntil: String(Date.now() + CFG.lockMinutes * 60000)});
  const NO_LOCK = {lockToken: null, lockEmail: null, lockName: null, lockUntil: null};

  /* ---------------- Screens shown before the app opens ---------------- */
  function screen(inner) {
    try { document.documentElement.dataset.theme = localStorage.getItem('duchas.theme') || 'oiche'; } catch {}
    el('app').hidden = true; const L = el('login'); L.hidden = false;
    L.innerHTML = `<div class="login-box"><div class="logo">🌳</div><h1>Dúchas</h1>${inner}<p id="cl-msg" class="small t-bad" style="margin-top:14px"></p></div>`;
  }
  const msg = (m, ok) => { const e = el('cl-msg'); if (e) { e.innerHTML = m; e.className = 'small ' + (ok ? 'muted' : 't-bad'); } };
  const bigBtn = (label, act, primary = true, id = '') => `<button class="btn ${primary ? 'primary' : ''}" ${id ? `id="${id}"` : ''} style="font-size:16px;padding:12px 22px;margin:6px" onclick="${act}">${label}</button>`;

  function signInScreen() {
    const hr = new Date().getHours();
    screen(`<div class="muted">${hr < 12 ? 'Maidin mhaith' : hr < 18 ? 'Dia duit' : 'Tráthnóna maith'}! Fáilte abhaile · Welcome home</div>
      <div style="margin:30px 0 8px">${bigBtn(MOCK ? `Sign in as ${h(MOCK)} (demo)` : '<b style="font-family:Arial;margin-right:6px">G</b> Sign in with Google', 'Cloud.signIn()', true, 'cl-signin')}</div>
      <p class="tiny muted" style="margin-top:22px">Your plan is kept in your own Google Drive, in the shared “${h(CFG.folderName)}” folder.${MOCK ? '<br><b>Demo mode:</b> using a pretend Drive inside this browser.' : ''}</p>`);
  }
  function busyScreen(text) { screen(`<p class="muted" style="margin-top:30px">⏳ ${text}</p>`); }

  /* ---------------- Sign-in ---------------- */
  function boot(initFn) {
    C.initFn = initFn;
    if ('serviceWorker' in navigator && !MOCK && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    if (MOCK) { C.drive = mockDrive(MOCK); return signInScreen(); }
    if (!CFG.clientId) return screen('<p class="t-bad">The Google Client ID is missing from config.js.</p>');
    busyScreen('Getting Google sign-in ready…');
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => {
      C.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CFG.clientId, scope: SCOPE,
        callback: r => (r.error ? msg('Sign-in did not finish: ' + h(r.error)) : guard(() => afterToken(r.access_token, r.expires_in))),
        error_callback: e => msg('The Google sign-in window was closed or blocked' + (e?.type ? ` (${h(e.type)})` : '') + '. Please try again.'),
      });
      signInScreen();
    };
    s.onerror = () => screen(`<p class="muted" style="margin-top:20px">Could not reach Google. Check your internet connection.</p>${bigBtn('Try again', 'location.reload()')}`);
    document.head.appendChild(s);
  }

  function signIn() {
    if (MOCK) return guard(() => afterToken('mock', 3600));
    if (!C.tokenClient) return;
    let hint = ''; try { hint = C.me?.email || localStorage.getItem(LS_HINT) || ''; } catch {}
    C.tokenClient.requestAccessToken(hint ? {prompt: '', login_hint: hint} : {});
  }

  async function afterToken(token, expiresIn = 3600) {
    C.token = token; C.expired = false; C.renewDue = false;
    clearTimeout(C.renewTimer); clearTimeout(C.expireTimer);
    // Browser sign-in lasts one hour. Ask for a tap a few minutes before it runs out.
    if (!MOCK) {
      C.renewTimer = setTimeout(() => { C.renewDue = true; chrome(); say('⏰ Your Google sign-in runs out in a few minutes. Tap <b>Stay signed in</b> at the top.', 'warn', 8000); }, Math.max(60, expiresIn - 300) * 1000);
      C.expireTimer = setTimeout(() => { C.expired = true; chrome(); }, Math.max(60, expiresIn - 20) * 1000);
      C.drive = C.drive || realDrive(() => C.token);
    }
    const renewal = !!C.me && C.started;
    C.me = await C.drive.me();
    try { localStorage.setItem(LS_HINT, C.me.email); } catch {}
    if (renewal) {
      chrome(); say('✅ Still signed in to Google', 'good', 2000);
      if (C.editing) { await heartbeat(); if (C.dirty) await writeNow(); } else await poll();
      return;
    }
    await openFolder();
  }

  function signOut() {
    return guard(async () => {
      if (C.editing) await checkIn({quiet: true});
      if (C.dirty && !confirm('Some changes have not reached Google Drive yet. Sign out anyway? (They stay on this device and are added next time you check out.)')) return;
      stopTimers();
      if (!MOCK && C.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(C.token, () => {});
      try { localStorage.removeItem(LS_PASS); localStorage.removeItem('duchas.session'); } catch {}
      C.token = null; location.reload();
    });
  }

  /* ---------------- Find the shared folder and data file ---------------- */
  async function openFolder() {
    busyScreen(`Looking for your “${h(CFG.folderName)}” folder in Google Drive…`);
    const folders = await C.drive.findFolders(CFG.folderName);
    let folder = null, data = null;
    for (const f of folders) { const d = await C.drive.findChild(f.id, CFG.dataFileName, false); if (d) { folder = f; data = d; break; } }
    folder = folder || folders.find(f => f.ownedByMe) || folders[0] || null;
    if (!folder) return noFolderScreen();
    C.folder = folder;
    let backups = await C.drive.findChild(folder.id, 'backups', true);
    if (!backups) backups = await C.drive.createFolder('backups', folder.id);
    C.backupsId = backups.id;
    if (!data) return seedScreen();
    C.dataId = data.id;
    await openData();
  }

  function noFolderScreen() {
    screen(`<p style="margin-top:22px">Signed in as <b>${h(C.me.email)}</b>.</p>
      <p class="small muted">There is no “${h(CFG.folderName)}” folder in this Google Drive yet.</p>
      <div class="card" style="text-align:left;margin:18px auto;max-width:460px"><p class="small" style="margin-top:0"><b>Setting up for the first time?</b> Create the folder in your Drive. You can share it with your partner afterwards.</p>${bigBtn('Create the Duchas folder', 'Cloud._createFolder()', true, 'cl-create')}
      <p class="small"><b>Your partner already set it up?</b> Ask them to share it with <b>${h(C.me.email)}</b> (Dúchas → Settings → Share), then tap Try again.</p>${bigBtn('Try again', 'Cloud._retry()', false)}</div>
      ${bigBtn('Use a different Google account', 'Cloud.signOut()', false)}`);
  }
  async function createFolder() {
    el('cl-create').disabled = true;
    const f = await C.drive.createFolder(CFG.folderName);
    C.folder = {...f, ownedByMe: true};
    C.backupsId = (await C.drive.createFolder('backups', f.id)).id;
    seedScreen();
  }

  function seedScreen() {
    screen(`<p style="margin-top:22px">Your “${h(CFG.folderName)}” folder is ready. Now add your plan to it.</p>
      <div class="card" style="text-align:left;margin:18px auto;max-width:460px">
        <p class="small" style="margin-top:0"><b>Bring in your existing data.</b> Choose the Dúchas file you saved before (for example <i>duchas-2026-11-20.json</i>). Everything in it moves to Google Drive.</p>
        ${bigBtn('📂 Choose my Dúchas file', "document.getElementById('cl-seed').click()", true)}
        <input type="file" id="cl-seed" accept=".json,.txt,application/json,text/plain" hidden onchange="Cloud._seedFile(this.files[0])">
        <p class="small" style="margin-top:18px">Or start again from the original roadmap goals.</p>
        ${bigBtn('Start fresh', 'Cloud._seedFresh()', false)}
      </div>`);
  }
  async function seedFile(file) {
    if (!file) return;
    let doc; try { doc = JSON.parse(await file.text()); } catch { return msg('That file could not be read as Dúchas data (it is not valid JSON).'); }
    if (!doc || doc.app !== 'duchas') return msg("That doesn't look like a Dúchas data file.");
    const n = k => (doc[k] || []).filter(x => !x.deleted).length;
    if (!confirm(`Copy this into Google Drive?\n\n${n('people')} people, ${n('accounts')} accounts, ${n('recurring')} bills, ${n('txns')} transactions, ${n('goals')} goals.`)) return;
    await createData(normalise(doc));
  }
  async function seedFresh() {
    if (!confirm('Start with a fresh plan (the original roadmap goals, no bills or transactions)?')) return;
    const d = defaultDoc(); const sd = convertRoadmap(ROADMAP_SEED);
    d.goals.push(...sd.goals); d.metrics.push(...sd.metrics); d.settings.motto = sd.motto;
    d.activity.push({id: uid('act'), at: nowISO(), by: '', icon: '🌱', text: 'set up with goals from your roadmap. Fáilte!', updatedAt: nowISO()});
    await createData(d);
  }
  async function createData(doc) {
    busyScreen('Saving your plan to Google Drive…');
    const existing = await C.drive.findChild(C.folder.id, CFG.dataFileName, false);
    if (existing) { say('Your partner had already added data, so that is being used.', 'warn', 6000); C.dataId = existing.id; return openData(); }
    const f = await C.drive.createFile(C.folder.id, CFG.dataFileName, JSON.stringify(doc, null, 1));
    C.dataId = f.id;
    await openData();
    say(`☁️ Your plan is now in Google Drive (folder <b>${h(CFG.folderName)}</b>). Share it with your partner from Settings.`, 'good', 8000);
  }

  /* ---------------- Reading ---------------- */
  async function loadRemote() {
    const meta = await C.drive.getMeta(C.dataId);           // meta first: if the file changes meanwhile we notice at save time
    const raw = await C.drive.readText(C.dataId);
    let text = raw;
    if (isEncrypted(raw)) {
      C.encrypted = true;
      if (!C.passphrase) { try { C.passphrase = localStorage.getItem(LS_PASS); } catch {} }
      if (!C.passphrase) { const e = new Error('Passphrase needed'); e.needPass = true; throw e; }
      try { text = await decryptText(raw, C.passphrase); }
      catch (e) { C.passphrase = null; try { localStorage.removeItem(LS_PASS); } catch {} throw e; }
    } else { C.encrypted = false; C.passphrase = null; }
    const doc = JSON.parse(text);
    if (!doc || doc.app !== 'duchas') throw new Error(`The file ${CFG.dataFileName} in Google Drive is not Dúchas data.`);
    C.loadedMd5 = meta.md5Checksum; C.lock = lockOf(meta); C.base = text;
    C.lastModified = meta.modifiedTime; C.lastBy = meta.lastModifyingUser?.displayName || '';
    return normalise(doc);
  }

  async function openData() {
    busyScreen('Opening your plan…');
    let doc;
    try { doc = await loadRemote(); }
    catch (e) { if (e.needPass) return passScreen(e.wrong); throw e; }
    start(doc);
  }

  function passScreen(wrong) {
    screen(`<p style="margin-top:22px">🔐 Your plan is protected with a passphrase.</p>
      <div class="pin-row"><input type="password" id="cl-pass" placeholder="Passphrase" autocomplete="current-password" style="letter-spacing:normal;font-size:17px;max-width:260px" onkeydown="if(event.key==='Enter')Cloud._unlock()"><button class="btn primary" onclick="Cloud._unlock()">Unlock</button></div>
      <label class="small muted" style="display:block;margin-top:12px"><input type="checkbox" id="cl-remember"> Remember on this device</label>`);
    if (wrong) msg('That passphrase did not work. Try again.');
    el('cl-pass').focus();
  }
  async function unlock() {
    const v = el('cl-pass').value; if (!v) return;
    C.passphrase = v;
    if (el('cl-remember').checked) { try { localStorage.setItem(LS_PASS, v); } catch {} }
    if (!C.started) return openData();
    // already running (e.g. partner changed the passphrase): reload in place
    closeModal(); await poll(true);
  }

  /* ---------------- Start the normal Dúchas app ---------------- */
  function start(doc) {
    C.doc = doc; C.started = true;
    C.initFn();
    setMode();
    startTimers();
    const un = readUnsaved();
    let stored = null; try { stored = localStorage.getItem(LS_LOCK); } catch {}
    if (stored && C.lock?.token === stored) {                        // this device was checked out when the app last closed
      C.lockToken = stored;
      if (!un) guard(async () => { await C.drive.setAppProps(C.dataId, NO_LOCK); C.lock = null; C.lockToken = null; setLockMemo(null); setMode(); chrome(); });
    }
    if (un) {
      say('💾 Some changes from last time had not reached Google Drive yet. Adding them now…', 'warn', 6000);
      if (!heldByOther()) checkOut({recover: true});
      else say(`${h(who(C.lock))} is editing at the moment. Your earlier changes are kept on this device and will be added when you next check out.`, 'warn', 8000);
    } else if (heldByOther()) say(`👀 ${h(who(C.lock))} ${sameMe(C.lock) ? 'are' : 'is'} editing right now, so you are in read-only mode.`, '', 5000);
  }
  function takeDoc() { const d = C.doc; C.doc = null; return d; }

  /* ---------------- The app calls this every time something changes ---------------- */
  function onSave() {
    if (!C.started) return;
    if (C.editing) { markDirty(); scheduleWrite(); chrome(); return; }
    if (C.busy) { C.dirty++; return; }                              // a check-out is under way; this change rides along with it
    if (heldByOther()) {
      revert();
      return say(`🔒 <b>${h(who(C.lock))}</b> ${sameMe(C.lock) ? 'are' : 'is'} editing right now, so that change was not saved. You can look around, and edit once they check in.`, 'warn', 7000);
    }
    if (!CFG.autoCheckOut) { revert(); return say('👀 Read-only. Tap <b>Check out</b> at the top to make changes.', 'warn', 5000); }
    C.dirty++;
    checkOut({keepLocal: true});
  }

  function revert() {
    if (!C.base) return;
    S = normalise(JSON.parse(C.base)); refreshApp(false);
  }
  function refreshApp(draw = true) {
    VER++; MEMO.clear();
    if (ME) { ME = P(ME.id) || ME; if (draw) render(); }
  }
  function markDirty() {
    C.dirty++;
    try { localStorage.setItem(LS_UNSAVED, JSON.stringify(S)); } catch {}
  }
  function readUnsaved() { try { const t = localStorage.getItem(LS_UNSAVED); return t ? JSON.parse(t) : null; } catch { return null; } }
  function setLockMemo(t) { try { if (t) localStorage.setItem(LS_LOCK, t); else localStorage.removeItem(LS_LOCK); } catch {} }
  function clearUnsaved() { try { localStorage.removeItem(LS_UNSAVED); } catch {} }

  /* ---------------- Check out (start editing) ---------------- */
  async function checkOut(opts = {}) {
    if (C.editing || C.busy || !C.dataId) return false;
    C.busy = true; chrome();
    let ok = false;
    try {
      const meta = await C.drive.getMeta(C.dataId);
      C.lock = lockOf(meta);
      if (isLive(C.lock) && !mine(C.lock) && !(opts.force && sameMe(C.lock))) {
        const lost = C.dirty; if (lost) { C.dirty = 0; revert(); }
        say(`🔒 <b>${h(who(C.lock))}</b> ${sameMe(C.lock) ? 'are' : 'is'} editing right now${lost ? ', so that change was not saved' : ''}. Try again when they check in (or after ${hhmm(C.lock.until)} if they forget).`, 'warn', 7000);
        return false;
      }
      if (meta.md5Checksum !== C.loadedMd5) {                     // get the latest version first
        const remote = await loadRemote();
        S = C.dirty ? mergeDocs(remote, S).doc : remote;          // keep any change just made; newest version of each item wins
      }
      const token = newToken();
      await C.drive.setAppProps(C.dataId, lockProps(token));
      await sleep(MOCK ? 300 : 1500);                              // if two people tap at the same moment, the last write wins
      const check = await C.drive.getMeta(C.dataId);
      C.lock = lockOf(check);
      if (C.lock?.token !== token) {
        if (C.dirty) { C.dirty = 0; revert(); }
        say(`🔒 ${h(who(C.lock))} started editing at the same moment, so you are read-only for now.`, 'warn', 6000);
        return false;
      }
      C.lockToken = token; C.editing = true; C.lastActivity = Date.now(); setLockMemo(token);
      ok = true;
      await sessionBackup();
      const un = readUnsaved();
      if (un && un.app === 'duchas') {
        const m = mergeDocs(S, normalise(un));
        if (m.added || m.updated) { S = m.doc; C.dirty++; say(`💾 Added ${m.added + m.updated} change(s) that had not been saved before.`, 'good', 5000); }
      }
      if (C.dirty) { markDirty(); scheduleWrite(0); } else clearUnsaved();
      if (!opts.keepLocal && !opts.recover) say('✏️ <b>Checked out.</b> You are editing. Everyone else is read-only until you check in.', 'good', 5000);
      else if (opts.keepLocal) say('✏️ Checked out for editing. Tap <b>Check in</b> at the top when you are finished.', 'good', 4500);
    } catch (e) { if (C.dirty && !ok) { C.dirty = 0; revert(); } handleErr(e); }
    finally { C.busy = false; setMode(); refreshApp(); }
    return ok;
  }

  async function sessionBackup(label = '') {
    try {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      const name = `duchas-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${label}.json`;
      await C.drive.copy(C.dataId, C.backupsId, name);
      prune().catch(e => console.warn(e));
    } catch (e) { console.warn(e); say('⚠️ Could not make a backup copy in Drive this time: ' + h(e.message), 'warn', 6000); }
  }
  async function prune() {
    const files = await C.drive.listChildren(C.backupsId);           // newest first
    for (const f of files.slice(CFG.maxBackups)) {
      if (!f.ownedByMe) continue;                                    // in a shared folder only the creator can delete; the other device tidies its own
      try { await C.drive.del(f.id); } catch {}
    }
  }

  /* ---------------- Saving while checked out ---------------- */
  function scheduleWrite(ms = WRITE_DELAY) { clearTimeout(C.writeTimer); C.writeTimer = setTimeout(() => writeNow(), ms); }
  function writeNow() {
    clearTimeout(C.writeTimer);
    if (!C.editing) return Promise.resolve();
    if (C.writing) { C.again = true; return C.writing; }
    chrome();
    C.writing = (async () => {
      const d0 = C.dirty;
      const meta = await C.drive.getMeta(C.dataId);
      if (lockOf(meta)?.token !== C.lockToken) return lostLock(meta);
      if (meta.md5Checksum !== C.loadedMd5) {                         // should not happen while checked out, but never overwrite blindly
        const local = S, remote = await loadRemote();
        S = mergeDocs(remote, local).doc; refreshApp();
      }
      const text = JSON.stringify(S, null, 1);
      const out = C.encrypted && C.passphrase ? await encryptText(text, C.passphrase) : text;
      const r = await C.drive.writeText(C.dataId, out);
      C.loadedMd5 = r?.md5Checksum || (await C.drive.getMeta(C.dataId)).md5Checksum;
      C.base = text; C.lastSaved = Date.now(); C.lastModified = new Date().toISOString(); C.lastBy = C.me.name;
      if (C.dirty === d0) { C.dirty = 0; clearUnsaved(); }
      await C.drive.setAppProps(C.dataId, {lockUntil: lockProps(C.lockToken).lockUntil});
    })().catch(handleErr).finally(() => {
      C.writing = null; chrome();
      if (C.again) { C.again = false; if (C.dirty && C.editing) scheduleWrite(0); }
    });
    return C.writing;
  }

  /* ---------------- Check in (save and let the other person edit) ---------------- */
  async function checkIn(opts = {}) {
    if (!C.editing || C.busy) return;
    C.busy = true; chrome();
    try {
      for (let i = 0; i < 4 && (C.dirty || C.writing) && C.editing; i++) { if (C.writing) await C.writing; else await writeNow(); }
      if (!C.editing) return;                                        // lost the lock while saving (already explained)
      if (C.dirty) throw new Error('Your last changes could not be saved to Google Drive yet, so you are still checked out. Please try again.');
      const meta = await C.drive.getMeta(C.dataId);
      if (lockOf(meta)?.token === C.lockToken) await C.drive.setAppProps(C.dataId, NO_LOCK);
      C.lockToken = null; C.editing = false; C.lock = null; setLockMemo(null);
      if (!opts.quiet) say(opts.auto ? `✅ No taps for ${CFG.idleMinutes} minutes, so you were checked in automatically. Everything is saved.` : '✅ <b>Checked in.</b> Saved to Google Drive. The other person can edit now.', 'good', 6000);
    } catch (e) { handleErr(e); }
    finally { C.busy = false; setMode(); chrome(); }
  }

  function lostLock(meta) {
    C.editing = false; C.lockToken = null; C.lock = lockOf(meta); setLockMemo(null);
    const had = C.dirty; C.dirty = 0;
    say(`⚠️ You are no longer checked out (it timed out${C.lock ? ` and ${h(who(C.lock))} is editing now` : ''}).${had ? ' Your unsaved changes are kept on this device and will be added next time you check out.' : ''}`, 'warn', 9000);
    setMode();
    poll(true).catch(handleErr);
  }

  /* ---------------- Timers ---------------- */
  async function heartbeat() {
    if (!C.editing || C.busy || C.expired) return;
    const meta = await C.drive.getMeta(C.dataId);
    if (lockOf(meta)?.token !== C.lockToken) return lostLock(meta);
    if (Date.now() - C.lastActivity > CFG.idleMinutes * 60000 && !el('modal-root')?.innerHTML) return checkIn({auto: true});
    await C.drive.setAppProps(C.dataId, {lockUntil: lockProps(C.lockToken).lockUntil});
  }
  async function poll(force = false) {
    if (C.editing || C.busy || !C.dataId || (C.expired && !MOCK) || (!force && document.hidden)) return;
    const meta = await C.drive.getMeta(C.dataId);
    const before = JSON.stringify(C.lock); C.lock = lockOf(meta);
    if (meta.md5Checksum !== C.loadedMd5 || force) {
      let doc;
      try { doc = await loadRemote(); }
      catch (e) { if (e.needPass) return passModal(); throw e; }
      if (C.editing) return;
      const changed = C.base !== JSON.stringify(S, null, 1);
      S = doc; refreshApp();
      if (changed && !force) say(`🔄 Updated with the latest changes${C.lastBy && C.lastBy !== C.me.name ? ' from ' + h(C.lastBy) : ''}.`, '', 3000);
    }
    if (JSON.stringify(C.lock) !== before) { setMode(); chrome(); }
  }
  function startTimers() {
    stopTimers();
    C.timers.push(setInterval(() => guard(heartbeat), HEARTBEAT_MS));
    C.timers.push(setInterval(() => guard(() => poll()), POLL_MS));
    C.timers.push(setInterval(() => { if (!C.editing) { setMode(); chrome(); } }, 30000)); // a stale check-out turns into "free" on screen
  }
  function stopTimers() { C.timers.forEach(clearInterval); C.timers = []; }

  ['pointerdown', 'keydown', 'input'].forEach(ev => document.addEventListener(ev, () => { C.lastActivity = Date.now(); }, {passive: true, capture: true}));
  document.addEventListener('visibilitychange', () => {
    if (!C.started) return;
    if (document.hidden) { if (C.editing && C.dirty) writeNow(); return; }
    guard(C.editing ? heartbeat : () => poll());
  });
  window.addEventListener('pagehide', () => {   // closing the app: let the other person edit straight away
    if (!C.editing || !C.dataId) return;
    if (MOCK) C.drive.setAppProps(C.dataId, NO_LOCK);
    else if (C.token) realDrive(() => C.token).setAppProps(C.dataId, NO_LOCK, true).catch(() => {});
  });

  /* ---------------- Errors ---------------- */
  async function guard(fn) { try { return await fn(); } catch (e) { handleErr(e); } }
  function handleErr(e) {
    console.error(e);
    if (e?.code === 401) { C.expired = true; chrome(); if (!C.started) { signInScreen(); msg('Please sign in again.'); } else say('🔑 Your Google sign-in has run out. Tap <b>Sign in again</b> at the top. Nothing is lost.', 'warn', 8000); return; }
    if (e?.needPass) return C.started ? passModal(e.wrong) : passScreen(e.wrong);
    const offline = e instanceof TypeError || !navigator.onLine;
    const text = offline ? 'Could not reach Google Drive. Are you offline? It will try again shortly.' : (e?.message || String(e));
    if (!C.started) { msg(h(text)); return; }
    say('⚠️ ' + h(text), 'bad', 7000);
    if (C.editing && C.dirty) scheduleWrite(15000);
  }

  /* ---------------- What the app shows ---------------- */
  function setMode() {
    const r = document.documentElement.classList;
    r.toggle('cl-ro', C.started && !C.editing);
    r.toggle('cl-locked', C.started && !C.editing && heldByOther());
  }
  function chrome() { if (C.started && typeof renderChrome === 'function' && ME) renderChrome(); }

  // The button at the top of the screen (and in the side menu).
  function state() {
    if (C.expired) return {cls: 'bad', text: '🔑 Sign in again', title: 'Your Google sign-in has run out. Tap to sign in again.', act: 'Cloud.signIn()'};
    if (C.renewDue) return {cls: 'warn', text: '🔑 Stay signed in', title: 'Google sign-in runs out soon. Tap to renew it.', act: 'Cloud.signIn()'};
    if (C.busy) return {cls: 'warn', text: '⏳ One moment…', title: 'Talking to Google Drive', act: ''};
    if (C.editing) {
      if (C.writing || C.dirty) return {cls: 'warn', text: '⏳ Saving…', title: 'Saving to Google Drive', act: 'Cloud.checkIn()'};
      return {cls: 'good', text: '✅ Check in', title: 'You are editing. Tap to save and let the other person edit.', act: 'Cloud.checkIn()'};
    }
    if (heldByOther()) return {cls: 'warn', text: `🔒 ${h(sameMe(C.lock) ? 'Other device' : C.lock.name)}<span class="hide-mob"> editing</span>`, title: `${who(C.lock)} is editing. You are read-only until ${hhmm(C.lock.until)} at the latest.`, act: 'Cloud.lockInfo()'};
    return {cls: '', text: '✏️ Check out', title: 'Read-only. Tap to start editing (only one person can edit at a time).', act: 'Cloud.checkOut()'};
  }

  function modalNote() {
    if (!C.started || C.editing) return '';
    if (heldByOther()) return `<div class="small t-warn" style="width:100%">🔒 ${h(who(C.lock))} ${sameMe(C.lock) ? 'are' : 'is'} editing, so you can look but not save right now.</div>`;
    if (!CFG.autoCheckOut) return `<div class="small muted" style="width:100%">👀 Read-only. <a href="javascript:Cloud.checkOut()">Check out</a> to save changes.</div>`;
    return '';
  }

  function lockInfo() {
    const l = C.lock; if (!isLive(l)) return checkOut();
    openModal({title: '🔒 Someone is editing', en: 'One person edits at a time',
      body: `<p class="small"><b>${h(who(l))}</b> checked out the plan, so you are in read-only mode. You will see their changes appear here.</p>
        <p class="small muted">If they forget to check in, it frees up automatically by ${hhmm(l.until)} (a few minutes after their phone stops using the app).</p>
        ${sameMe(l) ? '<p class="small">This is your own Google account on another phone, tablet or computer. If you are not using it, you can take over here.</p>' : ''}`,
      foot: `<span class="sp"></span>${sameMe(l) ? '<button class="btn" onclick="closeModal();Cloud.checkOut({force:true})">Take over here</button>' : ''}<button class="btn primary" onclick="closeModal()">OK</button>`});
  }

  function settingsHtml() {
    if (!C.started) return '';
    const f = C.folder || {}, ownerName = f.ownedByMe ? 'you' : (f.owners?.[0]?.displayName || f.owners?.[0]?.emailAddress || 'your partner');
    const st = C.editing ? '<span class="pill st-good">✏️ you are editing</span>' : heldByOther() ? `<span class="pill st-warn">🔒 ${h(who(C.lock))} editing</span>` : '<span class="pill">👀 read-only</span>';
    const btn = C.editing ? '<button class="btn primary" onclick="Cloud.checkIn()">✅ Check in</button>' : heldByOther() ? '<button class="btn" onclick="Cloud.lockInfo()">🔒 Who is editing?</button>' : '<button class="btn primary" onclick="Cloud.checkOut()">✏️ Check out</button>';
    return `<p class="small" style="margin-top:0">☁️ Saved in <b>Google Drive</b>, folder <b>${h(CFG.folderName)}</b> (owned by ${h(ownerName)}). Signed in as <b>${h(C.me?.email)}</b>.</p>
      <p class="small">${st} <span class="muted">Last change: ${C.lastModified ? h(when(C.lastModified)) : '—'}${C.lastBy ? ' by ' + h(C.lastBy) : ''}</span></p>
      <div class="row-flex">${btn}<button class="btn" onclick="Cloud.openBackups()">🗂️ Backups</button><button class="btn" onclick="Cloud.signOut()">Sign out of Google</button></div>
      <p class="tiny muted" style="margin-top:6px">Only one person can edit at a time. Making a change checks you out automatically if nobody else is editing. Check in when you're done (it also happens by itself after ${CFG.idleMinutes} minutes without taps). A dated backup is kept in <b>${h(CFG.folderName)}/backups</b> every time someone checks out (newest ${CFG.maxBackups} kept).</p>
      ${f.ownedByMe ? `<div class="grp-h" style="margin-top:16px">Share with your partner</div>
        <p class="small muted" style="margin-top:0">They need a Google account that is on your app's test-user list.</p>
        <div class="row-flex"><input id="cl-share" type="email" placeholder="partner@gmail.com" class="grow" style="min-width:180px"><button class="btn" onclick="Cloud._share()">Share folder</button></div>` : ''}
      <div class="grp-h" style="margin-top:16px">Passphrase lock (optional)</div>
      ${C.encrypted
        ? `<p class="small" style="margin-top:0">🔐 The file in Drive is encrypted. Without the passphrase nobody (not even Google) can read it.</p><div class="row-flex"><button class="btn sm" onclick="Cloud._encModal(true)">Change passphrase</button><button class="btn sm" onclick="Cloud._encOff()">Turn off</button></div>`
        : `<p class="small muted" style="margin-top:0">Off. Your data is protected by your Google accounts. You can also scramble the file with a passphrase you both know. If you both forget it, the data cannot be recovered.</p><button class="btn sm" onclick="Cloud._encModal(false)">Turn on</button>`}`;
  }
  const reviewNote = () => `<b>Backup check:</b> ${C.started ? `saved to Google Drive automatically, with a dated backup each time someone checks out.${C.lastModified ? ' Last change ' + h(when(C.lastModified)) + '.' : ''}` : 'not connected to Google Drive.'} You can also save your own copy.`;
  const loginNote = () => C.me ? `Signed in to Google as <b>${h(C.me.email)}</b> · plan kept in your shared <b>${h(CFG.folderName)}</b> folder.` : '';

  /* ---------------- Settings actions ---------------- */
  async function share() {
    const email = (el('cl-share')?.value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say("Type your partner's Google email address first.", 'warn');
    await C.drive.share(C.folder.id, email);
    say(`📨 Shared the ${h(CFG.folderName)} folder with <b>${h(email)}</b>. They can now open Dúchas and sign in.`, 'good', 7000);
    el('cl-share').value = '';
  }

  async function openBackups() {
    const files = await C.drive.listChildren(C.backupsId);
    const label = f => { const m = f.name.match(/(\d{4})-(\d\d)-(\d\d)_(\d\d)(\d\d)/); return m ? when(new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : when(f.createdTime); };
    openModal({title: '🗂️ Backups', en: `In Google Drive: ${h(CFG.folderName)}/backups · newest ${CFG.maxBackups} kept`, wide: false,
      body: `<p class="small muted" style="margin-top:0">A copy is saved each time someone checks out, before any change. Restoring puts that version back (and backs up the current one first).${C.editing ? '' : ' <b>Check out first to restore.</b>'}</p>
        ${files.length ? `<div class="list">${files.map(f => `<div class="lrow"><div class="grow"><div class="ttl">${h(label(f))}</div><div class="meta">${h(f.name)}${f.owners?.[0] ? ' · by ' + h(f.ownedByMe ? 'you' : (f.owners[0].displayName || f.owners[0].emailAddress)) : ''}</div></div><button class="btn sm" ${C.editing ? '' : 'disabled'} onclick="Cloud._restore('${h(f.id)}','${h(label(f))}')">Restore</button></div>`).join('')}</div>` : '<p class="small">No backups yet. One is made the first time someone checks out.</p>'}`,
      foot: '<span class="sp"></span><button class="btn" onclick="closeModal()">Close</button>'});
  }
  async function restore(id, label) {
    if (!C.editing) return say('Check out first.', 'warn');
    if (!confirm(`Put the plan back to how it was on ${label}?\n\nThe current version is backed up first, so you can undo this.`)) return;
    let text = await C.drive.readText(id);
    if (isEncrypted(text)) {
      try { text = await decryptText(text, C.passphrase || prompt('That backup is encrypted. Passphrase?') || ''); }
      catch { return say('Wrong passphrase for that backup.', 'bad'); }
    }
    const doc = JSON.parse(text);
    if (doc.app !== 'duchas') return say('That backup is not Dúchas data.', 'bad');
    if (C.dirty) await writeNow();
    await sessionBackup('_before-restore');
    closeModal();
    S = normalise(doc); refreshApp(false);
    logAct('⏪', `restored the backup from ${label}`);
    save();
    say(`⏪ Restored the backup from ${h(label)}.`, 'good', 5000);
  }

  function encModal(change) {
    if (!C.editing) return say('Check out first, then turn this on.', 'warn');
    openModal({title: change ? '🔐 Change passphrase' : '🔐 Passphrase lock', en: 'Scrambles the file in Google Drive',
      body: `<p class="small">Pick a passphrase you will <b>both</b> remember, for example four random words. Each of you types it once on each device.</p>
        <p class="small t-bad"><b>If you both forget it, the data cannot be recovered.</b> Not by Google, not by anyone. Write it down somewhere safe.</p>
        <div class="frow"><div class="fld"><span class="lb">New passphrase</span><input type="password" id="cl-p1" autocomplete="new-password"></div><div class="fld"><span class="lb">Type it again</span><input type="password" id="cl-p2" autocomplete="new-password"></div></div>
        <label class="small muted"><input type="checkbox" id="cl-p3"> Remember on this device</label>
        <p class="tiny muted">Backups made before today stay unencrypted. Delete them from ${h(CFG.folderName)}/backups in Google Drive if that matters to you.</p>`,
      foot: '<span class="sp"></span><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="Cloud._encOn()">Turn on</button>'});
  }
  async function encOn() {
    const a = el('cl-p1').value, b = el('cl-p2').value;
    if (a.length < 8) return say('Use at least 8 characters.', 'warn');
    if (a !== b) return say("The two passphrases don't match.", 'warn');
    const remember = el('cl-p3').checked;
    closeModal();
    C.passphrase = a; C.encrypted = true;
    try { if (remember) localStorage.setItem(LS_PASS, a); else localStorage.removeItem(LS_PASS); } catch {}
    markDirty(); await writeNow();
    say('🔐 Passphrase lock is on. The file in Google Drive is now encrypted.', 'good', 6000);
    render();
  }
  async function encOff() {
    if (!C.editing) return say('Check out first.', 'warn');
    if (!confirm('Turn off the passphrase lock? The file in Google Drive goes back to normal (readable by your Google accounts).')) return;
    C.encrypted = false; C.passphrase = null;
    try { localStorage.removeItem(LS_PASS); } catch {}
    markDirty(); await writeNow();
    say('Passphrase lock turned off.', 'good'); render();
  }
  function passModal(wrong) {
    openModal({title: '🔐 Passphrase needed', en: 'The plan in Google Drive is encrypted',
      body: `<p class="small">${wrong ? 'That passphrase did not work. ' : ''}Type the passphrase to see the latest version.</p><div class="fld"><input type="password" id="cl-pass" onkeydown="if(event.key==='Enter')Cloud._unlock()"></div><label class="small muted"><input type="checkbox" id="cl-remember"> Remember on this device</label>`,
      foot: '<span class="sp"></span><button class="btn primary" onclick="Cloud._unlock()">Unlock</button>'});
  }

  window.Cloud = {
    boot, signIn, signOut, takeDoc, onSave, state, modalNote, settingsHtml, reviewNote, loginNote, lockInfo, openBackups,
    checkOut: o => guard(() => checkOut(o)), checkIn: o => guard(() => checkIn(o)),
    editing: () => C.editing, started: () => C.started,
    _createFolder: () => guard(createFolder), _retry: () => guard(openFolder), _seedFile: f => guard(() => seedFile(f)), _seedFresh: () => guard(seedFresh),
    _unlock: () => guard(unlock), _share: () => guard(share), _restore: (id, l) => guard(() => restore(id, l)),
    _encModal: encModal, _encOn: () => guard(encOn), _encOff: () => guard(encOff),
    _test: {C, CFG, heartbeat, poll, writeNow},                       // used by automated tests only
  };
})();
