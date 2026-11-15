/**
 * js/spotify.js
 * Controllo di Spotify tramite Web API (nessun SDK nativo).
 *
 * Flusso di autenticazione:
 *   - Authorization Code + PKCE (Proof Key for Code Exchange)
 *   - Nessun client secret nel codice (client pubblico)
 *   - Client ID e Redirect URI letti da js/config.js
 *   - Access token e refresh token salvati in localStorage con rinnovo automatico
 *
 * Scope richiesti:
 *   user-read-playback-state, user-modify-playback-state,
 *   user-read-currently-playing, user-library-read, user-library-modify
 *
 * Funzionalità:
 *   - Login "Collega Spotify" (pulsante mostrato nel mini-player al primo avvio)
 *   - Polling ogni 3 s su GET /v1/me/player (titolo, artista, album,
 *     copertina, progresso, tempo residuo, play/pausa, shuffle, repeat)
 *   - Comandi: play/pausa, precedente, successiva, shuffle, repeat,
 *     ricerca (GET /v1/search) e avvio brano, cuore (preferiti)
 *   - Gestione errori: nessun dispositivo attivo, account non Premium (403),
 *     token scaduto, rete assente
 *   - I dati alimentano sia la card Spotify (vista Parcheggio) sia il
 *     mini-player (vista Marcia); la barra di progresso avanza in locale
 *     tra una lettura e l'altra
 *
 * NOTA: Spotify deve essere installato e aperto sul tablet perché i
 * comandi di riproduzione agiscano su un dispositivo reale.
 */

import { emit } from './state.js';
import { config } from './config.js';

// ====================================================================
// Configurazione (valori da js/config.js, niente chiavi hardcodate)
// ====================================================================
const CLIENT_ID = config.spotifyClientId || '';
const REDIRECT_URI = config.spotifyRedirectUri || '';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-library-read',
  'user-library-modify',
].join(' ');

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

const POLL_INTERVAL_MS = 3000;
const TOKEN_EXPIRY_MARGIN_MS = 60000; // rinnova 1 minuto prima della scadenza

// Chiavi di localStorage
const LS_ACCESS_TOKEN = 'ami_spotify_access_token';
const LS_REFRESH_TOKEN = 'ami_spotify_refresh_token';
const LS_TOKEN_EXPIRY = 'ami_spotify_token_expiry';
const LS_CODE_VERIFIER = 'ami_spotify_code_verifier';

// ====================================================================
// Stato interno del modulo
// ====================================================================
let accessToken = null;
let refreshToken = null;
let tokenExpiry = 0;

let pollingTimer = null;
let isPolling = false;
let isOnline = typeof navigator !== 'undefined' && navigator.onLine !== false;
let networkListenersBound = false;

let currentTrackId = null;   // ID brano attuale (stato cuore)
let isLiked = false;         // se il brano attuale è nei preferiti
let lastProgressMs = 0;      // progresso ultima lettura (ms)
let lastProgressTimestamp = 0; // timestamp ultima lettura
let isPlayingLocally = false; // se in play (per avanzare barra in locale)
let lastPlayerState = null;  // ultimo stato letto (getter pubblico)

// Riferimenti DOM (cerrati/creati al primo uso)
let connectBtn = null;
let noDeviceBanner = null;
let errorBanner = null;
let searchField = null;
let searchResults = null;

// ====================================================================
// Utilità PKCE
// ====================================================================

/**
 * Genera una stringa casuale per il code verifier (PKCE).
 * @returns {string}
 */
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(array);
  } else {
    for (let i = 0; i < 32; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
  }
  return base64UrlEncode(array);
}

/**
 * Codifica in base64url senza padding.
 * @param {Uint8Array} data
 * @returns {string}
 */
