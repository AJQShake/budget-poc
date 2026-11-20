// Dúchas settings. Your OAuth Client ID is not a secret (it only works on your own web address).
window.DUCHAS_CONFIG = {
  clientId: '438216142327-vos1hgrj2k6ke1i537iknb0mb0hngm3f.apps.googleusercontent.com',
  folderName: 'Duchas',               // the shared Google Drive folder (both of you use the same one)
  dataFileName: 'duchas-data.json',   // the data file inside that folder
  maxBackups: 30,                     // keep this many dated backups in Duchas/backups
  lockMinutes: 5,                     // a check-out not refreshed for this long can be taken over
  idleMinutes: 15,                    // check in automatically after this long with no taps
  autoCheckOut: true,                 // making a change checks you out automatically when nobody else is editing
};
