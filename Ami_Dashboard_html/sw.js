/**
 * sw.js
 * Service Worker della PWA "Ami Dashboard".
 *
 * Strategia di caching:
 *   - App shell (HTML, CSS, JS, immagini locali, icone): CACHE-FIRST.
 *     I file sono messi in cache all'installazione e serviti dalla cache.
 *     Se il file non è in cache, si passa alla rete e il risultato
 *     viene aggiornato in cache per la prossima volta.
 *   - API esterne (Google Maps, Spotify, token Spotify): NETWORK-ONLY.
 *     Non vengono mai cache perché contengono dati dinamici e token
 *     che scadono.
 *
 * Ogni modifica dei file statici deve accompagnare l'incremento di
 * CACHE_VERSION per forzare il ri-caching all'attivazione del SW.
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = `ami-dashboard-shell-${CACHE_VERSION}`;

// File dell'app shell da mettere in cache (prima visita / offline).
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/base.css',
  './css/parking.css',
  './css/driving.css',
  './js/main.js',
  './js/state.js',
  './js/scale.js',
  './js/map.js',
  './js/gps.js',
  './js/spotify.js',
  './js/config.js',
  './js/config.example.js',
  './js/ui/parking.js',
  './js/ui/driving.js',
  './assets/images/ami_front.png',
  './assets/images/ami_rear.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

// Host/API che NON devono mai essere cachati (dati dinamici + token).
const NETWORK_ONLY_HOSTS = [
  'api.spotify.com',
  'accounts.spotify.com',
  'maps.googleapis.com',
  'maps.gstatic.com'
];

function isNetworkOnly(url) {
  try {
    const host = new URL(url).host;
    return NETWORK_ONLY_HOSTS.includes(host);
  } catch (err) {
    return false;
  }
}

/**
 * Evento install: mette in cache l'app shell.
 * Se un singolo asset fallisce, l'intera installazione fallisce
 * (volontario: meglio sapere subito che manca un file).
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()) // attiva subito il nuovo SW
  );
});

/**
 * Evento activate: rimuove le vecchie cache e prende il controllo
 * delle pagine già aperte.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/**
 * Evento fetch:
 *   - API esterne -> sempre dalla rete (NETWORK-ONLY).
 *   - App shell -> dalla cache se disponibile, altrimenti rete.
 */
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Le chiamate alle API (Spotify, Google Maps) vanno sempre in rete.
  if (isNetworkOnly(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell: cache-first con aggiornamento background (stale-while-revalidate semplificato).
  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request)
          .then((networkResponse) => {
            // Non cache response non valide (es. opache, errori).
            if (!networkResponse || networkResponse.status !== 200) {
              return networkResponse;
            }
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, responseToCache));
            return networkResponse;
          });
      })
      .catch(() => {
        // Se siamo offline e non c'è in cache, non possiamo fare molto.
        // Restituisce una risposta vuota per non bloccare il browser.
        return new Response('', { status: 404, statusText: 'Non disponibile offline' });
      })
  );
});