function base64UrlEncode(data) {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Calcola la SHA-256 del code verifier per ottenere il code challenge (PKCE).
 * @param {string} verifier
 * @returns {Promise<string>} code challenge base64url
 */
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

// ====================================================================
// Gestione token (localStorage)
// ====================================================================

function saveTokens(access, refresh, expiresInSeconds) {
  const expiry = Date.now() + expiresInSeconds * 1000;
  localStorage.setItem(LS_ACCESS_TOKEN, access);
  if (refresh) {
    localStorage.setItem(LS_REFRESH_TOKEN, refresh);
  }
  localStorage.setItem(LS_TOKEN_EXPIRY, expiry.toString());
  accessToken = access;
  refreshToken = refresh;
  tokenExpiry = expiry;
}

function loadTokens() {
  accessToken = localStorage.getItem(LS_ACCESS_TOKEN) || null;
  refreshToken = localStorage.getItem(LS_REFRESH_TOKEN) || null;
  const expiry = localStorage.getItem(LS_TOKEN_EXPIRY);
  tokenExpiry = expiry ? parseInt(expiry, 10) : 0;
}

function clearTokens() {
  localStorage.removeItem(LS_ACCESS_TOKEN);
  localStorage.removeItem(LS_REFRESH_TOKEN);
  localStorage.removeItem(LS_TOKEN_EXPIRY);
  localStorage.removeItem(LS_CODE_VERIFIER);
  accessToken = null;
  refreshToken = null;
  tokenExpiry = 0;
}

function isTokenExpired() {
  if (!tokenExpiry) return true;
  return Date.now() >= tokenExpiry - TOKEN_EXPIRY_MARGIN_MS;
}

/**
 * Restituisce true se c'è un access token valido (non scaduto).
 * @returns {boolean}
 */
export function isSpotifyConnected() {
  return !!accessToken && !isTokenExpired();
}

// ====================================================================
// Autenticazione (Authorization Code + PKCE)
// ====================================================================

/**
 * Verifica che il Redirect URI sia HTTPS (obbligatorio su Spotify,
 * eccetto localhost).
 * @returns {boolean}
 */
function redirectUriValido() {
  if (!REDIRECT_URI) return false;
  try {
    const url = new URL(REDIRECT_URI);
    return url.protocol === 'https:' || url.hostname === 'localhost';
  } catch (err) {
    return false;
  }
}

/**
 * Avvia il flusso di autorizzazione Spotify: reindirizza l'utente
 * su accounts.spotify.com per login e consenso.
 */
export function loginSpotify() {
  if (!CLIENT_ID) {
    showError('Configura il Client ID Spotify in js/config.js.');
    return;
  }
  if (!REDIRECT_URI) {
    showError('Configura il Redirect URI Spotify in js/config.js.');
    return;
  }
  if (!redirectUriValido()) {
    showError('Il Redirect URI Spotify deve essere HTTPS (es. https://tuodominio.it/callback).');
    return;
  }

  const verifier = generateCodeVerifier();
  localStorage.setItem(LS_CODE_VERIFIER, verifier);

  generateCodeChallenge(verifier).then((codeChallenge) => {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
      show_dialog: 'true',
    });
    window.location.href = `${AUTHORIZE_URL}?${params.toString()}`;
  });
}

/**
 * Gestisce il callback di autorizzazione: se l'URL contiene ?code=,
 * scambia il codice per i token e li salva.
 * Da chiamare all'avvio dell'app.
 */
export function handleSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');

  if (error) {
    console.warn('[spotify.js] Errore autorizzazione Spotify:', error);
    showError('Autorizzazione Spotify negata.');
    // Pulisce l'URL dai parametri di errore
    window.history.replaceState({}, document.title, window.location.pathname);
    return;
  }

  if (!code) {
    return; // non siamo sul callback
  }

  const verifier = localStorage.getItem(LS_CODE_VERIFIER);
  if (!verifier) {
    console.warn('[spotify.js] Code verifier mancante.');
    return;
  }

  exchangeCodeForTokens(code, verifier)
    .then(() => {
      window.history.replaceState({}, document.title, window.location.pathname);
      startPolling();
      updateConnectButtonVisibility();
    })
    .catch((err) => {
      console.error('[spotify.js] Errore scambio codice:', err);
      showError('Impossibile completare il collegamento Spotify.');
    });
}

/**
 * Scambia il codice di autorizzazione per access_token e refresh_token.
 * (Nessun client secret: pubblico client PKCE.)
 * @param {string} code
 * @param {string} verifier
 * @returns {Promise}
 */
function exchangeCodeForTokens(code, verifier) {
  return fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`Token exchange failed: ${r.status}`);
      return r.json();
    })
    .then((data) => {
      if (data.access_token) {
        saveTokens(data.access_token, data.refresh_token, data.expires_in);
      } else {
        throw new Error('Nessun access token ricevuto');
      }
    });
}

/**
 * Rinnova l'access token usando il refresh token.
 * @returns {Promise<string>} nuovo access token
 */
async function refreshAccessToken() {
  if (!refreshToken) {
    throw new Error('Nessun refresh token disponibile');
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    // Refresh token non più valido: bisogna ricollegare l'account
    clearTokens();
    throw new Error('Refresh token scaduto o revocato');
  }

  const data = await response.json();
  saveTokens(data.access_token, data.refresh_token || refreshToken, data.expires_in);
  return data.access_token;
}

