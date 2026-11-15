/**
 * js/gps.js
 * Gestione GPS e simulazione velocità per la dashboard Ami.
 *
 * Funzionalità:
 *   - navigator.geolocation.watchPosition (enableHighAccuracy, maximumAge 0, timeout 10s)
 *   - Velocità = coords.speed * 3.6 quando disponibile
 *   - Fallback Haversine se speed è null/NaN (distanza / tempo tra letture)
 *   - Scarta letture con accuracy > 50 m e salti > 80 km/h
 *   - Media mobile sulle ultime 5 letture; scarta negativi/NaN
 *   - Banner discreto se permesso negato / GPS non disponibile
 *   - Pulsante "Attiva GPS" alla prima volta (gesto utente)
 *   - Wake Lock dello schermo (richiesta all'avvio e al ritorno in primo piano)
 *   - Modalità debug nascosta: tap lungo 1 s sull'orario o ?debug=1 nell'URL
 *     con slider 0-50 km/h che sostituisce il GPS
 *   - Segnale perso in galleria: mantiene ultima velocità valida ~5 s,
 *     poi stato "senza segnale" con icona nella barra di stato
 */

import {
  emit,
  subscribe,
  setSpeed,
  setGpsPermission,
  setGpsSignal,
  setSimulationActive,
  clearParkingTimer,
  getState,
} from './state.js';

// ------------------------------------------------------------
// Configurazione
// ------------------------------------------------------------
const CONFIG = {
  accuracyMaxMeters: 50,      // scarta letture meno precise di 50 m
  maxJumpKmh: 80,             // salto irrealistico massimo per questo veicolo
  averageWindow: 5,           // dimensione media mobile
  signalLossMs: 5000,         // tempo prima di dichiarare segnale perso
  longPressMs: 1000,          // tap lungo per attivare debug
};

// ------------------------------------------------------------
// Stato interno del modulo GPS
// ------------------------------------------------------------
let watchId = null;           // ID di watchPosition
let lastPosition = null;      // ultima posizione valida (coords)
let lastTimestamp = null;     // timestamp dell'ultima posizione
let speedBuffer = [];         // buffer per media mobile
let lastValidSpeed = 0;       // ultima velocità valida prima di perdita segnale
let signalLossTimer = null;   // timer perdita segnale
let isSimulationActive = false;
let simulatedSpeed = 0;

// Riferimenti DOM (cercati al primo utilizzo, per non fallire se assenti)
let gpsBanner = null;
let gpsEnableBtn = null;
let debugPanel = null;
let debugSlider = null;
let debugValue = null;
let debugCloseBtn = null;
let timeEls = [];             // elementi orario su cui attivare il tap lungo

// ------------------------------------------------------------
// Funzioni pure (esportate anche per i test)
// ------------------------------------------------------------

/**
 * Formula di Haversine: distanza in metri tra due punti geografici.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} distanza in metri
 */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // raggio Terra in metri
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Media mobile semplice di un array di numeri.
 * @param {number[]} values
 * @returns {number}
 */
export function movingAverage(values) {
  if (!values || values.length === 0) {
    return 0;
  }
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

/**
 * Aggiunge una lettura al buffer e restituisce la media filtrata.
 * Scarta valori negativi o NaN.
 * @param {number} speedKmh
 * @returns {number|null} velocità filtrata o null se non abbastanza dati
 */
export function addSpeedSample(speedKmh) {
  if (!Number.isFinite(speedKmh) || speedKmh < 0) {
    return null;
  }
  speedBuffer.push(speedKmh);
  if (speedBuffer.length > CONFIG.averageWindow) {
    speedBuffer.shift();
  }
  return movingAverage(speedBuffer);
}

/**
 * Verifica se un salto di velocità è irrealistico rispetto all'ultimo valore.
 * @param {number} newSpeed
 * @param {number} lastSpeed
 * @returns {boolean} true se il salto è accettabile
 */
export function isRealisticJump(newSpeed, lastSpeed) {
  return Math.abs(newSpeed - lastSpeed) <= CONFIG.maxJumpKmh;
}

// ------------------------------------------------------------
// Wake Lock
// ------------------------------------------------------------

let wakeLock = null;

/**
 * Richiede il Wake Lock dello schermo per evitare il timeout del display.
 * Viene chiamato all'avvio e quando la pagina torna visibile.
 */
export async function requestWakeLock() {
  if (!navigator.wakeLock) {
    console.warn('Wake Lock non supportato su questo browser.');
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (err) {
    console.warn('Impossibile attivare Wake Lock:', err);
  }
}

function initWakeLock() {
  requestWakeLock();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
    }
  });
}

// ------------------------------------------------------------
// Elementi DOM
// ------------------------------------------------------------

function getGpsBanner() {
  if (!gpsBanner) {
    gpsBanner = document.getElementById('gps-banner');
    gpsEnableBtn = document.getElementById('gps-enable-btn');
  }
  return gpsBanner;
}

