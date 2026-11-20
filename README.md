# Budget Drive POC

A throwaway proof of concept for the household budget architecture. It has no budget features. It only proves this:

1. **Static web app, installable on Android.** Plain HTML and JavaScript, no server, no build step. Hosted free on GitHub Pages and installable as an app (PWA).
2. **Sign in with Google, data in your own Drive.** One `data.json` file lives in a folder called `HouseholdBudgetPOC` in one person's Google Drive, shared with the other person. The data goes only between your phone and Google. There is no server of ours in the middle.
3. **One editor at a time.** Tapping **Start editing** takes a lock. The other person sees the file read-only, with the editor's name, until the editor taps **Stop editing** or **Sign out**, closes the app, or the lock times out (5 minutes without a heartbeat, or 10 minutes idle).
4. **Backups on every save.** Before each save, the current version is copied to `backups/data-<date-time>.json`. Only the newest 30 are kept.
5. **Optional passphrase encryption.** If you turn it on, Google only stores scrambled data (AES-256-GCM). Both of you need the passphrase.

## Try it with no setup (demo mode)

Demo mode uses a fake Drive inside your browser, so you can try the lock flow before doing any Google setup.

1. On a computer, open a terminal in this folder and run `python3 -m http.server 8000`.
2. Open `http://localhost:8000/?mock=alice` in one tab and `http://localhost:8000/?mock=bob` in another.
3. As Alice: sign in, tap **Create shared folder**, share with `bob@example.com`, then **Start editing**.
4. Switch to Bob's tab. Bob is read-only and sees that Alice is editing. Sign Alice out and Bob can take over.

## Part 1: Google Cloud setup (about 15 minutes, free)

You do this once. Use the Google account that will **own** the shared folder. Google renames its console menus from time to time, so if a label differs slightly, look for the closest match.

### 1. Create a project
1. Go to <https://console.cloud.google.com/> and sign in.
2. Click the project picker at the top left, then **New project**.
3. Name it `Household Budget` and click **Create**. Make sure it is selected in the project picker afterwards.

No billing account is needed. Nothing here costs money.

### 2. Turn on the Google Drive API
1. Go to <https://console.cloud.google.com/apis/library/drive.googleapis.com>.
2. Click **Enable**.