/**
 * Ottiene un access token valido, rinnovandolo se necessario.
 * @returns {Promise<string|null>}
 */
async function getValidAccessToken() {
  if (!accessToken) return null;
  if (isTokenExpired()) {
    await refreshAccessToken();
  }
  return accessToken;
}

// ====================================================================
// Richieste API Spotify
// ====================================================================

/**
 * Effettua una richiesta all'API Spotify con gestione automatica del token.
 * @param {string} path - percorso API (es. /v1/me/player)
 * @param {object} opts - opzioni fetch
 * @returns {Promise<Response>}
 */
async function spotifyRequest(path, opts = {}) {
  const token = await getValidAccessToken();
  if (!token) {
    throw new Error('Non autenticato su Spotify');
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...opts.headers,
  };

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...opts,
      headers,
    });
  } catch (err) {
    throw new Error('NETWORK_ERROR');
  }

  // Se 401, prova a rinnovare il token e ripeti una volta
  if (response.status === 401) {
    try {
      await refreshAccessToken();
    } catch (err) {
      throw new Error('Token scaduto');
    }
    const newToken = await getValidAccessToken();
    headers.Authorization = `Bearer ${newToken}`;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...opts,
        headers,
      });
    } catch (err) {
      throw new Error('NETWORK_ERROR');
    }
  }

  return response;
}

// ====================================================================
// Stato di riproduzione (polling)
// ====================================================================

/**
 * Legge lo stato attuale di riproduzione da Spotify.
 * @returns {Promise<object|null>}
 */
export async function fetchPlayerState() {
  if (!isOnline) {
    showError('Rete assente. Verifica la connessione del tablet.');
    return null;
  }

  try {
    const response = await spotifyRequest('/v1/me/player');

    // 204 = nessun contenuto (nessuna riproduzione attiva)
    if (response.status === 204) {
      lastPlayerState = {
        isPlaying: false,
        track: null,
        device: null,
        progressMs: 0,
        shuffle: false,
        repeat: 'off',
        volume: null,
      };
      updateNoDeviceBanner(true);
      return lastPlayerState;
    }

    if (response.status === 403) {
      showError('Account Spotify non Premium: i comandi di riproduzione richiedono Premium.');
      return null;
    }

    if (!response.ok) {
      throw new Error(`Errore API Spotify: ${response.status}`);
    }

    const data = await response.json();

    // Aggiorna stato like del brano attuale
    if (data.item && data.item.id) {
      if (currentTrackId !== data.item.id) {
        currentTrackId = data.item.id;
        await checkTrackLiked(data.item.id);
      }
    }

    // Aggiorna progresso locale per avanzamento tra le letture
    isPlayingLocally = !!data.is_playing;
    if (data.progress_ms !== undefined) {
      lastProgressMs = data.progress_ms;
      lastProgressTimestamp = Date.now();
    }

    // Dispositivo attivo?
    const device = data.device || null;
    updateNoDeviceBanner(!device || data.device.is_restricted);

    lastPlayerState = {
      isPlaying: !!data.is_playing,
      track: data.item || null,
      device: device,
      progressMs: data.progress_ms || 0,
      shuffle: !!data.shuffle_state,
      repeat: data.repeat_state, // 'off', 'track', 'context'
      volume: device ? device.volume_percent : null,
    };
    return lastPlayerState;
  } catch (err) {
    console.warn('[spotify.js] Errore lettura stato giocatore:', err.message);

    if (err.message === 'NETWORK_ERROR') {
      isOnline = false;
      showError('Rete assente. Verifica la connessione del tablet.');
      return null;
    }

    if (err.message.includes('Non autenticato') || err.message === 'Token scaduto') {
      clearTokens();
      updateConnectButtonVisibility();
      return null;
    }

    if (err.message && err.message.includes('404')) {
      // Nessun dispositivo attivo
      updateNoDeviceBanner(true);
      return null;
    }

    return null;
  }
}

/**
 * Calcola il progresso stimato attuale avanzando in locale
 * dall'ultima lettura ricevuta.
 * @returns {number} ms di progresso stimati
 */
function getEstimatedProgressMs() {
  if (!isPlayingLocally || !lastProgressTimestamp) {
    return lastProgressMs;
  }
  const elapsed = Date.now() - lastProgressTimestamp;
  return lastProgressMs + elapsed;
}

/**
 * Aggiorna tutti gli elementi UI del giocatore (card parcheggio +
 * mini-player marcia).
 * @param {object} state
 */
