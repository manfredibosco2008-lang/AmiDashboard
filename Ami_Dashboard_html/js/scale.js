/**
 * scale.js
 * Gestisce il ridimensionamento dello "stage" fisso 1586x992 px.
 * Lo stage viene scalato con transform: scale(s) e centrato, dove
 * s = min(window.innerWidth / 1586, window.innerHeight / 992).
 * Le bande vuote laterali/verticali sono nere.
 * Il risultato è identico su qualsiasi tablet.
 */

const STAGE_W = 1586;
const STAGE_H = 992;

const stage = document.getElementById('stage');

/**
 * Calcola il fattore di scala e lo applica allo stage.
 * Viene chiamato all'avvio, al resize e al cambio di orientamento.
 */
export function updateScale() {
  const s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);

  // Centriamo lo stage con translate e lo scaliamo.
  // L'origine di trasformazione è l'angolo in alto a sinistra.
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  stage.style.left = '50%';
  stage.style.top = '50%';
  stage.style.width = `${STAGE_W}px`;
  stage.style.height = `${STAGE_H}px`;
}

// Inizializzazione immediata al caricamento del modulo.
updateScale();

// Ricalcolo su resize e cambio orientamento.
window.addEventListener('resize', updateScale);
window.addEventListener('orientationchange', () => {
  // Piccolo ritardo per permettere al browser di aggiornare innerWidth/innerHeight.
  requestAnimationFrame(updateScale);
});
