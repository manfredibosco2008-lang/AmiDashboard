/**
 * js/map.js
 * Integrazione Google Maps JavaScript API per la dashboard Ami.
 *
 * Gestisce:
 *   - Caricamento asincrono della Google Maps JS API (chiave da js/config.js)
 *   - Mappa grande interattiva nella Vista Marcia (x 478-1586, y 0-885)
 *   - Mini-mappa piccola non interattiva nella Vista Parcheggio (x 1325-1586, y 0-340)
 *   - Stile scuro custom (#0e1013 sfondo, strade #2a2d33, acqua #0a0c0f)
 *   - Marker posizione: freccia rossa (#e5171f) che ruota con il heading
 *   - Camera che segue la posizione con zoom ~16 in marcia; ferma in sosta
 *   - Controlli custom: zoom +/-, bussola, fulmine (colonnine ricarica),
 *     ingranaggio (impostazioni km/h-mph e soglia velocità)
 *   - Navigazione: Places Autocomplete, DirectionsService, polilinea #2aa8ff 6px,
 *     card indicazioni con 4 manovre, ricalcolo se >50 m dal percorso,
 *     speechSynthesis in italiano (opzionale)
 *
 * Se la chiave API manca, lascia il segnaposto scuro e scrive un avviso in console.
 * Nessuna chiave API è scritta qui in chiaro: va inserita in js/config.js.
 */

import { config } from './config.js';
import {
  subscribe,
  getState,
  setSpeed,
  emit,
} from './state.js';

// ------------------------------------------------------------
// Configurazione API
// ------------------------------------------------------------
const API_KEY = config.googleMapsApiKey || '';
const API_LIBRARIES = ['places', 'geometry'];
const API_CALLBACK_NAME = '__ami_dashboard_map_init';

let apiLoaded = false;
let apiLoading = false;
let apiReadyCallbacks = [];

// ------------------------------------------------------------
// Stile mappa scuro (JSON)
// ------------------------------------------------------------
const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#0e1013' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a8a92' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0e1013' }] },
  {
    featureType: 'administrative',
    elementType: 'geometry',
    stylers: [{ color: '#1a1c20' }],
  },
  {
    featureType: 'administrative.land_parcel',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#5e626a' }],
  },
  {
    featureType: 'poi',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'poi.park',
    elementType: 'geometry',
    stylers: [{ color: '#141c18' }],
  },
  {
    featureType: 'poi.park',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#6b7a70' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ color: '#2a2d33' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#2a2d33' }],
  },
  {
    featureType: 'road',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#8a8a92' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry',
    stylers: [{ color: '#2a2d33' }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#0a0c0f' }],
  },
  {
    featureType: 'water',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#4a5058' }],
  },
];

// ------------------------------------------------------------
// Riferimenti alle mappe e ai componenti
// ------------------------------------------------------------
let mapDriving = null;   // mappa grande (vista marcia)
let mapParking = null;   // mini-mappa (vista parcheggio)
let mapDrivingReady = false;
let mapParkingReady = false;

// Marker posizione e cerchio precisione
let markerPosition = null;
let circleAccuracy = null;

// Percorso / navigazione
let directionsService = null;
let directionsRenderer = null;
let routePolylineBorder = null; // polilinea scura sotto (bordo)
let routePolyline = null;       // polilinea azzurra sopra
let routeSteps = [];            // array delle manovre
let activeDestination = null;
let isNavigating = false;

// Colonnine di ricarica (Places)
let chargingMarkers = [];
let chargingVisible = false;

// Stato camera
let cameraFollows = true;   // se true la camera segue la posizione
let lastHeading = 0;
let lastPosition = null;    // {lat, lng}
let lastValidSpeedKmh = 0;

// Controlli custom (riferimenti DOM già presenti in index.html)
let ctrlZoomIn = null;
let ctrlZoomOut = null;
let ctrlCompass = null;
let ctrlBolt = null;
let ctrlGear = null;