function updateUI(state) {
  const track = state.track;
  const progressMs = getEstimatedProgressMs();

  // -------------------- Mini-player (vista Marcia) --------------------
  const miniCover = document.querySelector('.cover');
  const miniTitle = document.querySelector('.track-title');
  const miniArtist = document.querySelector('.track-artist');
  const miniAlbum = document.querySelector('.track-album');
  const miniProgressFill = document.querySelector('.progress-fill');
  const miniTimeLeft = document.querySelector('.time-left');
  const miniPlayBtn = document.querySelector('.ctrl-play');
  const miniHeartBtn = document.querySelector('.heart-outline');

  if (miniCover) {
    const url = track && track.album && track.album.images && track.album.images[0]
      ? track.album.images[0].url
      : '';
    miniCover.style.backgroundImage = url ? `url(${url})` : 'none';
    miniCover.style.backgroundSize = 'cover';
    miniCover.style.backgroundPosition = 'center';
  }
  if (miniTitle) miniTitle.textContent = track ? track.name : '';
  if (miniArtist && track && track.artists && track.artists[0]) {
    miniArtist.textContent = track.artists[0].name;
  } else if (miniArtist) {
    miniArtist.textContent = '';
  }
  if (miniAlbum && track && track.album) {
    miniAlbum.textContent = track.album.name;
  } else if (miniAlbum) {
    miniAlbum.textContent = '';
  }

  // Barra progresso
  if (miniProgressFill && track) {
    const durationMs = track.duration_ms || 0;
    const pct = durationMs > 0 ? (progressMs / durationMs) * 100 : 0;
    miniProgressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  } else if (miniProgressFill) {
    miniProgressFill.style.width = '0%';
  }

  // Tempo residuo (-m:ss)
  if (miniTimeLeft && track) {
    const remaining = Math.max(0, Math.ceil((track.duration_ms - progressMs) / 1000));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    miniTimeLeft.textContent = `-${m}:${String(s).padStart(2, '0')}`;
  } else if (miniTimeLeft) {
    miniTimeLeft.textContent = '';
  }

  // Play/Pausa
  if (miniPlayBtn) {
    miniPlayBtn.innerHTML = state.isPlaying
      ? '<rect x="8" y="4" width="4" height="16" /><rect x="12" y="4" width="4" height="16" />'
      : '<polygon points="8,2 8,22 16,12" />';
  }

  // Cuore
  if (miniHeartBtn) {
    miniHeartBtn.classList.toggle('liked', isLiked);
    miniHeartBtn.setAttribute('aria-pressed', isLiked ? 'true' : 'false');
  }

  // -------------------- Card Spotify (vista Parcheggio) ---------------
  const parkCover = document.querySelector('.spotify-cover');
  const parkTitle = document.querySelector('.spotify-title');
  const parkArtist = document.querySelector('.spotify-artist');
  const parkProgressFill = document.querySelector('.spotify-progress-fill');

  if (parkCover) {
    const url = track && track.album && track.album.images && track.album.images[0]
      ? track.album.images[0].url
      : '';
    parkCover.style.backgroundImage = url ? `url(${url})` : 'none';
    parkCover.style.backgroundSize = 'cover';
    parkCover.style.backgroundPosition = 'center';
  }
  if (parkTitle) parkTitle.textContent = track ? track.name : '';
  if (parkArtist && track && track.artists && track.artists[0]) {
    parkArtist.textContent = track.artists[0].name;
  } else if (parkArtist) {
    parkArtist.textContent = '';
  }
  if (parkProgressFill && track) {
    const durationMs = track.duration_ms || 0;
    const pct = durationMs > 0 ? (progressMs / durationMs) * 100 : 0;
    parkProgressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  } else if (parkProgressFill) {
    parkProgressFill.style.width = '0%';
  }

  // Aggiorna anche i secondi cuori (parking card usa .ctrl-heart)
  const parkHeartBtn = document.querySelector('.ctrl-heart');
  if (parkHeartBtn) {
    parkHeartBtn.classList.toggle('liked', isLiked);
    parkHeartBtn.setAttribute('aria-pressed', isLiked ? 'true' : 'false');
  }

  // Emette evento per altri moduli
  emit('spotifyState', {
    isPlaying: state.isPlaying,
    shuffle: state.shuffle,
    repeat: state.repeat,
    track: track,
    device: state.device,
  });
}

/**
 * Restituisce l'ultimo stato letto da Spotify.
 * @returns {object|null}
 */
export function getSpotifyState() {
  return lastPlayerState;
}

/**
 * Avvia il polling periodico dello stato Spotify.
 */
