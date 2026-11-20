// Paste your OAuth Client ID here (see README step 4). It is NOT a secret.
// Leave it empty and the app will ask for it on first launch instead.
window.POC_CONFIG = {
  clientId: '438216142327-vos1hgrj2k6ke1i537iknb0mb0hngm3f.apps.googleusercontent.com',
  folderName: 'HouseholdBudgetPOC', // both of you must use the same name
  maxBackups: 30,                    // keep this many dated backups
  lockMinutes: 5,                    // a lock not refreshed for this long is stale
  idleMinutes: 10,                   // stop editing automatically after this much inactivity
};
