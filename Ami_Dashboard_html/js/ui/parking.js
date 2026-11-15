/**
 * js/ui/parking.js
 * Logica della vista Parcheggio (#view-parking).
 * Gestisce:
 *   - lucchetto auto (aperto/chiuso)
 *   - etichetta porta sinistra ("Apri"/"Chiudi")
 *   - etichetta bagagliaio destra ("Apri"/"Chiudi")
 *   - sincronizzazione con lo stato centrale (js/state.js)
 * I dati sono mockati e facili da sostituire con letture reali.
 */

import { emit, subscribe } from '../state.js';

// Riferimenti DOM
const carLock = document.getElementById('car-lock');
const actionLeft = document.getElementById('action-left');
const objectLeft = document.getElementById('object-left');
const actionRight = document.getElementById('action-right');
const objectRight = document.getElementById('object-right');

// Stato locale della vista parcheggio
const parkingState = {
  locked: true,        // lucchetto auto
  doorOpen: false,     // portiera
  trunkOpen: false,    // bagagliaio
};

/**
 * Aggiorna l'aspetto del lucchetto in base allo stato.
 */
function renderLock() {
  if (parkingState.locked) {
    carLock.classList.remove('unlocked');
    carLock.setAttribute('aria-label', 'Auto chiusa');
  } else {
    carLock.classList.add('unlocked');
    carLock.setAttribute('aria-label', 'Auto aperta');
  }
}

/**
 * Aggiorna il testo di un'etichetta (Apri / Chiudi) in base allo stato.
 * @param {HTMLElement} actionEl - elemento che contiene "Apri"/"Chiudi"
 * @param {boolean} isOpen - true se l'elemento è aperto
 */
function renderAction(actionEl, isOpen) {
  actionEl.textContent = isOpen ? 'Chiudi' : 'Apri';
  actionEl.style.color = isOpen ? '#ff3b30' : '#b5b5b9';
}

/**
 * Toggle lucchetto auto. Alterna aperto/chiuso.
 */
function toggleCarLock() {
  parkingState.locked = !parkingState.locked;
  renderLock();
  emit('doorOpen', !parkingState.locked); // semplificazione: porta legata al lucchetto
}

/**
 * Toggle portiera sinistra.
 */
function toggleDoor() {
  parkingState.doorOpen = !parkingState.doorOpen;
  renderAction(actionLeft, parkingState.doorOpen);
  emit('doorOpen', parkingState.doorOpen);
}

/**
 * Toggle bagagliaio.
 */
function toggleTrunk() {
  parkingState.trunkOpen = !parkingState.trunkOpen;
  renderAction(actionRight, parkingState.trunkOpen);
  emit('trunkOpen', parkingState.trunkOpen);
}

/**
 * Inizializza gli eventi di click sulla vista parcheggio.
 */
function initParking() {
  // Lucchetto auto
  carLock.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleCarLock();
  });

  // Etichetta porta (tutta l'area cliccabile)
  const labelLeft = document.querySelector('.label-left');
  labelLeft.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDoor();
  });

  // Etichetta bagagliaio (tutta l'area cliccabile)
  const labelRight = document.querySelector('.label-right');
  labelRight.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTrunk();
  });

  // Sincronizza lo stato iniziale con lo stato centrale
  renderLock();
  renderAction(actionLeft, parkingState.doorOpen);
  renderAction(actionRight, parkingState.trunkOpen);
}

// Avvio
initParking();