function startPolling() {
  if (isPolling) return;
  isPolling = true;
  pollingTimer = setInterval(async () => {
    const state = await fetchPlayerState();
    if (state) updateUI(state);
  }, POLL_INTERVAL_MS);
  // Prima esecuzione immediata
  fetchPlayerState().then((state) => {
    if (state) updateUI(state);
  });
}

/**
 * Ferma il polling.
 */
function stopPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = null;
  isPolling = false;
}

// ====================================================================
// Comandi di riproduzione
// ====================================================================

/**
 * Play / Pausa.
 */
export async function playPause() {
  const state = await fetchPlayerState();
  if (!state) return;

  try {
    if (state.isPlaying) {
      await spotifyRequest('/v1/me/player/pause', { method: 'PUT' });
    } else {
      await spotifyRequest('/v1/me/player/play', { method: 'PUT' });
    }
  } catch (err) {
    handleCommandError(err);
    return;
  }
  // Aggiornamento immediato UI (non aspetta il polling)
  setTimeout(() => {
    fetchPlayerState().then((s) => s && updateUI(s));
  }, 600);
}

/**
 * Brano precedente.
 */
export async function previousTrack() {
  try {
    await spotifyRequest('/v1/me/player/previous', { method: 'POST' });
  } catch (err) {
    handleCommandError(err);
    return;
  }
  setTimeout(() => {
    fetchPlayerState().then((s) => s && updateUI(s));
  }, 600);
}

/**
 * Brano successivo.
 */
export async function nextTrack() {
  try {
    await spotifyRequest('/v1/me/player/next', { method: 'POST' });
  } catch (err) {
    handleCommandError(err);
    return;
  }
  setTimeout(() => {
    fetchPlayerState().then((s) => s && updateUI(s));
  }, 600);
}

/**
 * Attiva/disattiva shuffle.
 * @param {boolean} enable
 */
export async function setShuffle(enable) {
  try {
    await spotifyRequest(`/v1/me/player/shuffle?state=${enable}`, { method: 'PUT' });
  } catch (err) {
    handleCommandError(err);
  }
}

/**
 * Imposta modalità repeat.
 * @param {string} state - 'off' | 'track' | 'context'
 */
export async function setRepeat(state) {
  try {
    await spotifyRequest(`/v1/me/player/repeat?state=${state}`, { method: 'PUT' });
  } catch (err) {
    handleCommandError(err);
  }
}

/**
 * Cerca brani tramite GET /v1/search e mostra i risultati.
 * @param {string} query
 */
export async function searchTracks(query) {
  if (!query) return;
  try {
    const response = await spotifyRequest(
      `/v1/search?type=track&market=IT&limit=10&q=${encodeURIComponent(query)}`
    );
    if (!response.ok) return;
    const data = await response.json();
    showSearchResults(data.tracks || data);
  } catch (err) {
    console.warn('[spotify.js] Errore ricerca:', err.message);
    if (err.message === 'NETWORK_ERROR') {
      showError('Rete assente. Verifica la connessione del tablet.');
    }
  }
}

/**
 * Apre il campo di ricerca (vuoto) e lo mette a fuoco.
 */
export function openSearch() {
  ensureSearchUI();
  if (searchField) {
    searchField.style.display = 'block';
    searchResults.style.display = 'none';
    searchField.value = '';
    searchField.focus();
  }
}

/**
 * Chiude il campo di ricerca.
 */
export function closeSearch() {
  if (searchField) searchField.style.display = 'none';
  if (searchResults) searchResults.style.display = 'none';
}

/**
 * Crea (una sola volta) il campo di ricerca fluttuante e la lista
 * risultati, se non già presenti nel DOM.
 */
function ensureSearchUI() {
  if (searchField) return;

  searchField = document.createElement('input');
  searchField.id = 'spotify-search';
  searchField.placeholder = 'Cerca brano su Spotify...';
  searchField.style.cssText =
    'position:fixed; right:20px; top:95px; width:260px; height:34px; ' +
    'background:#17181a; border:1px solid #3a3a3d; border-radius:6px; ' +
    'color:#fff; padding:0 12px; font-size:14px; z-index:60; ' +
    'box-sizing:border-box; display:none; outline:none;';
  document.body.appendChild(searchField);

  searchResults = document.createElement('div');
  searchResults.id = 'spotify-search-results';
  searchResults.style.cssText =
    'position:fixed; right:20px; top:131px; width:260px; max-height:260px; ' +
    'background:#17181a; border:1px solid #3a3a3d; border-radius:0 0 6px 6px; ' +
    'overflow-y:auto; z-index:60; display:none; box-sizing:border-box;';
  document.body.appendChild(searchResults);

  searchField.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    if (q.length > 2) {
      searchTracks(q);
    } else {
      searchResults.style.display = 'none';
    }
  });
  searchField.addEventListener('blur', () => {
    setTimeout(() => { searchResults.style.display = 'none'; }, 200);
  });
  searchField.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearch();
  });
}