function getDebugPanel() {
  if (!debugPanel) {
    debugPanel = document.getElementById('debug-panel');
    debugSlider = document.getElementById('debug-slider');
    debugValue = document.getElementById('debug-value');
    debugCloseBtn = document.getElementById('debug-close');
  }
  return debugPanel;
}

function getTimeElements() {
  if (timeEls.length === 0) {
    const topTime = document.getElementById('top-time');
    const mapTime = document.getElementById('map-time');
    if (topTime) timeEls.push(topTime);
    if (mapTime) timeEls.push(mapTime);
  }
  return timeEls;
}

// ------------------------------------------------------------
// Banner GPS
// ------------------------------------------------------------

function showGpsBanner(message) {
  const banner = getGpsBanner();
  if (!banner) return;
  const textEl = banner.querySelector('.gps-banner-text');
  if (textEl) textEl.textContent = message;
  banner.classList.remove('hidden');
}

function hideGpsBanner() {
  const banner = getGpsBanner();
  if (banner) banner.classList.add('hidden');
}

// ------------------------------------------------------------
// Pannello debug
// ------------------------------------------------------------

function openDebugPanel() {
  const panel = getDebugPanel();
  if (!panel) return;
  panel.classList.remove('hidden');
  if (debugSlider) debugSlider.disabled = false;
  if (debugValue) debugValue.textContent = `${Math.round(simulatedSpeed)} km/h`;
}

function closeDebugPanel() {
  const panel = getDebugPanel();
  if (!panel) return;
  panel.classList.add('hidden');
  stopSimulation();
}

function toggleDebug() {
  const panel = getDebugPanel();
  if (!panel) return;
  const isHidden = panel.classList.contains('hidden');
  if (isHidden) {
    openDebugPanel();
    startSimulation(simulatedSpeed || 0);
  } else {
    closeDebugPanel();
  }
}

function startSimulation(initialKmh = 0) {
  isSimulationActive = true;
  simulatedSpeed = Math.max(0, Math.min(50, initialKmh));
  setSimulationActive(true);
  setSpeed(simulatedSpeed);
  // Aggiorna il tachimetro della simulazione in tempo reale.
  // Viene pilotato dallo slider; setSpeed sopra avvia il primo valore.
}

function stopSimulation() {
  isSimulationActive = false;
  simulatedSpeed = 0;
  setSimulationActive(false);
  setSpeed(0);
}

/**
 * Imposta la velocità simulata (chiamata dallo slider del pannello debug).
 * @param {number} kmh
 */
export function setSimulationSpeed(kmh) {
  if (!isSimulationActive) return;
  simulatedSpeed = Math.max(0, Math.min(50, kmh));
  if (debugValue) debugValue.textContent = `${Math.round(simulatedSpeed)} km/h`;
  setSpeed(simulatedSpeed);
}

// ------------------------------------------------------------
// Tap lungo sull'orario per attivare debug
// ------------------------------------------------------------

function initLongPressDebug() {
  const els = getTimeElements();
  els.forEach((el) => {
    let pressTimer = null;

    const start = () => {
      pressTimer = setTimeout(() => {
        pressTimer = null;
        toggleDebug();
      }, CONFIG.longPressMs);
    };

    const clear = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    el.addEventListener('pointerdown', start, { passive: true });
    el.addEventListener('pointerup', clear, { passive: true });
    el.addEventListener('pointercancel', clear, { passive: true });
    el.addEventListener('pointerleave', clear, { passive: true });
    // Rende l'orario visivamente "tappabile"
    el.style.cursor = 'pointer';
    el.title = 'Tieni premuto 1 s per modalità debug';
  });
}

// ------------------------------------------------------------
// Elaborazione posizione GPS
// ------------------------------------------------------------

/**
 * Processa una posizione ricevuta dal browser.
 * @param {Position} position
 */
function processPosition(position) {
  const coords = position.coords;
  const now = position.timestamp;

  // Scarta letture con precisione insufficiente.
  if (coords.accuracy > CONFIG.accuracyMaxMeters) {
    return;
  }

  let speedKmh = null;

  // 1) Velocità diretta dal GPS, se disponibile e valida.
  if (Number.isFinite(coords.speed) && coords.speed !== null) {
    speedKmh = coords.speed * 3.6;
  }

  // 2) Fallback Haversine se non c'è speed diretto.
  if ((!Number.isFinite(speedKmh) || speedKmh === null) && lastPosition && lastTimestamp) {
    const distM = haversine(
      lastPosition.latitude,
      lastPosition.longitude,
      coords.latitude,
      coords.longitude
    );
    const dtS = (now - lastTimestamp) / 1000;
    if (dtS > 0) {
      speedKmh = (distM / 1000) * 3600 / dtS; // m/s -> km/h
    }
  }

  // Se ancora niente velocità valida, mantieni l'ultima.
  if (!Number.isFinite(speedKmh) || speedKmh === null) {
    speedKmh = lastValidSpeed;
  }

  // Scarta salti irrealistici.
  if (!isRealisticJump(speedKmh, lastValidSpeed)) {
    speedKmh = lastValidSpeed;
  }

  // Filtro media mobile.
  const filtered = addSpeedSample(speedKmh);
  if (filtered === null) {
    return;
  }

  // Aggiorna stato e segnala segnale presente.
  lastValidSpeed = filtered;
  lastPosition = coords;
  lastTimestamp = now;

  // Resetta timer di perdita segnale.
  if (signalLossTimer) {
    clearTimeout(signalLossTimer);
    signalLossTimer = null;
  }
  setGpsSignal(true, null);
  hideGpsBanner();

  // Non sovrascrivere se la simulazione è attiva.
  if (!isSimulationActive) {
    setSpeed(filtered);
  }
}