// Pannello impostazioni (dinamico)
let settingsPanel = null;

// ------------------------------------------------------------
// Caricamento asincrono Google Maps API
// ------------------------------------------------------------

/**
 * Carica la Google Maps JavaScript API in modo asincrono.
 * @param {string} apiKey - Chiave API (da js/config.js)
 */
export function loadGoogleMapsApi(apiKey) {
  if (apiLoaded) {
    onMapsApiReady();
    return;
  }
  if (apiLoading) {
    apiReadyCallbacks.push(onMapsApiReady);
    return;
  }

  apiLoading = true;

  const script = document.createElement('script');
  script.src =
    'https://maps.googleapis.com/maps/api/js?' +
    `key=${encodeURIComponent(apiKey)}&` +
    `libraries=${API_LIBRARIES.join(',')}&` +
    `callback=${API_CALLBACK_NAME}&` +
    'region=IT&language=it';
  script.async = true;
  script.defer = true;
  script.onerror = () => {
    console.error(
      '[map.js] Errore nel caricamento della Google Maps JavaScript API. ' +
      'Verifica la chiave in js/config.js e la connessione di rete.'
    );
    apiLoading = false;
  };
  document.head.appendChild(script);
}

/**
 * Callback globale invocata da Google Maps quando l'API è pronta.
 * Deve essere visibile a window.
 */
window[API_CALLBACK_NAME] = () => {
  apiLoaded = true;
  apiLoading = false;
  onMapsApiReady();
  apiReadyCallbacks.forEach((cb) => cb());
  apiReadyCallbacks = [];
};

/**
 * Esegue l'inizializzazione delle mappe quando l'API è disponibile.
 */
function onMapsApiReady() {
  // Crea le mappe se i container esistono nel DOM
  createDrivingMapIfNeeded();
  createParkingMapIfNeeded();

  // Se siamo già in modalità marcia, assicurati che la mappa grande sia visibile
  if (getState().mode === 'driving') {
    setTimeout(() => {
      if (mapDriving) {
        google.maps.event.trigger(mapDriving, 'resize');
      }
    }, 0);
  }
}

/**
 * Inizializzazione pubblica: avvia il caricamento API se la chiave c'è.
 * Se la chiave manca, lascia il segnaposto scuro e avvisa in console.
 */
export function initMap() {
  if (!API_KEY) {
    console.warn(
      '[map.js] Chiave Google Maps mancante in js/config.js. ' +
      'La mappa resta un segnaposto scuro. ' +
      'Aggiungi la chiave in js/config.js (vedi commenti in fondo al file).'
    );
    return;
  }
  loadGoogleMapsApi(API_KEY);
}

// ------------------------------------------------------------
// Creazione mappe
// ------------------------------------------------------------

function getDrivingContainer() {
  return document.getElementById('map-canvas-driving');
}

function getParkingContainer() {
  return document.getElementById('map-canvas-parking');
}

/**
 * Crea il container della mappa grande (vista marcia) se non esiste,
 * quindi inizializza google.maps.Map.
 */
function createDrivingMapIfNeeded() {
  if (mapDrivingReady || mapDriving) return;

  let container = getDrivingContainer();
  if (!container) {
    // Il container dovrebbe essere inserito da index.html; se manca, lo creo.
    const mapArea = document.getElementById('driving-map');
    if (!mapArea) return;
    container = document.createElement('div');
    container.id = 'map-canvas-driving';
    container.style.cssText =
      'position:absolute; inset:0; width:100%; height:100%; background:#101214; z-index:1;';
    mapArea.appendChild(container);
    // Nascondi il segnaposto SVG se presente
    const placeholder = document.getElementById('map-placeholder');
    if (placeholder) placeholder.style.display = 'none';
  }

  mapDriving = new google.maps.Map(container, {
    center: { lat: 45.4642, lng: 9.1900 }, // Milano (placeholder, verrà aggiornato)
    zoom: 16,
    styles: DARK_MAP_STYLE,
    disableDefaultUI: true,
    gestureHandling: 'greedy',
    clickableIcons: false,
    backgroundColor: '#0e1013',
    controlSize: 24,
    zoomControl: false,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });

  mapDrivingReady = true;
  initDrivingMarker();
  initDrivingControls();
  initNavigationUI();
  bindDrivingModeResize();
}

