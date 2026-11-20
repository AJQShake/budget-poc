// crypto.js — optional passphrase encryption (AES-256-GCM, key from PBKDF2-SHA256).
// The passphrase never leaves the device. Lose it and the data is unrecoverable.

const ITERATIONS = 310000;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function key(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function isEncrypted(text) {
  try { return JSON.parse(text).pocEncrypted === 1; } catch { return false; }
}

export async function encryptText(plain, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(passphrase, salt), enc.encode(plain));
  return JSON.stringify({ pocEncrypted: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(ct) });
}

export async function decryptText(text, passphrase) {
  const o = JSON.parse(text);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, await key(passphrase, unb64(o.salt)), unb64(o.data));
    return dec.decode(pt);
  } catch {
    throw new Error('Wrong passphrase (or the file is damaged)');
  }
}