/**
 * Mostra i risultati di ricerca nella lista fluttuante.
 * @param {object} results
 */
function showSearchResults(results) {
  ensureSearchUI();
  const items = results.items || [];
  searchResults.innerHTML = '';
  searchResults.style.display = 'block';
  searchField.style.display = 'block';
  searchField.focus();

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:8px 12px; color:#9b9b9f; font-size:13px;';
    empty.textContent = 'Nessun risultato';
    searchResults.appendChild(empty);
    return;
  }

  items.forEach((track) => {
    const div = document.createElement('div');
    div.style.cssText =
      'padding:10px 12px; color:#fff; font-size:14px; cursor:pointer; ' +
      'border-bottom:1px solid #222;';
    div.innerHTML = `
      <strong>${track.name}</strong><br>
      <span style="color:#9b9b9f; font-size:12px;">${track.artists.map((a) => a.name).join(', ')}</span>
    `;
    div.addEventListener('click', () => {
      playTrackUri(track.uri);
      closeSearch();
    });
    searchResults.appendChild(div);
  });
}

/**
 * Avvia la riproduzione di un brano specifico (URI o ID).
 * @param {string} uriOrId
 */
export async function playTrackUri(uriOrId) {
  let uri = uriOrId;
  if (!uri.startsWith('spotify:track:')) {
    uri = `spotify:track:${uriOrId}`;
  }
  try {
    await spotifyRequest('/v1/me/player/play', {
      method: 'PUT',
      body: JSON.stringify({ uris: [uri] }),
    });
    setTimeout(() => {
      fetchPlayerState().then((s) => s && updateUI(s));
    }, 800);
  } catch (err) {
    handleCommandError(err);
  }
}

/**
 * Toggle like (salva/rimuovi dai preferiti) del brano attuale.
 */
export async function toggleLike() {
  if (!currentTrackId) return;
  try {
    if (isLiked) {
      await spotifyRequest(`/v1/me/tracks?ids=${currentTrackId}`, { method: 'DELETE' });
    } else {
      await spotifyRequest(`/v1/me/tracks?ids=${currentTrackId}`, { method: 'PUT' });
    }
    isLiked = !isLiked;
    updateHeartsUI();
  } catch (err) {
    console.warn('[spotify.js] Errore toggle like:', err.message);
    if (err.message === 'NETWORK_ERROR') {
      showError('Rete assente. Verifica la connessione del tablet.');
    }
  }
}

/**
 * Aggiorna l'aspetto di tutti i bottoni cuore in base a isLiked.
 */
function updateHeartsUI() {
  const miniHeartBtn = document.querySelector('.heart-outline');
  const parkHeartBtn = document.querySelector('.ctrl-heart');
  [miniHeartBtn, parkHeartBtn].forEach((btn) => {
    if (btn) {
      btn.classList.toggle('liked', isLiked);
      btn.setAttribute('aria-pressed', isLiked ? 'true' : 'false');
    }
  });
}

/**
 * Verifica se il brano attuale è nei preferiti dell'utente.
 * @param {string} trackId
 */
async function checkTrackLiked(trackId) {
  try {
    const response = await spotifyRequest(`/v1/me/tracks/contains?ids=${trackId}`);
    if (response.ok) {
      const data = await response.json();
      isLiked = data && data[0] === true;
      updateHeartsUI();
    }
  } catch (err) {
    console.warn('[spotify.js] Errore controllo like:', err.message);
  }
}

/**
 * Gestisce gli errori comuni dei comandi di riproduzione.
 * @param {Error} err
 */
function handleCommandError(err) {
  if (err.message === 'NETWORK_ERROR') {
    showError('Rete assente. Verifica la connessione del tablet.');
    return;
  }
  if (err.message.includes('403')) {
    showError('Spotify Premium richiesto: questo account non può comandare la riproduzione.');
    return;
  }
  if (err.message.includes('404') || err.message.includes('no active device')) {
    showError('Nessun dispositivo Spotify attivo. Apri Spotify sul tablet.');
    updateNoDeviceBanner(true);
    return;
  }
  if (err.message.includes('Non autenticato') || err.message === 'Token scaduto') {
    clearTokens();
    updateConnectButtonVisibility();
    showError('Sessione scaduta: clicca "Collega Spotify" per ricollegare l\'account.');
    return;
  }
  console.warn('[spotify.js] Errore comando Spotify:', err.message);
}

