/**
 * main.js
 * Punto d'ingresso dell'applicazione dashboard Ami.
 * Inizializza il sistema di scale, lo stato centrale, il GPS e gestisce lo
 * switch tra le viste Parcheggio e Marcia.
 *
 * NELL'ATTUALE FASE: le due viste contengono i contenuti definiti in
 * css/parking.css, css/driving.css, js/ui/parking.js e js/ui/driving.js.
 * È presente un selettore di debug temporaneo (tasti P / D) per forzare
 * la vista durante lo sviluppo. Da rimuovere prima della release.
 */

import { updateScale } from './scale.js';
import { get, emit, subscribe, setSpeed, setGpsPermission } from './state.js';
import { initGps, stopGps, setSimulationSpeed } from './gps.js';
import { initMap } from './map.js';
import { initSpotify } from './spotify.js';
import { config } from './config.js';

const viewParking = document.getElementById('view-parking');
const viewDriving = document.getElementById('view-driving');

let currentMode = 'parking';

/**
 * Mostra la vista corretta in base alla modalità.
 * Transizione con dissolvenza di ~400 ms (gestita da CSS su .view.hidden).
 * @param {'parking' | 'driving'} mode
 */
function switchView(mode) {
  if (mode === currentMode) {
    return;
  }
  currentMode = mode;

  if (mode === 'driving') {
    viewParking.classList.add('hidden');
    viewDriving.classList.remove('hidden');
  } else {
    viewDriving.classList.add('hidden');
    viewParking.classList.remove('hidden');
  }
}

/**
 * Selettore di debug temporaneo.
 * Premere P per parcheggio, D per marcia.
 * Da rimuovere prima della release.
 */
function initDebugSelector() {
  window.addEventListener('keydown', (event) => {
    const key = event.key.toUpperCase();
    if (key === 'P') {
      setSpeed(0); // forza parcheggio
    } else if (key === 'D') {
      setSpeed(10); // forza marcia
    }
  });
}

/**
 * Registra il Service Worker per la PWA (cache offline + app shell).
 * Viene eseguito solo se il browser supporta i Service Worker.
 */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => {
        console.log('[sw.js] Service Worker registrato:', registration.scope);
      })
      .catch((err) => {
        console.warn('[sw.js] Errore registrazione Service Worker:', err);
      });
  }
}

/**
 * Inizializzazione dell'applicazione.
 */
function init() {
  // 0. Registra il Service Worker (PWA offline).
  registerServiceWorker();

  // 1. Imposta scala iniziale dello stage.
  updateScale();

  // 2. Sottoscrizione ai cambiamenti di modalità per lo switch viste.
  subscribe('mode', (newMode) => {
    switchView(newMode);
  });

  // 3. Selettore debug temporaneo (tastiera).
  initDebugSelector();

  // 4. Inizializza GPS (watchPosition, wake lock, banner, debug tap-lungo).
  initGps();

  // 5. Inizializza Google Maps (mappa grande in marcia, mini-mappa in parcheggio).
  initMap();

  // 6. Inizializza Spotify (login, polling stato, controlli player).
  initSpotify();

  // 7. Avvio in parcheggio (velocità 0).
  setSpeed(0);
}

// Avvio al caricamento del modulo.
init();
