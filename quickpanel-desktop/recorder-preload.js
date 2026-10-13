'use strict';
// The hidden recorder window can only do two things: hear "save a clip" from the app, and hand finished video back.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qpRec', {
  onSave: (cb) => ipcRenderer.on('qp:rec-save', () => cb()),
  onStop: (cb) => ipcRenderer.on('qp:rec-stop', () => cb()),
  sendClip: (buf, meta) => ipcRenderer.invoke('qp:clip-data', buf, meta),
  status: (s) => ipcRenderer.send('qp:rec-status', String(s || '')),
});