/**
 * Crea la mini-mappa piccola (vista parcheggio) se non esiste.
 * Non interattiva: nessun controllo, nessun gesto.
 */
function createParkingMapIfNeeded() {
  if (mapParkingReady || mapParking) return;

  let container = getParkingContainer();
  if (!container) {
    const minimapArea = document.getElementById('minimap');
    if (!minimapArea) return;
    container = document.createElement('div');
    container.id = 'map-canvas-parking';
    container.style.cssText =
      'position:absolute; inset:0; width:100%; height:100%; background:#0a0a0c; z-index:1;';
    minimapArea.innerHTML = '';
    minimapArea.appendChild(container);
  }

  mapParking = new google.maps.Map(container, {
    center: { lat: 45.4642, lng: 9.1900 },
    zoom: 13,
    styles: DARK_MAP_STYLE,
    disableDefaultUI: true,
    gestureHandling: 'none',
    clickableIcons: false,
    backgroundColor: '#0a0a0c',
    zoomControl: false,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });

  mapParkingReady = true;
  initParkingMarker();
}

// ------------------------------------------------------------
// Marker posizione (freccia rossa ruotante)
// ------------------------------------------------------------

const ARROW_ICON = {
  path: 'M 0,-4 L 4,4 L 0,1 L -4,4 Z',
  fillColor: '#e5171f',
  fillOpacity: 1,
  strokeColor: '#fff',
  strokeWeight: 1,
  rotation: 0,
  anchor: new google.maps.Point(0, 0),
  scale: 3,
};

function initDrivingMarker() {
  if (!mapDriving) return;
  markerPosition = new google.maps.Marker({
    map: mapDriving,
    icon: ARROW_ICON,
    zIndex: 1000,
    visible: false,
  });

  circleAccuracy = new google.maps.Circle({
    map: mapDriving,
    radius: 0,
    fillColor: '#1e90ff',
    fillOpacity: 0.15,
    strokeColor: '#1e90ff',
    strokeOpacity: 0.4,
    strokeWeight: 1,
    visible: false,
  });
}

function initParkingMarker() {
  if (!mapParking) return;
  markerPosition = new google.maps.Marker({
    map: mapParking,
    icon: ARROW_ICON,
    zIndex: 1000,
    visible: false,
  });
}

/**
 * Aggiorna la posizione visualizzata sulle mappe.
 * Viene chiamato da gps.js (o dalla simulazione debug) con i dati GPS.
 * @param {Object} pos - {lat, lng, heading?, speedKmh?, accuracy?}
 * @param {boolean} isDrivingView - true se la vista attiva è Marcia
 */
