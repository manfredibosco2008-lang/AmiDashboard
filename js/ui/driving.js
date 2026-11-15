/**
 * js/ui/driving.js
 * Logica della Vista Marcia (#view-driving).
 * Gestisce:
 *   - tachimetro (velocità da js/state.js, km/h con opzione mph)
 *   - soglia di velocità (numero rosso se superata, impostabile col pulsante "30")
 *   - indicatore di marcia P/R/N/D attivo
 *   - animazione delle linee di corsia (velocità proporzionale alla velocità reale)
 * I dati sono mockati e facili da sostituire con letture reali (GPS/OBD/CAN).
 */

import { subscribe } from '../state.js';

// Riferimenti DOM
const speedValue = document.getElementById('speed-value');
const limitCircle = document.getElementById('limit-value');
const gearItems = document.querySelectorAll('.gear');
const lanes = document.querySelectorAll('.lane');

// Stato della vista marcia
const drivingState = {
  speedKmh: 0,
  speedLimit: 30,   // soglia impostata (default 30 km/h)
  unit: 'kmh',      // 'kmh' | 'mph'
  gear: 'P',        // marcia attiva
};

/**
 * Converte la velocità nell'unità selezionata e la arrotonda.
 * @param {number} kmh
 * @returns {number}
 */
function convertSpeed(kmh) {
  if (drivingState.unit === 'mph') {
    return Math.round(kmh / 1.609344);
  }
  return Math.round(kmh);
}

/**
 * Aggiorna il numero del tachimetro e il colore (rosso se oltre soglia).
 * @param {number} value
 */
function updateSpeedDisplay(value) {
  speedValue.textContent = value;
  if (value > drivingState.speedLimit) {
    speedValue.classList.add('overspeed');
  } else {
    speedValue.classList.remove('overspeed');
  }
}

/**
 * Aggiorna l'indicatore di marcia attiva (P/R/N/D).
 * @param {string} gear
 */
function updateGearDisplay(gear) {
  drivingState.gear = gear;
  gearItems.forEach((el) => {
    const isActive = el.dataset.gear === gear;
    el.classList.toggle('active', isActive);
  });
}

/**
 * Cicla la soglia di velocità tra 30, 50, 80 e 120 km/h
 * ad ogni clic sul pulsante "30" del cerchio di controllo.
 */
const speedLimits = [30, 50, 80, 120];
let limitIndex = 0;

function cycleSpeedLimit() {
  limitIndex = (limitIndex + 1) % speedLimits.length;
  drivingState.speedLimit = speedLimits[limitIndex];
  limitCircle.textContent = drivingState.speedLimit;
  updateSpeedDisplay(convertSpeed(drivingState.speedKmh));
}

/**
 * Anima le linee di corsia: il tratteggio scorre verso il basso
 * con velocità proporzionale alla velocità reale del veicolo.
 */
let laneOffset = 0;
let lastTime = 0;

function animateLanes(timestamp) {
  if (!lastTime) {
    lastTime = timestamp;
  }
  const delta = timestamp - lastTime;
  lastTime = timestamp;

  // Velocità di scorrimento proporzionale alla velocità del veicolo.
  // Più velocità, più veloce scorre il tratteggio verso il basso.
  const scrollSpeed = (drivingState.speedKmh / 60) * 1.6; // px al ms circa
  laneOffset += scrollSpeed * delta;

  lanes.forEach((lane) => {
    lane.style.strokeDashoffset = -laneOffset;
  });

  requestAnimationFrame(animateLanes);
}

// Sottoscrizione allo stato centrale: aggiorna tachimetro e marcia.
subscribe('speedKmh', (value) => {
  drivingState.speedKmh = value;
  updateSpeedDisplay(convertSpeed(value));
});

subscribe('gear', (value) => {
  updateGearDisplay(value);
});

// Evento clic sul pulsante soglia (cerchio con il numero "30").
limitCircle.addEventListener('click', cycleSpeedLimit);

// Inizializzazione iniziale.
updateSpeedDisplay(convertSpeed(0));
updateGearDisplay('P');

// Avvio animazione linee corsia.
requestAnimationFrame(animateLanes);
