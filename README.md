# Dúchas on Google Drive

This is your Dúchas app with only three changes:

1. **Google sign-in.** Each of you signs in with your own Google account.
2. **Storage in Google Drive.** Your plan is kept in one file, `duchas-data.json`, in a Drive folder called **Duchas** that you share with each other. Every time someone checks out, a dated copy goes into **Duchas/backups**, and the newest 30 are kept.
3. **Check in / check out.** Only one person can edit at a time. The other person sees everything but can't change anything until the first person checks in.

Everything else works the same as before: screens, goals, bills, points, PINs, themes, and **Save a copy** / **Load & merge**.

---

## Put it online (about 5 minutes)

It goes into the same GitHub repository as the test version, so you don't need to change anything in Google Cloud.

1. Unzip `duchas-drive.zip` on your computer. You should see these 8 files:
   `index.html`, `cloud.js`, `config.js`, `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `README.md`
2. Go to **github.com**, open your **budget-poc** repository, and click **Add file → Upload files**.
3. Drag all 8 files into the box. If GitHub says some files already exist, that's fine. They get replaced.
4. Click **Commit changes** at the bottom.
5. Wait about 1 minute. Then open **https://ajqshake.github.io/budget-poc/**.
   If you still see the old test app, close the tab and open it again, or pull down to refresh.

You can leave the old test files there (`app.js`, `drive.js`, `crypto.js`, `icon.svg`), or delete them if you want. Dúchas doesn't use them.

## First time (Alex, on one device)

1. Open the address above and tap **Sign in with Google**. You'll see "Google hasn't verified this app" again. Tap **Advanced → Go to … (unsafe)**, then **Continue**, the same as when you tested.
2. Tap **Create the Duchas folder**.
3. Tap **📂 Choose my Dúchas file** and pick your latest saved file (for example `duchas-2026-11-20.json`). Your whole plan is copied into Google Drive.
4. Pick yourself (🐻 Alex) as usual.
5. Go to **Settings → Data, backup & sharing → Share with your partner**. Type Ingrid's Gmail address and tap **Share folder**.

## Ingrid (and any other device)

Open the same address, tap **Sign in with Google**, and pick your name. The app finds the shared folder by itself.

**Install it like an app on Android:** in Chrome, tap the **⋮** menu, then **Add to Home screen** (or **Install app**).

## Day to day

The button at the top of the screen shows where things stand:

| Button | What it means |
|---|---|
| **✏️ Check out** | Nobody is editing. You're read-only. Tap it to start editing. Making any change also checks you out automatically. |
| **✅ Check in** | You're editing. Everything saves to Drive as you go. Tap it when you're finished so the other person can edit. |
| **⏳ Saving…** | Saving to Drive right now. |
| **🔒 Ingrid editing** | Someone else is editing. You can look, and their changes show up on your screen within about 20 seconds. |
| **🔑 Sign in again** | Google sign-ins last one hour. Tap it to carry on. Nothing is lost. |

- If you forget to check in, it happens by itself after 15 minutes without a tap.
- If a phone dies while it's checked out, the other person can edit again after about 5 minutes.
- If the app closes before a change reaches Drive, the change is kept on that phone and added the next time you check out.

## Backups

Go to **Settings → 🗂️ Backups** to see the dated copies. To roll back, check out, then tap **Restore** next to a backup. The current version is backed up first, so a restore can be undone too.

## Optional: passphrase lock

Go to **Settings → Passphrase lock → Turn on**. This scrambles the file in Drive so that only someone who knows the passphrase can read it. Each of you types the passphrase once on each device (tick **Remember on this device** to skip that next time).
**If you both forget the passphrase, the data can't be recovered.**

## Where your data goes

Your data only goes between your devices and your own Google Drive. While you're editing, this device also keeps a temporary copy of any change that hasn't reached Drive yet, and deletes it once the change is saved.

## Settings you can change (config.js)

`folderName`, `maxBackups` (30), `lockMinutes` (5), `idleMinutes` (15), and `autoCheckOut` (true). Set `autoCheckOut` to `false` if you want people to tap **Check out** before they can make any change.