export function updatePosition(pos, isDrivingView = false) {
  if (!pos || typeof pos.lat !== 'number' || typeof pos.lng !== 'number') {
    return;
  }

  const latLng = new google.maps.LatLng(pos.lat, pos.lng);
  lastPosition = { lat: pos.lat, lng: pos.lng };
  if (typeof pos.heading === 'number') lastHeading = pos.heading;
  if (typeof pos.speedKmh === 'number') lastValidSpeedKmh = pos.speedKmh;

  // Aggiorna marker su entrambe le mappe
  if (markerPosition) {
    markerPosition.setPosition(latLng);
    markerPosition.setVisible(true);
    if (typeof pos.heading === 'number') {
      markerPosition.setRotation(pos.heading);
    }
  }

  if (circleAccuracy && typeof pos.accuracy === 'number') {
    circleAccuracy.setCenter(latLng);
    circleAccuracy.setRadius(pos.accuracy);
    circleAccuracy.setVisible(true);
  }

  // Mini-mappa parcheggio: centro fisso sull'ultima posizione, nessun follow continuo
  if (mapParking && mapParkingReady) {
    mapParking.setCenter(latLng);
  }

  // Mappa grande: segue solo in marcia e se cameraFollows è true
  if (isDrivingView && mapDriving && mapDrivingReady && cameraFollows) {
    if (lastValidSpeedKmh > 2) {
      mapDriving.setCenter(latLng);
      // Zoom fisso ~16 in marcia
      mapDriving.setZoom(16);
    } else {
      // In sosta: centra senza cambiare zoom in modo brusco
      mapDriving.setCenter(latLng);
    }
  }

  // Ricalcolo percorso se attivo e si discosta > 50 m
  if (isNavigating && routePolyline) {
    checkRouteDeviation(pos.lat, pos.lng);
  }
}

// ------------------------------------------------------------
// Controlli custom (già disegnati in CSS/HTML)
// ------------------------------------------------------------

function initDrivingControls() {
  ctrlZoomIn = document.querySelector('.zoom-btn:nth-child(1)');
  ctrlZoomOut = document.querySelector('.zoom-btn:nth-child(2)');
  ctrlCompass = document.querySelector('.compass');
  ctrlBolt = document.querySelector('.bolt-btn');
  ctrlGear = document.querySelector('.gear-btn');

  if (ctrlZoomIn) {
    ctrlZoomIn.addEventListener('click', () => {
      if (mapDriving) mapDriving.setZoom(mapDriving.getZoom() + 1);
      cameraFollows = false;
    });
  }
  if (ctrlZoomOut) {
    ctrlZoomOut.addEventListener('click', () => {
      if (mapDriving) mapDriving.setZoom(mapDriving.getZoom() - 1);
      cameraFollows = false;
    });
  }
  if (ctrlCompass) {
    ctrlCompass.addEventListener('click', () => {
      if (!mapDriving) return;
      cameraFollows = true;
      // Riorienta a nord (heading 0) e blocca rotazione
      mapDriving.setHeading(0);
      mapDriving.setTilt(0);
    });
  }
  if (ctrlBolt) {
    ctrlBolt.addEventListener('click', toggleChargingStations);
  }
  if (ctrlGear) {
    ctrlGear.addEventListener('click', openSettings);
  }
}

/**
 * Attiva/disattiva la visualizzazione delle colonnine di ricarica vicine
 * usando Places API (electric vehicle charging station).
 */
export function toggleChargingStations() {
  if (!google.maps || !mapDriving || !mapDrivingReady) return;
  chargingVisible = !chargingVisible;

  if (chargingVisible) {
    if (!lastPosition) return;
    const service = new google.maps.places.PlacesService(mapDriving);
    const request = {
      location: new google.maps.LatLng(lastPosition.lat, lastPosition.lng),
      radius: 5000,
      keyword: 'colonnina ricarica elettrica',
      type: ['electric_vehicle_charging_station'],
    };
    service.nearbySearch(request, (results, status) => {
      if (status !== google.maps.places.PlacesServiceStatus.OK || !results) return;
      results.forEach((place) => {
        const m = new google.maps.Marker({
          position: place.geometry.location,
          map: mapDriving,
          icon: {
            path: 'M 0,-6 L 4,4 L 0,2 L -4,4 Z',
            fillColor: '#e5171f',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 1,
            scale: 2.5,
          },
          title: place.name || 'Colonnina ricarica',
          zIndex: 500,
        });
        chargingMarkers.push(m);
      });
    });
  } else {
    chargingMarkers.forEach((m) => m.setMap(null));
    chargingMarkers = [];
  }
}

