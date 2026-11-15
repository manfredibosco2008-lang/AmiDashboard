/**
 * config.js
 * Configurazione dell'applicazione.
 * Nessuna chiave API viene scritta qui in produzione: i valori sono
 * esempi vuoti da compilare. Vedere config.example.js per il template.
 */

export const config = {
  // Google Maps / Maps JavaScript API
  googleMapsApiKey: 'AIzaSyCVU933DHBbFsJVtdUP3WmRhcqAEdT2h6Q',

  // Spotify Web API
  spotifyClientId: '54da8016c0eb4b13907a7c351feab7cb',
  spotifyRedirectUri: 'https://manfredibosco2008-lang.github.io/AmiDashboard/
',

  // Soglia di attivazione vista marcia (km/h)
  drivingThresholdKmh: 2,

  // Durata transizione dissolvenza tra viste (ms)
  viewTransitionMs: 400,
};
