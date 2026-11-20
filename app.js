// app.js — proves the architecture:
//   Google sign-in -> one JSON file in a shared Drive folder -> one editor at a time
//   (lock stored on the file) -> dated backup on every save, keep the newest N.
import { realDrive, mockDrive } from './drive.js';
import { isEncrypted, encryptText, decryptText } from './crypto.js';

const params = new URLSearchParams(location.search);
const MOCK = params.get('mock');                       // ?mock=alice or ?mock=bob
const CFG = {
  clientId: '', folderName: 'HouseholdBudgetPOC', dataFileName: 'data.json',
  maxBackups: 30, lockMinutes: 5, idleMinutes: 10,
  ...(window.POC_CONFIG || {}),
};
if (params.get('maxBackups')) CFG.maxBackups = Number(params.get('maxBackups')); // handy for testing pruning
const SCOPE = 'https://www.googleapis.com/auth/drive';
const HEARTBEAT_MS = 60_000;   // lock holder refreshes the lock this often
const POLL_MS = 20_000;        // read-only viewer checks for changes this often

const $ = id => document.getElementById(id);
const show = (el, on = true) => $(el).classList.toggle('hidden', !on);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const time = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const S = {
  token: null, tokenClient: null, me: null, drive: null,
  folder: null, dataId: null, backupsId: null,
  lockToken: null,     // non-null only while THIS tab holds the lock
  loadedMd5: null, rawText: null, passphrase: null,
  lastActivity: Date.now(), heartbeat: null, poll: null,
};

function log(m) { const l = $('log'); l.textContent = `${new Date().toLocaleTimeString()}  ${m}\n` + l.textContent; }
function say(m, isErr = false) { $('msg').textContent = m; $('msg').className = isErr ? 'err' : 'muted'; if (m) log((isErr ? 'ERROR ' : '') + m); }
async function guard(fn) {
  try { await fn(); } catch (e) {
    console.error(e);
    if (e.code === 401) { say('Your Google session expired. Tap "Sign in with Google" to continue.', true); S.token = null; showSignIn(); }
    else say(e.message || String(e), true);
  }
}

// ---------------- Sign-in ----------------
function boot() {
  if ('serviceWorker' in navigator && !MOCK) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (MOCK) { show('mockPill'); S.drive = mockDrive(MOCK); showSignIn(); $('signInBtn').textContent = `Sign in as ${MOCK} (demo)`; return; }
  CFG.clientId = CFG.clientId || localStorage.getItem('poc-clientId') || '';
  if (!CFG.clientId) { show('setupCard'); return; }
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => {
    S.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.clientId, scope: SCOPE,
      callback: r => r.error ? say('Sign-in failed: ' + r.error, true) : guard(() => afterToken(r.access_token, r.expires_in)),
      error_callback: e => say('Sign-in window closed or blocked: ' + (e.type || e.message), true),
    });
    showSignIn();
  };
  s.onerror = () => say('Could not load Google sign-in. Check your connection.', true);
  document.head.appendChild(s);
}
function showSignIn() { show('signInCard'); show('setupCard', false); }

$('saveClientIdBtn').onclick = () => {
  const v = $('clientIdInput').value.trim();
  if (!v.endsWith('.apps.googleusercontent.com')) return alert('That does not look like an OAuth Client ID (it ends in .apps.googleusercontent.com).');
  localStorage.setItem('poc-clientId', v); location.reload();
};
$('signInBtn').onclick = () => {
  if (MOCK) return guard(() => afterToken('mock'));
  S.tokenClient.requestAccessToken(S.me ? { prompt: '', login_hint: S.me.email } : {});
};

async function afterToken(token, expiresIn = 3600) {
  S.token = token;
  // Browser-only sign-in gives a 1-hour token and no silent refresh without a tap,
  // so ask for a tap a few minutes before it runs out (the lock is kept meanwhile).
  clearTimeout(S.renewTimer);
  if (!MOCK) S.renewTimer = setTimeout(() => { show('signInCard'); say('Tap "Sign in with Google" to stay signed in (Google sessions last 1 hour).'); }, Math.max(60, expiresIn - 300) * 1000);
  if (!MOCK) S.drive = S.drive || realDrive(() => S.token);
  const wasSignedIn = !!S.me;
  S.me = await S.drive.me();
  $('who').textContent = `${S.me.name}`;
  show('signInCard', false); show('signOutBtn');
  log(`Signed in as ${S.me.email}`);
  if (wasSignedIn && S.dataId) { say(''); return refresh(); }  // token renewal: keep going
  await findFolder();
}