// ------------------------------------------------------------
// Navigazione
// ------------------------------------------------------------

/**
 * Crea (o recupera) un input Places Autocomplete fluttuante per la destinazione.
 * Viene mostrato sopra la mappa quando si clicca sulla pillola "Naviga".
 */
function ensureAutocompleteInput() {
  if (ui.autocompleteInput) return ui.autocompleteInput;

  const input = document.createElement('input');
  input.id = 'nav-destination-input';
  input.placeholder = 'Cerca destinazione...';
  input.style.cssText =
    'position:absolute; left:520px; top:80px; width:320px; height:36px; ' +
    'background:#17181a; border:1px solid #3a3a3d; border-radius:6px; ' +
    'color:#fff; padding:0 12px; font-size:16px; z-index:50; ' +
    'box-sizing:border-box;';
  input.autocomplete = 'off';
  document.getElementById('stage').appendChild(input);

  ui.autocomplete = new google.maps.places.Autocomplete(input, {
    componentRestrictions: { country: 'it' },
    fields: ['place_id', 'name', 'formatted_address', 'geometry'],
  });

  ui.autocompleteInput = input;
  return input;
}

/**
 * Avvia la navigazione verso una destinazione (testo o place_id).
 * @param {string} destination - Indirizzo o nome luogo
 */
export function startNavigation(destination) {
  if (!google.maps || !mapDriving || !mapDrivingReady) {
    console.warn('[map.js] Google Maps non ancora pronta.');
    return;
  }

  ensureAutocompleteInput();
  const input = ui.autocompleteInput;
  input.style.display = 'block';
  input.focus();
  input.value = destination || '';

  const geocoder = new google.maps.Geocoder();
  geocoder.geocode({ address: destination, region: 'IT' }, (results, status) => {
    if (status !== 'OK' || !results || !results[0]) {
      console.warn('[map.js] Impossibile geocodificare la destinazione.');
      return;
    }

    const dest = results[0].geometry.location;
    activeDestination = {
      lat: dest.lat(),
      lng: dest.lng(),
      name: results[0].formatted_address || destination,
    };

    isNavigating = true;
    cameraFollows = true;

    drawRouteTo(dest);
    showNavigationUI();
  });
}

/**
 * Disegna il percorso con DirectionsService e popola la card indicazioni.
 * @param {google.maps.LatLng} dest
 */
function drawRouteTo(dest) {
  if (!lastPosition) return;

  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({
    map: mapDriving,
    suppressMarkers: true,
    polylineOptions: {
      strokeColor: '#2aa8ff',
      strokeWeight: 6,
      strokeOpacity: 0.9,
    },
  });

  const borderOptions = {
    strokeColor: '#0a0c0f',
    strokeWeight: 10,
    strokeOpacity: 0.6,
  };
  routePolylineBorder = new google.maps.Polyline(borderOptions);
  routePolylineBorder.setMap(mapDriving);

  routePolyline = new google.maps.Polyline({
    strokeColor: '#2aa8ff',
    strokeWeight: 6,
    strokeOpacity: 0.9,
  });
  routePolyline.setMap(mapDriving);

  const request = {
    origin: new google.maps.LatLng(lastPosition.lat, lastPosition.lng),
    destination: dest,
    travelMode: google.maps.TravelMode.DRIVING,
    language: 'it',
  };

  directionsService.route(request, (response, status) => {
    if (status !== google.maps.DirectionsStatus.OK || !response) {
      console.warn('[map.js] DirectionsService fallito:', status);
      return;
    }

    const route = response.routes[0];
    const leg = route.legs[0];

    // Polilinea completa del percorso
    const path = route.overview_path;
    routePolylineBorder.setPath(path);
    routePolyline.setPath(path);

    // DirectionsRenderer per indicazioni visive native (solo polilinea, senza marker)
    directionsRenderer.setDirections(response);

    // Estrai le prime 4 manovre per la card indicazioni
    routeSteps = (leg.steps || []).slice(0, 4).map((step) => ({
      maneuver: step.maneuver || 'straight',
      distance: step.distance ? step.distance.text : '',
      instruction: step.html_instructions || '',
    }));

    populateTurnCard(routeSteps);

    // Footer: distanza totale, durata, ora di arrivo
    const totalDistance = leg.distance ? leg.distance.text : '';
    const totalDuration = leg.duration ? leg.duration.text : '';
    const now = new Date();
    const arrival = new Date(now.getTime() + (leg.duration ? leg.duration.value : 0) * 1000);
    const arrivalStr = arrival.toLocaleTimeString('it-IT', {
      hour: '2-digit',
      minute: '2-digit',
    });

    updateTurnFooter(totalDistance, totalDuration, arrivalStr);

    // Annuncio vocale iniziale
    speak(`Destinazione impostata: ${activeDestination.name}`);
  });
}