// ====================================================================
// Banner di errore e stato dispositivo
// ====================================================================

/**
 * Mostra un banner di errore temporaneo (5 secondi).
 * @param {string} message
 */
function showError(message) {
  if (errorBanner) {
    errorBanner.textContent = message;
    errorBanner.classList.remove('hidden');
    clearTimeout(errorBanner.hideTimer);
    errorBanner.hideTimer = setTimeout(() => errorBanner.classList.add('hidden'), 5000);
    return;
  }

  const banner = document.createElement('div');
  banner.id = 'spotify-error-banner';
  banner.className = 'spotify-error-banner';
  banner.style.cssText =
    'position:fixed; top:45px; left:50%; transform:translateX(-50%); ' +
    'background:#e5171f; color:#fff; padding:8px 16px; font-size:13px; ' +
    'border-radius:6px; z-index:1000; box-sizing:border-box; ' +
    'max-width:90%; text-align:center;';
  banner.textContent = message;
  document.body.appendChild(banner);
  errorBanner = banner;
  errorBanner.hideTimer = setTimeout(() => banner.classList.add('hidden'), 5000);
}

/**
 * Mostra/nasconde il banner "Apri Spotify sul tablet" con pulsante
 * che tenta di aprire l'app (URI scheme), con fallback al web player.
 * @param {boolean} show
 */
function updateNoDeviceBanner(show) {
  if (!noDeviceBanner) {
    const el = document.getElementById('spotify-no-device');
    if (el) noDeviceBanner = el;
  }
  if (!noDeviceBanner) {
    const el = document.createElement('div');
    el.id = 'spotify-no-device';
    el.className = 'spotify-no-device';
    el.style.cssText =
      'position:fixed; top:110px; left:50%; transform:translateX(-50%); ' +
      'background:#17181a; border-left:4px solid #1db954; color:#fff; ' +
      'padding:10px 16px; font-size:14px; border-radius:0 6px 6px 0; ' +
      'z-index:1000; box-sizing:border-box; display:none;';
    el.innerHTML =
      '<span style="margin-right:10px; display:inline-block;">Apri Spotify sul tablet</span>' +
      '<button id="spotify-open-app" style="background:#1db954; color:#fff; border:none; ' +
      'padding:6px 14px; border-radius:4px; font-size:13px; font-weight:600; cursor:pointer;">' +
      'Apri app</button>';
    document.body.appendChild(el);
    noDeviceBanner = el;
    document.getElementById('spotify-open-app').addEventListener('click', openSpotifyApp);
  }
  noDeviceBanner.style.display = show ? 'block' : 'none';
}

/**
 * Tenta di aprire l'app Spotify (URI scheme nativo) e, in caso di
 * fallimento, apre il web player come fallback.
 */
export function openSpotifyApp() {
  try {
    window.location.href = 'spotify://';
  } catch (err) {
    // ignorato
  }
  setTimeout(() => {
    window.location.href = 'https://open.spotify.com';
  }, 1500);
}

/**
 * Mostra/nasconde il pulsante "Collega Spotify".
 * Il pulsante viene inserito nel mini-player (vista Marcia) quando
 * presente, altrimenti in posizione fissa sullo stage.
 */
function updateConnectButtonVisibility() {
  if (!connectBtn) {
    connectBtn = document.getElementById('spotify-connect-btn');
  }
  const miniPlayer = document.querySelector('.mini-player');
  const target = miniPlayer || document.getElementById('stage') || document.body;

  if (!connectBtn) {
    connectBtn = document.createElement('button');
    connectBtn.id = 'spotify-connect-btn';
    connectBtn.textContent = 'Collega Spotify';
    connectBtn.style.cssText =
      'background:#1db954; color:#fff; border:none; border-radius:4px; ' +
      'padding:6px 14px; font-size:13px; font-weight:600; cursor:pointer; ' +
      'margin-left:10px;';
    target.appendChild(connectBtn);
    connectBtn.addEventListener('click', loginSpotify);
  }

  const hasToken = isSpotifyConnected();
  connectBtn.style.display = hasToken ? 'none' : 'inline-block';
}

// ====================================================================
// Collegamento controlli DOM
// ====================================================================

/**
 * Collega gli eventi ai controlli del giocatore già presenti nel DOM
 * (card parcheggio e mini-player marcia).
 */