$('signOutBtn').onclick = () => guard(async () => {
  await releaseLock();
  stopTimers();
  if (!MOCK && S.token) google.accounts.oauth2.revoke(S.token, () => {});
  location.reload();
});

// ---------------- Folder + files ----------------
async function findFolder() {
  show('folderCard');
  $('folderMsg').textContent = `Looking for a folder named "${CFG.folderName}" in your Drive or shared with you…`;
  const folders = await S.drive.findFolders(CFG.folderName);
  if (!folders.length) {
    $('folderMsg').textContent = `No "${CFG.folderName}" folder found. If your partner already created one, ask them to share it with you, then reload. Otherwise create it now.`;
    show('createFolderBtn');
    return;
  }
  if (folders.length > 1) log(`Found ${folders.length} folders named ${CFG.folderName}; using the newest.`);
  await openFolder(folders[0]);
}

$('createFolderBtn').onclick = () => guard(async () => {
  $('createFolderBtn').disabled = true;
  const f = await S.drive.createFolder(CFG.folderName);
  log(`Created folder ${CFG.folderName}`);
  await openFolder({ ...f, ownedByMe: true });
});

async function openFolder(folder) {
  S.folder = folder;
  show('folderCard', false);
  const owner = folder.ownedByMe ? 'you' : (folder.owners?.[0]?.displayName || folder.owners?.[0]?.emailAddress || 'someone else');
  log(`Using folder "${folder.name}" (owned by ${owner})`);
  let data = await S.drive.findChild(folder.id, CFG.dataFileName, false);
  if (!data) {
    const starter = JSON.stringify({ title: 'POC test doc', entries: [], createdBy: S.me.email, createdAt: new Date().toISOString() }, null, 2);
    data = await S.drive.createFile(folder.id, CFG.dataFileName, starter);
    log(`Created ${CFG.dataFileName}`);
  }
  let backups = await S.drive.findChild(folder.id, 'backups', true);
  if (!backups) { backups = await S.drive.createFolder('backups', folder.id); log('Created backups folder'); }
  S.dataId = data.id; S.backupsId = backups.id;
  show('shareCard', !!folder.ownedByMe);
  show('mainArea');
  await refresh();
  startTimers();
}

// ---------------- Lock (stored as appProperties on data.json) ----------------
// lockToken  random id of the tab holding the lock
// lockEmail / lockName  who holds it
// lockUntil  ms timestamp; after this the lock is stale and anyone may take it
const lockOf = meta => { const p = meta.appProperties || {}; return p.lockToken ? { token: p.lockToken, email: p.lockEmail, name: p.lockName, until: Number(p.lockUntil) } : null; };
const isLive = l => l && l.until > Date.now();
const lockProps = token => ({ lockToken: token, lockEmail: S.me.email, lockName: S.me.name.slice(0, 40), lockUntil: String(Date.now() + CFG.lockMinutes * 60_000) });
const NO_LOCK = { lockToken: null, lockEmail: null, lockName: null, lockUntil: null };

async function takeLock(force = false) {
  const meta = await S.drive.getMeta(S.dataId);
  const l = lockOf(meta);
  if (isLive(l) && l.token !== S.lockToken && !(force && l.email === S.me.email)) {
    say(`${l.email === S.me.email ? 'You are editing on another device' : l.name + ' is editing'}. Try again later.`, true);
    return render(meta);
  }
  if (meta.md5Checksum !== S.loadedMd5) await loadContent(meta);   // never edit stale content
  const token = crypto.randomUUID();
  await S.drive.setAppProps(S.dataId, lockProps(token));
  await sleep(1500);                                                // both may have written; last write wins
  const check = await S.drive.getMeta(S.dataId);
  if (lockOf(check)?.token !== token) { say('Someone else grabbed the lock at the same moment. You are read-only.', true); return render(check); }
  S.lockToken = token; S.lastActivity = Date.now();
  log('Lock taken. You are the editor.');
  say('');
  render(check);
}

async function releaseLock() {
  if (!S.lockToken || !S.dataId) return;
  const meta = await S.drive.getMeta(S.dataId);
  if (lockOf(meta)?.token === S.lockToken) await S.drive.setAppProps(S.dataId, NO_LOCK);
  S.lockToken = null;
  log('Lock released.');
}

