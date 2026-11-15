/**
 * js/tests.js
 * Test della logica di soglia, isteresi e filtro velocità.
 * Eseguibile nel browser senza librerie esterne.
 * Importa le funzioni pure da ./gps.js e lo stato da ./state.js.
 */

import {
  haversine,
  movingAverage,
  addSpeedSample,
  isRealisticJump,
} from './gps.js';
import { setSpeed, subscribe, clearParkingTimer, getState } from './state.js';

const output = document.getElementById('output');
let passed = 0;
let failed = 0;

function assert(condition, name) {
  const line = document.createElement('div');
  if (condition) {
    passed++;
    line.textContent = '✅ ' + name;
    line.style.color = '#22d33a';
  } else {
    failed++;
    line.textContent = '❌ ' + name;
    line.style.color = '#ff3b30';
  }
  output.appendChild(line);
}

// ------------------------------------------------------------
// Test Haversine
// ------------------------------------------------------------
const dSame = haversine(45.0, 9.0, 45.0, 9.0);
assert(dSame === 0, 'Haversine: stesso punto restituisce 0 metri');

// Distanza nota: 1 grado di latitudine ≈ 111 km
const dOneDegLat = haversine(0, 0, 1, 0);
assert(dOneDegLat > 110000 && dOneDegLat < 112000, 'Haversine: 1° latitudine ≈ 111 km');

// ------------------------------------------------------------
// Test media mobile
// ------------------------------------------------------------
assert(movingAverage([10, 20, 30]) === 20, 'MovingAverage: [10,20,30] = 20');
assert(movingAverage([]) === 0, 'MovingAverage: array vuoto = 0');

// ------------------------------------------------------------
// Test addSpeedSample (filtro + media mobile finestra 5)
// ------------------------------------------------------------
// Inserisce 4 valori validi
addSpeedSample(10);
addSpeedSample(20);
addSpeedSample(30);
const avg1 = addSpeedSample(40); // buffer [10,20,30,40] -> media 25
assert(Math.abs(avg1 - 25) < 0.01, 'addSpeedSample: media [10,20,30,40] = 25');

// Valori negativi e NaN devono essere scartati
addSpeedSample(-5);
addSpeedSample(NaN);
const avg2 = addSpeedSample(50); // buffer [20,30,40,50] -> media 35
assert(Math.abs(avg2 - 35) < 0.01, 'addSpeedSample: negativi/NaN scartati, media [20,30,40,50] = 35');

// ------------------------------------------------------------
// Test salto irrealistico
// ------------------------------------------------------------
assert(isRealisticJump(10, 0) === true, 'isRealisticJump: salto 0->10 accettabile');
assert(isRealisticJump(90, 0) === false, 'isRealisticJump: salto 0->90 irrealistico (>80 km/h)');
assert(isRealisticJump(80, 0) === true, 'isRealisticJump: salto 0->80 accettabile (soglia inclusa)');

// ------------------------------------------------------------
// Test switch vista con isteresi
// ------------------------------------------------------------
setSpeed(0);
assert(getState().mode === 'parking', 'Isteresi: partenza in parcheggio');

setSpeed(3);
assert(getState().mode === 'driving', 'Isteresi: > 2 km/h -> marcia immediato');

setSpeed(1);
assert(getState().mode === 'driving', 'Isteresi: <= 1,5 km/h non cambia subito (timer 3s)');

// Disattiva eventuale timer in corso per non lasciare effetti collaterali.
clearParkingTimer();

// ------------------------------------------------------------
// Riepilogo
// ------------------------------------------------------------
const summary = document.createElement('div');
summary.textContent = `Risultato: ${passed} passati, ${failed} falliti`;
summary.style.fontWeight = 'bold';
summary.style.marginTop = '16px';
summary.style.color = failed === 0 ? '#22d33a' : '#ff3b30';
output.appendChild(summary);