/**
 * Popola la card indicazioni con le prossime 4 manovre.
 * @param {Array} steps
 */
function populateTurnCard(steps) {
  const stepEls = document.querySelectorAll('.trip-step');
  const arrowIcons = {
    'turn-right': 'M18 6 12 12 18 18',
    'turn-left': 'M6 6 12 12 6 18',
    'straight': 'M12 6 12 18 M8 10 12 14 M16 10 12 14',
    'slight-right': 'M16 6 12 12 16 18',
    'slight-left': 'M8 6 12 12 8 18',
    'uturn': 'M12 6 12 18 M6 12 12 18 M18 12 12 18',
  };

  steps.forEach((step, i) => {
    const el = stepEls[i];
    if (!el) return;

    const arrowEl = el.querySelector('.step-arrow');
    const distEl = el.querySelector('.step-dist');
    const descEl = el.querySelector('.step-desc');

    if (arrowEl) {
      const d = arrowIcons[step.maneuver] || arrowIcons['straight'];
      arrowEl.innerHTML = `<path d="${d}" fill="none" stroke="${
        step.maneuver.includes('right') ? '#1e90ff' : '#6e6e73'
      }" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`;
    }
    if (distEl) distEl.textContent = step.distance;
    if (descEl) descEl.textContent = step.instruction.replace(/<[^>]*>/g, '') || 'Prosegui';
  });
}

/**
 * Aggiorna il footer della card indicazioni.
 * @param {string} distance
 * @param {string} duration
 * @param {string} arrivalTime
 */
function updateTurnFooter(distance, duration, arrivalTime) {
  const footer = document.querySelector('.trip-footer');
  if (!footer) return;
  const spans = footer.querySelectorAll('span');
  if (spans[0]) spans[0].textContent = distance;
  if (spans[1]) spans[1].textContent = duration;
  if (spans[2]) spans[2].textContent = arrivalTime;
}

/**
 * Mostra l'interfaccia di navigazione (input destinazione visibile).
 */
function showNavigationUI() {
  const pill = document.querySelector('.nav-pill');
  if (pill) pill.style.opacity = '0.6';

  // Evidenzia la card indicazioni
  const card = document.querySelector('.trip-card');
  if (card) card.style.border = '1px solid #3a3a3d';
}

/**
 * Ferma la navigazione e rimuove percorso e marker.
 */