### 3. Set up the sign-in screen (OAuth consent screen)
1. Go to <https://console.cloud.google.com/auth/overview> (menu: **APIs & Services → OAuth consent screen**, or **Google Auth Platform**) and click **Get started**.
2. **App information:** app name `Household Budget`, and pick your email as the support email. Click **Next**.
3. **Audience:** choose **External**. Click **Next**.
4. **Contact information:** your email. Click **Next**, accept the policy, then **Create**.
5. Open **Audience** in the left menu. Leave the publishing status as **Testing**. Under **Test users**, click **Add users** and add **both** Gmail addresses (yours and your wife's). Save.
   *Only these accounts will be able to sign in. That is what you want.*
6. Open **Data Access** in the left menu. Click **Add or remove scopes**, tick `.../auth/drive` (the Google Drive API scope "See, edit, create, and delete all of your Google Drive files"), click **Update**, then **Save**.

### 4. Create the OAuth Client ID
1. Open **Clients** in the left menu (or **APIs & Services → Credentials → Create credentials → OAuth client ID**).
2. Click **Create client**. Application type: **Web application**. Name: `Budget web app`.
3. Under **Authorized JavaScript origins**, click **Add URI** and add:
   - `https://YOUR-GITHUB-USERNAME.github.io` (the address from Part 2, with **no** path and no trailing slash)
   - `http://localhost:8000` (for testing on your computer)
4. Leave **Authorized redirect URIs** empty. Click **Create**.
5. Copy the **Client ID**. It looks like `1234567890-abc123.apps.googleusercontent.com`. You do **not** need the client secret; this app never uses it.

The Client ID is not a secret. It is safe in a public GitHub repo, because Google only accepts it from the origins you listed and only for your test users.

Changes to origins can take a few minutes (occasionally longer) to start working.

## Part 2: Host it free on GitHub Pages

1. On GitHub, create a new **public** repository, for example `budget-poc`. (GitHub Pages is free for public repos. Only the code is public. Your data stays in Drive.)
2. Upload all the files in this folder to the repository root (**Add file → Upload files**).
3. Optional: edit `config.js` and paste your Client ID into `clientId: ''`. If you skip this, the app asks for it on first launch and remembers it on that device.
4. Go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and click **Save**.
5. After a minute, the app is at `https://YOUR-GITHUB-USERNAME.github.io/budget-poc/`.

## Part 3: Test the real thing

**You (folder owner), on desktop or phone:**
1. Open the app address. Paste the Client ID if asked.
2. Tap **Sign in with Google** and pick your account.
3. You will see **"Google hasn't verified this app"**. This is expected for a private app in testing mode. Tap **Advanced → Go to Household Budget (unsafe)**, then **Continue**.
4. Tap **Create shared folder**. Check Google Drive: there is now a `HouseholdBudgetPOC` folder with `data.json` and a `backups` folder.
5. In **Share with your partner**, enter your wife's Gmail address and tap **Share folder**.

**Your wife, on her Android phone:**
1. Open the same address in **Chrome**. Paste the Client ID if asked.
2. Sign in with her Google account (same "unverified" step). The app finds the shared folder automatically.
3. Install it: Chrome menu **⋮ → Add to Home screen → Install**. It now opens like a normal app.

**Things to try:**
- One of you taps **Start editing**. The other sees "Read-only: … is editing". Their **Start editing** is greyed out.
- The editor taps **Add test entry**, then **Save to Drive**. Within about 20 seconds the other phone shows the new entry.
- The editor taps **Sign out**. The other person can now **Start editing**.
- Take the lock on a phone, then force-close the app. After about 5 minutes the other person can take over.
- Save a few times, then tap **Show backups** and open the `backups` folder in Drive.
- Turn on encryption, save, and open `data.json` in Drive to see that it is scrambled. The other person must enter the passphrase to read it.

## How it works (for the real build)

| Piece | How the POC does it |
|---|---|
| Sign-in | Google Identity Services "token" flow in the browser. No server, no client secret. Access tokens last 1 hour; the app asks for a tap to renew shortly before then. |
| Storage | Drive API v3 called directly with `fetch` (`drive.js`). |
| Finding the file | Searches for a folder named `HouseholdBudgetPOC` that you own or that was shared with you. |
| Lock | Stored as private app properties on `data.json`: who holds it, a random per-device token, and an expiry time. The holder refreshes it every minute. To take the lock, the app writes it, waits 1.5 seconds, and re-reads to make sure nobody else wrote at the same moment. |
| Safety on save | Before writing, it checks it still holds the lock and that the file has not changed since it was loaded (MD5 checksum). If either fails, it refuses to save. |
| Backups | Copies the current file into `backups/` before each save, then deletes all but the newest 30. In a shared folder, only the person who created a backup can delete it, so each person's app cleans up its own backups. |
| Encryption | PBKDF2-SHA256 (310,000 rounds) to turn the passphrase into a key, then AES-256-GCM. |
| PWA | `manifest.webmanifest` plus a small service worker (`sw.js`) that caches only the app's own files. |

## Known POC limits

- **Drive permission scope.** The POC asks for full Drive access (`auth/drive`), because that is the simplest way for the second person to see a folder shared with them. It is also why Google shows the "unverified app" screen, and why it only works for the test users you listed. The app only ever reads the `HouseholdBudgetPOC` folder, but Google's consent screen cannot express that. For the real build, a narrower option is the `drive.file` scope plus a one-time "pick the shared folder" step for the second person; that is worth proving next.
- **Re-approval.** Apps in Google's "Testing" status may occasionally ask you to approve access again.
- **Sign-in renewal.** Browser-only sign-in lasts 1 hour, then the app asks for a tap. If nobody taps and the editor's token expires, the lock simply times out 5 minutes later.
- **Clocks.** Lock expiry uses each device's clock. Phones keep accurate time, so this is fine in practice.
- **Lock is cooperative.** Anyone with access to the folder could still edit `data.json` directly in Drive. The lock only coordinates the two copies of the app.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page and its styles |
| `app.js` | Sign-in, lock, load, save, backups |
| `drive.js` | Drive API calls, plus the demo-mode fake Drive |
| `crypto.js` | Optional passphrase encryption |
| `config.js` | Your Client ID and settings |
| `sw.js`, `manifest.webmanifest`, `icon*` | Make it installable on Android |
