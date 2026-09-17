'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desvio', {
  platform: process.platform,

  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  clearError: () => ipcRenderer.invoke('error:clear'),

  connect: () => ipcRenderer.invoke('whatsapp:connect'),
  disconnect: () => ipcRenderer.invoke('whatsapp:disconnect'),
  getContacts: () => ipcRenderer.invoke('whatsapp:contacts'),
  refreshModels: () => ipcRenderer.invoke('groq:models'),

  importHistory: () => ipcRenderer.invoke('learning:import'),
  forgetSamples: () => ipcRenderer.invoke('learning:forget'),

  loadMedia: (id) => ipcRenderer.invoke('media:load', { id }),
  openLink: (url) => ipcRenderer.invoke('media:open', { url }),

  decide: (id, action, reply) => ipcRenderer.invoke('reply:decide', { id, action, reply }),
  draftDirect: (id, instruction) => ipcRenderer.invoke('direct:draft', { id, instruction }),
  sendDirect: (id, reply) => ipcRenderer.invoke('direct:send', { id, reply }),
  inspectText: (text) => ipcRenderer.invoke('text:inspect', { text }),

  onState: (listener) => ipcRenderer.on('state:changed', (_event, state) => listener(state))
});