/**
 * Gestisce un errore di geolocalizzazione.
 * @param {PositionError} error
 */
function onGpsError(error) {
  let message = 'Errore GPS sconosciuto';
  switch (error.code) {
    case error.PERMISSION_DENIED:
      message = 'Permesso posizione negato';
      setGpsPermission('denied');
      showGpsBanner('GPS disattivato — premi "Attiva GPS"');
      break;
    case error.POSITION_UNAVAILABLE:
      message = 'Posizione non disponibile';
      setGpsPermission('denied');
      showGpsBanner('GPS non disponibile');
      break;
    case error.TIMEOUT:
      message = 'Timeout posizione';
      break;
    default:
      message = `Errore GPS: ${error.message}`;
  }
  console.warn(message);
  setGpsSignal(false, message);
}

// ------------------------------------------------------------
// Perdita segnale (galleria)
// ------------------------------------------------------------

function startSignalLossTimer() {
  if (signalLossTimer) return;
  signalLossTimer = setTimeout(() => {
    signalLossTimer = null;
    setGpsSignal(false, 'Nessun segnale');
    showGpsBanner('Senza segnale GPS');
    if (!isSimulationActive) {
      setSpeed(0);
    }
  }, CONFIG.signalLossMs);
}

/**
 * Forza la fine del timer di perdita segnale (chiamato quando arriva un fix).
 */
function clearSignalLossTimer() {
  if (signalLossTimer) {
    clearTimeout(signalLossTimer);
    signalLossTimer = null;
  }
}

// ------------------------------------------------------------
// Inizializzazione GPS
// ------------------------------------------------------------

/**
 * Richiede i permessi e avvia il tracciamento della posizione.
 * Se il permesso è già negato, mostra il banner con il pulsante.
 */
export function initGps() {
  initWakeLock();
  initLongPressDebug();

  // Verifica se debug è forzato via URL.
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('debug') === '1') {
    openDebugPanel();
    startSimulation(0);
  }

  // Gestione pulsante "Attiva GPS".
  const btn = document.getElementById('gps-enable-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      requestGpsPermission();
    });
  }

  // Gestione slider debug.
  const slider = document.getElementById('debug-slider');
  if (slider) {
    slider.addEventListener('input', (e) => {
      setSimulationSpeed(Number(e.target.value));
    });
    slider.addEventListener('change', (e) => {
      setSimulationSpeed(Number(e.target.value));
    });
  }

  const closeBtn = document.getElementById('debug-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeDebugPanel);
  }

  requestGpsPermission();
}

/**
 * Richiede il permesso di geolocalizzazione e avvia watchPosition.
 */
function requestGpsPermission() {
  if (!navigator.geolocation) {
    setGpsPermission('denied');
    setGpsSignal(false, 'Geolocation non supportata');
    showGpsBanner('GPS non supportato su questo dispositivo');
    return;
  }

  // Prova a queryare lo stato del permesso (non supportato ovunque).
  if (navigator.permissions) {
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((result) => {
        setGpsPermission(result.state);
        if (result.state === 'granted') {
          hideGpsBanner();
          startWatch();
        } else if (result.state === 'denied') {
          showGpsBanner('Permesso posizione negato — premi "Attiva GPS"');
        } else {
          // 'prompt': prova ad avviare watch (chiederà all'utente).
          startWatch();
        }
      })
      .catch(() => {
        startWatch();
      });
  } else {
    startWatch();
  }
}

/**
 * Avvia watchPosition.
 */
function startWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      processPosition(position);
    },
    (error) => {
      onGpsError(error);
      // Se permesso negato, mostra il pulsante attiva.
      if (error.code === error.PERMISSION_DENIED) {
        showGpsBanner('Permesso posizione negato — premi "Attiva GPS"');
      }
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000,
    }
  );
}

/**
 * Ferma il tracciamento GPS.
 */
export function stopGps() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  clearSignalLossTimer();
  stopSimulation();
}

// ------------------------------------------------------------
// Sottoscrizioni allo stato centrale
// ------------------------------------------------------------

// Se la simulazione viene attivata/disattivata da fuori, adeguati.
subscribe('simulationActive', (active) => {
  isSimulationActive = active;
  if (!active) {
    stopSimulation();
  }
});

// Esponi stopGps e startGps per uso esterno.
export { startWatch as startGps };
