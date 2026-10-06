'use strict';
// Gives the built-in "can't connect" screen one small ability: saving a new site address.
// The main process refuses this request from any page except that screen (see main.js).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qpDesktop', {
  setSiteUrl: (url) => ipcRenderer.invoke('qp:set-site-url', String(url || '')),
});