function bindPlayerControls() {
  const mark = (el) => { if (el && !el.dataset.spotifyBound) { el.dataset.spotifyBound = '1'; return true; }; return false; };

  // Play / Pausa (entrambi i contesti)
  document.querySelectorAll('.ctrl-play').forEach((btn) => {
    if (mark(btn)) btn.addEventListener('click', playPause);
  });
  document.querySelectorAll('.ctrl-prev').forEach((btn) => {
    if (mark(btn)) btn.addEventListener('click', previousTrack);
  });
  document.querySelectorAll('.ctrl-next').forEach((btn) => {
    if (mark(btn)) btn.addEventListener('click', nextTrack);
  });
  // Cuore (parking .ctrl-heart, mini-player .heart-outline)
  document.querySelectorAll('.ctrl-heart, .heart-outline').forEach((btn) => {
    if (mark(btn)) btn.addEventListener('click', toggleLike);
  });
  // Ricerca
  document.querySelectorAll('.ctrl-search').forEach((btn) => {
    if (mark(btn)) btn.addEventListener('click', openSearch);
  });
  // Shuffle / Repeat (card parcheggio)
  const shuffleBtn = document.querySelector('.spotify-shuffle');
  const repeatBtn = document.querySelector('.spotify-repeat');
  let repeatState = 'off';
  if (shuffleBtn && mark(shuffleBtn)) {
    let shuffleOn = false;
    shuffleBtn.addEventListener('click', () => {
      shuffleOn = !shuffleOn;
      shuffleBtn.classList.toggle('active', shuffleOn);
      shuffleBtn.setAttribute('stroke', shuffleOn ? '#1db954' : '#b5b5b9');
      setShuffle(shuffleOn);
    });
  }
  if (repeatBtn && mark(repeatBtn)) {
    repeatBtn.addEventListener('click', () => {
      const states = ['off', 'context', 'track'];
      repeatState = states[(states.indexOf(repeatState) + 1) % states.length];
      repeatBtn.classList.toggle('active', repeatState !== 'off');
      repeatBtn.setAttribute('stroke', repeatState !== 'off' ? '#1db954' : '#b5b5b9');
      setRepeat(repeatState);
    });
  }

  // Pulsante connetti già presente nell'HTML, se esiste
  const existingConnect = document.getElementById('spotify-connect-btn');
  if (existingConnect && !connectBtn) {
    connectBtn = existingConnect;
    connectBtn.addEventListener('click', loginSpotify);
  }
}

/**
 * Inietta stili CSS minimi per i componenti Spotify.
 */
function injectStyles() {
  if (document.getElementById('ami-spotify-styles')) return;

  const style = document.createElement('style');
  style.id = 'ami-spotify-styles';
  style.textContent = `
    .spotify-error-banner.hidden { display: none; }
    #spotify-no-device { display: none; }
    .spotify-no-device { display: none; }
    .heart-outline.liked, .ctrl-heart.liked { fill: #1db95e !important; stroke: #1db95e !important; }
    .spotify-shuffle.active, .spotify-repeat.active { stroke: #1db954 !important; }
  `;
  document.head.appendChild(style);
}

// ====================================================================
// Rete (online/offline)
// ====================================================================

function bindNetworkListeners() {
  if (networkListenersBound) return;
  networkListenersBound = true;
  window.addEventListener('online', () => {
    isOnline = true;
    if (isSpotifyConnected() && !isPolling) {
      startPolling();
    }
  });
  window.addEventListener('offline', () => {
    isOnline = false;
    stopPolling();
    showError('Rete assente. Verifica la connessione del tablet.');
  });
}

// ====================================================================
// Inizializzazione pubblica
// ====================================================================

/**
 * Inizializza il modulo Spotify: carica token salvati, gestisce il
 * callback di autorizzazione, avvia il polling se collegato e collega
 * i controlli del player. Da chiamare all'avvio dell'app.
 */
export function initSpotify() {
  loadTokens();
  injectStyles();
  bindNetworkListeners();

  // Se siamo sulla pagina di callback (con ?code=), scambia il codice
  const params = new URLSearchParams(window.location.search);
  if (params.get('code')) {
    handleSpotifyCallback();
    return;
  }

  // Se c'è già un access token valido, inizia il polling
  if (accessToken && !isTokenExpired()) {
    startPolling();
  }

  updateConnectButtonVisibility();
  bindPlayerControls();
}

/**
 * Ferma tutto (es. logout o cambio pagina).
 */
export function destroySpotify() {
  stopPolling();
  clearTokens();
  updateConnectButtonVisibility();
  closeSearch();
}