async function heartbeat() {
  if (!S.lockToken) return;
  const meta = await S.drive.getMeta(S.dataId);
  if (lockOf(meta)?.token !== S.lockToken) { S.lockToken = null; say('You lost the edit lock (it timed out or was taken over). Copy any unsaved text before refreshing.', true); return render(meta, false); }
  if (Date.now() - S.lastActivity > CFG.idleMinutes * 60_000) {
    if ($('doc').value !== S.shownText) { log('Idle, but you have unsaved changes, so keeping the lock.'); }
    else { await releaseLock(); say(`No activity for ${CFG.idleMinutes} min, so you stopped editing automatically.`); return refresh(); }
  }
  await S.drive.setAppProps(S.dataId, { lockUntil: lockProps(S.lockToken).lockUntil });
}

// ---------------- Content ----------------
async function loadContent(meta) {
  S.rawText = await S.drive.readText(S.dataId);
  S.loadedMd5 = meta.md5Checksum;
  await showContent();
}
async function showContent() {
  const enc = isEncrypted(S.rawText);
  $('encryptChk').checked = enc || $('encryptChk').checked;
  if (enc && !S.passphrase) { show('unlockBox'); setDoc('(encrypted: enter the passphrase above to view)'); return; }
  const text = enc ? await decryptText(S.rawText, S.passphrase) : S.rawText;
  show('unlockBox', false);
  setDoc(text);
}
function setDoc(t) { $('doc').value = t; S.shownText = t; }

async function refresh(force = false) {
  const meta = await S.drive.getMeta(S.dataId);
  const unsaved = $('doc').value !== S.shownText;   // never wipe text the user typed unless they tap Refresh
  if (meta.md5Checksum !== S.loadedMd5 && (force || !unsaved)) { await loadContent(meta); log('Loaded latest data from Drive.'); }
  render(meta);
}

function render(meta, enableEdit = true) {
  const l = lockOf(meta);
  const mine = S.lockToken && l?.token === S.lockToken;
  const st = $('status');
  if (mine) { st.className = 'edit'; st.textContent = `✏️ You are editing. Others see read-only until you stop or sign out.`; }
  else if (isLive(l)) { st.className = 'ro'; st.textContent = `👀 Read-only: ${l.email === S.me.email ? 'you, on another device,' : l.name} ${l.email === S.me.email ? 'are' : 'is'} editing (lock good until ${time(l.until)}).`; }
  else { st.className = 'ro'; st.textContent = `👀 Read-only. Nobody is editing${l ? ' (an old lock timed out)' : ''}. Tap "Start editing".`; }
  $('doc').readOnly = !mine;
  $('takeLockBtn').disabled = !!mine || isLive(l) || !enableEdit;
  show('takeOverBtn', !mine && isLive(l) && l.email === S.me.email);
  $('releaseBtn').disabled = !mine;
  $('saveBtn').disabled = !mine; $('addEntryBtn').disabled = !mine;
  const by = meta.lastModifyingUser?.displayName;
  $('docInfo').textContent = `Last changed ${meta.modifiedTime ? new Date(meta.modifiedTime).toLocaleString() : '—'}${by ? ' by ' + by : ''}.`;
}

async function save() {
  let obj;
  try { obj = JSON.parse($('doc').value); } catch (e) { return say('Not valid JSON, not saved: ' + e.message, true); }
  const wantEnc = $('encryptChk').checked;
  const pass = $('passInput').value || S.passphrase;
  if (wantEnc && !pass) return say('Type a passphrase in the Encryption box first.', true);
  $('saveBtn').disabled = true;
  const meta = await S.drive.getMeta(S.dataId);
  if (lockOf(meta)?.token !== S.lockToken) { S.lockToken = null; render(meta, false); return say('Not saved: you no longer hold the edit lock. Copy your text somewhere safe, then Refresh.', true); }
  if (meta.md5Checksum !== S.loadedMd5) { $('saveBtn').disabled = false; return say('Not saved: the file changed on Drive since you loaded it.', true); }
  // 1) dated backup of the version we are about to replace
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await S.drive.copy(S.dataId, S.backupsId, `data-${stamp}.json`);
  // 2) write the new version
  const plain = JSON.stringify(obj, null, 2);
  const out = wantEnc ? await encryptText(plain, pass) : plain;
  await S.drive.writeText(S.dataId, out);
  if (wantEnc) S.passphrase = pass;
  const after = await S.drive.getMeta(S.dataId);
  S.rawText = out; S.loadedMd5 = after.md5Checksum; setDoc(plain);
  await S.drive.setAppProps(S.dataId, { lockUntil: lockProps(S.lockToken).lockUntil });
  // 3) keep only the newest N backups
  const pruned = await prune();
  say(`Saved${wantEnc ? ' (encrypted)' : ''}. Backup made${pruned}.`);
  render(await S.drive.getMeta(S.dataId));
  if (!$('backups').classList.contains('hidden') && $('backups').children.length) await showBackups();
}

