/**
 * state.js
 * Stato unico dell'applicazione (velocità, modalità, marcia, batteria,
 * temperatura, orario, portiera, bagagliaio, GPS) con un semplice
 * sistema di eventi (subscribe / emit).
 *
 * Logica di isteresi per lo switch tra le viste:
 *   - Parcheggio -> Marcia: velocità > 2 km/h (immediato)
 *   - Marcia -> Parcheggio: velocità <= 1,5 km/h per almeno 3 secondi
 * I dati del veicolo sono mockati e facili da sostituire con letture reali.
 */

// Stato iniziale mockato.
const state = {
  speedKmh: 0,              // velocità attuale in km/h
  mode: 'parking',          // 'parking' | 'driving'
  gear: 'P',                // P | R | N | D
  battery: 85,              // percentuale batteria 0-100
  temperature: 21,          // temperatura interna °C
  time: '9:54 am',          // orario formattato
  doorOpen: false,          // stato portiera
  trunkOpen: false,         // stato bagagliaio (frunk/trunk)
  gpsPermission: 'unknown', // 'granted' | 'denied' | 'prompt' | 'unknown'
  gpsSignal: true,          // true se il GPS sta fornendo fix validi
  gpsError: null,           // messaggio di errore GPS (se presente)
  simulationActive: false,  // true se la modalità debug è attiva
};

// Registro di callback per ogni chiave di stato.
const listeners = {};

// Timer di isteresi Marcia -> Parcheggio (3 secondi sotto 1,5 km/h).
let parkingTimer = null;

/**
 * Sottoscrive un callback a una chiave di stato.
 * @param {string} key - Chiave dello stato
 * @param {Function} cb - Callback chiamata con (nuovoValore, vecchioValore)
 */
export function subscribe(key, cb) {
  if (!listeners[key]) {
    listeners[key] = [];
  }
  listeners[key].push(cb);
}

/**
 * Emette un evento: aggiorna il valore di una chiave e notifica
 * tutti i sottoscrittori.
 * @param {string} key - Chiave dello stato
 * @param {any} value - Nuovo valore
 */
export function emit(key, value) {
  const oldValue = state[key];
  if (oldValue === value) {
    return;
  }
  state[key] = value;

  if (listeners[key]) {
    listeners[key].forEach((cb) => {
      try {
        cb(value, oldValue);
      } catch (err) {
        console.error(`Errore nel listener di ${key}:`, err);
      }
    });
  }
}

/**
 * Restituisce una copia dello stato corrente.
 * @returns {Object}
 */
export function getState() {
  return { ...state };
}

/**
 * Restituisce il valore di una singola chiave.
 * @param {string} key
 * @returns {any}
 */
export function get(key) {
  return state[key];
}

/**
 * Imposta il permesso di geolocalizzazione.
 * @param {'granted'|'denied'|'prompt'|'unknown'} val
 */
export function setGpsPermission(val) {
  emit('gpsPermission', val);
}

/**
 * Imposta lo stato del segnale GPS.
 * @param {boolean} signal - true se c'è fix valido
 * @param {string|null} error - messaggio di errore o null
 */
export function setGpsSignal(signal, error = null) {
  emit('gpsSignal', signal);
  emit('gpsError', error);
}

/**
 * Attiva/disattiva la simulazione di velocità (modalità debug).
 * @param {boolean} active
 */
export function setSimulationActive(active) {
  emit('simulationActive', active);
}

/**
 * Imposta la velocità e gestisce lo switch tra viste con isteresi.
 * @param {number} kmh
 */
export function setSpeed(kmh) {
  const cleanKmh = Math.max(0, Number(kmh) || 0);
  const currentMode = state.mode;

  emit('speedKmh', cleanKmh);

  if (currentMode === 'parking') {
    // Soglia di attivazione marcia: > 2 km/h (immediato).
    if (cleanKmh > 2) {
      if (parkingTimer) {
        clearTimeout(parkingTimer);
        parkingTimer = null;
      }
      emit('mode', 'driving');
    }
  } else {
    // Soglia di ritorno a parcheggio: <= 1,5 km/h per 3 secondi.
    if (cleanKmh <= 1.5) {
      if (!parkingTimer) {
        parkingTimer = setTimeout(() => {
          parkingTimer = null;
          emit('mode', 'parking');
        }, 3000);
      }
    } else {
      // Se si risale sopra la soglia, si annulla il timer di rientro.
      if (parkingTimer) {
        clearTimeout(parkingTimer);
        parkingTimer = null;
      }
    }
  }
}

/**
 * Annulla eventuale timer di rientro a parcheggio in corso.
 */
export function clearParkingTimer() {
  if (parkingTimer) {
    clearTimeout(parkingTimer);
    parkingTimer = null;
  }
}