export function stopNavigation() {
  isNavigating = false;
  activeDestination = null;
  routeSteps = [];

  if (directionsRenderer) {
    directionsRenderer.setDirections(null);
    directionsRenderer.setMap(null);
  }
  if (routePolyline) routePolyline.setMap(null);
  if (routePolylineBorder) routePolylineBorder.setMap(null);
  routePolyline = null;
  routePolylineBorder = null;

  // Resetta la card indicazioni allo stato pre-viaggio
  const stepEls = document.querySelectorAll('.trip-step');
  const defaults = [
    { dist: '15 km', desc: 'Uscita 37', arrow: '#1e90ff' },
    { dist: '0,75 km', desc: 'Autostrada A4', arrow: '#6e6e73' },
    { dist: '18 km', desc: 'Via Mansell', arrow: '#6e6e73' },
    { dist: '500 m', desc: 'Colonnina di ricarica', arrow: '#6e6e73' },
  ];
  stepEls.forEach((el, i) => {
    const d = el.querySelector('.step-dist');
    const t = el.querySelector('.step-desc');
    const a = el.querySelector('.step-arrow');
    if (d) d.textContent = defaults[i].dist;
    if (t) t.textContent = defaults[i].desc;
    if (a) {
      a.innerHTML = `<path d="M18 6 12 12 18 18" fill="none" stroke="${defaults[i].arrow}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`;
    }
  });

  const footer = document.querySelector('.trip-footer');
  if (footer) {
    const spans = footer.querySelectorAll('span');
    if (spans[0]) spans[0].textContent = '20,8 km';
    if (spans[1]) spans[1].textContent = '37 min';
    if (spans[2]) spans[2].textContent = '10:58';
  }

  const input = ui.autocompleteInput;
  if (input) input.style.display = 'none';

  const pill = document.querySelector('.nav-pill');
  if (pill) pill.style.opacity = '1';

  const card = document.querySelector('.trip-card');
  if (card) card.style.border = 'none';

  speak('Navigazione terminata.');
}

/**
 * Controlla se la posizione attuale si discosta dal percorso di oltre 50 m.
 * Se sì, richiede un nuovo percorso.
 * @param {number} lat
 * @param {number} lng
 */
function checkRouteDeviation(lat, lng) {
  if (!routePolyline || !google.maps.geometry || !google.maps.geometry.poly) return;

  const current = new google.maps.LatLng(lat, lng);
  const path = routePolyline.getPath();
  const onEdge = google.maps.geometry.poly.isLocationOnEdge(current, path, 0.005); // ~50 m approssimato

  if (!onEdge) {
    // Piccolo debounce per non ricalcolare continuamente
    if (window.__amiRouteRecalcTimer) clearTimeout(window.__amiRouteRecalcTimer);
    window.__amiRouteRecalcTimer = setTimeout(() => {
      if (activeDestination) {
        const dest = new google.maps.LatLng(
          activeDestination.lat,
          activeDestination.lng
        );
        drawRouteTo(dest);
      }
    }, 3000);
  }
}

// ------------------------------------------------------------
// Voce (speechSynthesis in italiano)
// ------------------------------------------------------------

let speechUtterance = null;

/**
 * Legge un testo con speechSynthesis in italiano, se disponibile.
 * @param {string} text
 */
export function speak(text) {
  if (!text || !window.speechSynthesis) return;

  // Interrompe l'annuncio precedente
  if (speechUtterance) {
    window.speechSynthesis.cancel();
  }

  speechUtterance = new SpeechSynthesisUtterance(text);
  speechUtterance.lang = 'it-IT';
  speechUtterance.rate = 1;
  speechUtterance.pitch = 1;

  // Cerca voce italiana se disponibile
  const voices = window.speechSynthesis.getVoices();
  const itVoice = voices.find((v) => v.lang.startsWith('it'));
  if (itVoice) speechUtterance.voice = itVoice;

  window.speechSynthesis.speak(speechUtterance);
}

/**
 * Attiva/disattiva gli annunci vocali durante la navigazione.
 * @param {boolean} enabled
 */