async function prune() {
  const files = await S.drive.listChildren(S.backupsId);           // newest first
  let deleted = 0, skipped = 0;
  for (const f of files.slice(CFG.maxBackups)) {
    if (!f.ownedByMe) { skipped++; continue; }                     // only the creator can delete in a shared My Drive folder
    try { await S.drive.del(f.id); deleted++; } catch { skipped++; }
  }
  return (deleted ? `, ${deleted} old backup(s) deleted` : '') + (skipped ? `, ${skipped} old backup(s) belong to your partner and will be cleaned up on their next save` : '');
}

async function showBackups() {
  const files = await S.drive.listChildren(S.backupsId);
  $('backupCount').textContent = `(${files.length}, keeping newest ${CFG.maxBackups})`;
  const ol = $('backups'); ol.innerHTML = '';
  for (const f of files) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${new Date(f.createdTime.slice(0, 24)).toLocaleString()}</span>`;
    const b = document.createElement('button'); b.textContent = 'Load into editor';
    b.disabled = !S.lockToken;
    b.onclick = () => guard(async () => {
      let t = await S.drive.readText(f.id);
      if (isEncrypted(t)) { if (!S.passphrase) return say('That backup is encrypted. Unlock with the passphrase first.', true); t = await decryptText(t, S.passphrase); }
      $('doc').value = t; say('Backup loaded into the editor. Tap Save to make it the current version.');
    });
    li.appendChild(b); ol.appendChild(li);
  }
}

// ---------------- Wiring ----------------
$('takeLockBtn').onclick = () => guard(() => takeLock(false));
$('takeOverBtn').onclick = () => guard(() => takeLock(true));
$('releaseBtn').onclick = () => guard(async () => {
  if ($('doc').value !== S.shownText && !confirm('You have unsaved changes. Stop editing and discard them?')) return;
  await releaseLock(); await loadContent(await S.drive.getMeta(S.dataId)); await refresh();
});
$('refreshBtn').onclick = () => guard(async () => {
  if (S.lockToken) return refresh();
  const meta = await S.drive.getMeta(S.dataId); await loadContent(meta); render(meta);
});
$('saveBtn').onclick = () => guard(save).finally(() => { if (S.lockToken) $('saveBtn').disabled = false; });
$('addEntryBtn').onclick = () => {
  try {
    const o = JSON.parse($('doc').value);
    (o.entries = o.entries || []).push({ at: new Date().toISOString(), by: S.me.name, note: 'test entry' });
    $('doc').value = JSON.stringify(o, null, 2);
  } catch (e) { say('Fix the JSON first: ' + e.message, true); }
};
$('unlockBtn').onclick = () => guard(async () => { S.passphrase = $('unlockPass').value; try { await showContent(); } catch (e) { S.passphrase = null; throw e; } });
$('loadBackupsBtn').onclick = () => guard(showBackups);
$('shareBtn').onclick = () => guard(async () => {
  const email = $('shareEmail').value.trim();
  if (!email.includes('@')) return say('Enter your partner\'s Google email address.', true);
  await S.drive.share(S.folder.id, email);
  say(`Shared the folder with ${email}. They can now sign in to this app.`);
});
['pointerdown', 'keydown', 'input'].forEach(ev => document.addEventListener(ev, () => { S.lastActivity = Date.now(); }, { passive: true }));

function startTimers() {
  stopTimers();
  S.heartbeat = setInterval(() => guard(heartbeat), HEARTBEAT_MS);
  S.poll = setInterval(() => { if (!S.lockToken && !document.hidden) guard(refresh); }, POLL_MS);
}
function stopTimers() { clearInterval(S.heartbeat); clearInterval(S.poll); }

// Coming back to the app (e.g. switching apps on Android): re-check the lock right away.
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.dataId && S.token) guard(S.lockToken ? heartbeat : refresh); });
// Closing the tab/app: best-effort release so the partner does not wait for the timeout.
window.addEventListener('pagehide', () => {
  if (S.lockToken && S.token && !MOCK) realDrive(() => S.token).setAppProps(S.dataId, NO_LOCK, true).catch(() => {});
  else if (S.lockToken && MOCK) S.drive.setAppProps(S.dataId, NO_LOCK);
});

// Expose for automated tests only.
window.__poc = { S, CFG, heartbeat, refresh };
boot();