export function setSpeechEnabled(enabled) {
  navigation.speechEnabled = enabled;
  if (!enabled && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

// ------------------------------------------------------------
// Pannello impostazioni (km/h - mph, soglia velocità)
// ------------------------------------------------------------

export function openSettings() {
  if (settingsPanel) {
    settingsPanel.style.display = 'block';
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'map-settings-panel';
  panel.style.cssText =
    'position:absolute; left:520px; top:150px; width:300px; ' +
    'background:#17181a; border:1px solid #3a3a3d; border-radius:8px; ' +
    'padding:16px; color:#fff; z-index:60; box-sizing:border-box;';
  panel.innerHTML = `
    <div style="font-size:16px; font-weight:600; margin-bottom:14px;">Impostazioni</div>
    <div style="font-size:13px; color:#b5b5b9; margin-bottom:10px;">Unità velocità</div>
    <label style="display:flex; justify-content:space-between; font-size:14px; margin-bottom:8px;">
      <span>km/h</span>
      <select id="setting-unit" style="background:#0e1013; color:#fff; border:1px solid #3a3a3d; border-radius:4px; padding:4px;">
        <option value="kmh">km/h</option>
        <option value="mph">mph</option>
      </select>
    </label>
    <div style="font-size:13px; color:#b5b5b9; margin-bottom:10px;">Soglia avviso velocità</div>
    <input id="setting-threshold" type="number" value="30" min="0" max="200" step="5" style="width:60px; background:#0e1013; color:#fff; border:1px solid #3a3a3d; border-radius:4px; padding:4px; font-size:14px;">
    <span id="setting-unit-label" style="margin-left:8px; font-size:13px; color:#b5b5b9;">km/h</span>
    <div style="margin-top:14px; display:flex; gap:8px; justify-content:flex-end;">
      <button id="setting-close" style="background:#333; color:#fff; border:1px solid #555; padding:6px 14px; border-radius:6px; cursor:pointer;">Chiudi</button>
    </div>
  `;

  document.getElementById('stage').appendChild(panel);
  settingsPanel = panel;

  const unitSelect = panel.querySelector('#setting-unit');
  const thresholdInput = panel.querySelector('#setting-threshold');
  const unitLabel = panel.querySelector('#setting-unit-label');
  const closeBtn = panel.querySelector('#setting-close');

  unitSelect.addEventListener('change', (e) => {
    const unit = e.target.value;
    emit('speedUnit', unit); // stato centrale, se usato da driving.js
    unitLabel.textContent = unit === 'mph' ? 'mph' : 'km/h';
  });

  thresholdInput.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10) || 30;
    emit('speedThreshold', val);
  });

  closeBtn.addEventListener('click', closeSettings);
}

export function closeSettings() {
  if (settingsPanel) {
    settingsPanel.style.display = 'none';
  }
}

// ------------------------------------------------------------
// Listener UI (pillola Naviga, tasto Annulla viaggio)
// ------------------------------------------------------------

function initNavigationUI() {
  const pill = document.querySelector('.nav-pill');
  if (pill) {
    pill.addEventListener('click', () => {
      const input = ensureAutocompleteInput();
      input.style.display = 'block';
      input.focus();
      input.value = '';
    });
  }

  const cancelBtn = document.querySelector('.cancel-trip');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', stopNavigation);
  }
}

// ------------------------------------------------------------
// Binding cambio vista (resize mappa quando diventa visibile)
// ------------------------------------------------------------

function bindDrivingModeResize() {
  subscribe('mode', (newMode) => {
    if (newMode === 'driving' && mapDriving && mapDrivingReady) {
      setTimeout(() => {
        google.maps.event.trigger(mapDriving, 'resize');
        if (lastPosition) {
          mapDriving.setCenter(new google.maps.LatLng(lastPosition.lat, lastPosition.lng));
        }
      }, 0);
    }
  });
}

// ------------------------------------------------------------
// Pulizia
// ------------------------------------------------------------

export function destroyMap() {
  if (mapDriving) {
    mapDriving = null;
    mapDrivingReady = false;
  }
  if (mapParking) {
    mapParking = null;
    mapParkingReady = false;
  }
  markerPosition = null;
  circleAccuracy = null;
  stopNavigation();
}
