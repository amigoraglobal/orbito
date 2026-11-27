'use strict';

// ---------- Settings ----------
const ADS_INTERVAL_MS = 30 * 60 * 1000; // free users using the gender filter
const ADS_PER_BREAK = 3;
const AD_SECONDS = 5;
const STALE_MS = 20000;
const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
].concat(Array.isArray(window.ORBITO_TURN) ? window.ORBITO_TURN : []);

// ---------- Helpers ----------
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};

// ---------- State ----------
let blocked = new Set(JSON.parse(store.get('orbito_blocked', '[]')));
let premium = store.get('orbito_premium', '0') === '1';
let uid = null, db = null, serverOffset = 0;
let mode = 'video';
let myGender = store.get('orbito_gender', 'm');
let wantGender = store.get('orbito_want', 'any');
let localStream = null, pc = null, callRef = null, partnerUid = null;
let active = false, claiming = false, searchToken = 0;
let wref = null, matchRef = null, heartbeat = null, connectTimer = null;
let listeners = [], adTimer = null, adShowing = false;

const TS = () => firebase.database.ServerValue.TIMESTAMP;
const sNow = () => Date.now() + serverOffset;

function show(id) {
  ['homeScreen', 'callScreen'].forEach(s => $(s).classList.toggle('hidden', s !== id));
}
function setStatus(t) { $('status').textContent = t; }
function dbg(t) { const d = $('dbg'); if (d) d.textContent = t || ''; }
function errText(e) { return String((e && (e.code || e.message)) || e); }

// ---------- Init ----------
async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setupHome();
  if (!store.get('orbito_age_ok', '')) $('gate').classList.remove('hidden');

  const cfg = window.ORBITO_CONFIG;
  if (!cfg || String(cfg.apiKey).startsWith('PASTE')) {
    $('cfgWarn').classList.remove('hidden');
    return;
  }
  try {
    firebase.initializeApp(cfg);
    db = firebase.database();
    const cred = await firebase.auth().signInAnonymously();
    uid = cred.user.uid;
    db.ref('.info/serverTimeOffset').on('value', s => { serverOffset = s.val() || 0; });
    try {
      const banSnap = await db.ref('bans/' + uid).once('value');
      if (banSnap.exists()) {
        $('cfgWarn').textContent = 'This browser has been blocked for breaking the Orbito rules.';
        $('cfgWarn').classList.remove('hidden');
        return;
      }
    } catch (e) { /* ban list not readable yet: continue */ }
    $('startVideo').disabled = false;
    $('startAudio').disabled = false;
  } catch (e) {
    $('cfgWarn').textContent = 'Firebase error: ' + e.message;
    $('cfgWarn').classList.remove('hidden');
  }
}

function setupHome() {
  $('myGender').value = myGender;
  $('wantGender').value = wantGender;
  updateFilterNote();
  updatePremiumUI();

  $('myGender').onchange = () => { myGender = $('myGender').value; store.set('orbito_gender', myGender); };
  $('wantGender').onchange = () => { wantGender = $('wantGender').value; store.set('orbito_want', wantGender); updateFilterNote(); };

  $('ageChk').onchange = () => { $('gateOk').disabled = !$('ageChk').checked; };
  $('gateOk').onclick = () => { store.set('orbito_age_ok', '1'); $('gate').classList.add('hidden'); };

  $('startVideo').onclick = () => startCall('video');
  $('startAudio').onclick = () => startCall('audio');

  $('premiumBtn').onclick = () => {
    premium = !premium;
    store.set('orbito_premium', premium ? '1' : '0');
    updatePremiumUI();
    updateFilterNote();
  };

  $('mute').onclick = () => toggleTrack('audio', 'mute');
  $('cam').onclick = () => toggleTrack('video', 'cam');
  $('next').onclick = () => { if (!active) return; leaveCall(); search(); };
  $('endBtn').onclick = goHome;
  $('report').onclick = reportAndBlock;

  window.addEventListener('pagehide', () => {
    try { if (callRef && uid) callRef.child('end').set(uid); } catch (e) {}
    try { stopWaiting(); } catch (e) {}
  });
}

function updatePremiumUI() {
  $('premiumBtn').textContent = 'Premium (demo): ' + (premium ? 'ON' : 'OFF');
}
function updateFilterNote() {
  const n = $('filterNote');
  if (wantGender === 'any') n.textContent = 'Tip: two testers should pick the same options to match each other quickly.';
  else if (premium) n.textContent = 'Gender filter on. No ads with Premium.';
  else n.textContent = 'Gender filter on. Free users see 3 short ads every 30 minutes.';
}

// ---------- Media ----------
async function getMedia() {
  if (localStream) {
    const hasVideo = localStream.getVideoTracks().length > 0;
    if ((mode === 'video') === hasVideo) return true;
    stopMedia();
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mode === 'video' ? { facingMode: 'user' } : false
    });
  } catch (e) {
    alert('Please allow microphone' + (mode === 'video' ? ' and camera' : '') + ' access.');
    localStream = null;
    return false;
  }
  $('localVideo').srcObject = localStream;
  $('mute').classList.remove('off');
  $('cam').classList.remove('off');
  return true;
}
function stopMedia() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  $('localVideo').srcObject = null;
}
function toggleTrack(kind, btn) {
  if (!localStream) return;
  const t = (kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks())[0];
  if (!t) return;
  t.enabled = !t.enabled;
  $(btn).classList.toggle('off', !t.enabled);
}

// ---------- Call flow ----------
async function startCall(m) {
  if (!uid) return;
  mode = m;
  myGender = $('myGender').value;
  wantGender = $('wantGender').value;
  show('callScreen');
  $('remoteWrap').classList.toggle('voice', m === 'audio');
  $('cam').classList.toggle('hidden', m === 'audio');
  setStatus('Getting ready…');
  const ok = await getMedia();
  if (!ok) { show('homeScreen'); return; }
  active = true;
  scheduleAds();
  search();
}

async function search() {
  cleanupPeer();
  const token = ++searchToken;
  setStatus('Looking for someone…');

  const have = myGender, want = wantGender;
  const lookPool = want === 'any' ? mode + ':any' : mode + ':' + want + ':' + have;
  const waitPool = want === 'any' ? mode + ':any' : mode + ':' + have + ':' + want;

  try {
    await db.ref('matches/' + uid).remove();
    if (await tryClaim(lookPool, false, token)) return;
    if (token !== searchToken) return;

    wref = db.ref('waiting/' + waitPool + '/' + uid);
    await wref.set({ ts: TS() });
    wref.onDisconnect().remove();

    matchRef = db.ref('matches/' + uid);
    matchRef.on('value', s => {
      const v = s.val();
      if (v && token === searchToken) onMatched(v);
    });

    heartbeat = setInterval(() => {
      if (token !== searchToken || !wref) return;
      wref.update({ ts: TS() }).catch(() => {});
      tryClaim(lookPool, true, token).catch(e => dbg('Error: ' + errText(e)));
    }, 5000);
  } catch (e) {
    setStatus('Network problem. Tap Next to retry.');
    dbg('Error: ' + errText(e));
  }
}

async function tryClaim(lookPool, rescan, token) {
  if (claiming) return false;
  claiming = true;
  try {
    const snap = await db.ref('waiting/' + lookPool).orderByChild('ts').limitToLast(15).once('value');
    const now = sNow();
    const cands = [];
    snap.forEach(c => {
      const v = c.val();
      if (v && c.key !== uid && !blocked.has(c.key) && now - v.ts < STALE_MS) cands.push(c.key);
    });

    for (const cu of cands) {
      if (token !== searchToken) return true;
      // tie-break so two waiting people don't claim each other at the same time
      if (rescan && uid > cu) continue;

      if (rescan && wref) {
        let mine = false;
        await wref.transaction(cur => { mine = !!cur; return null; });
        if (!mine) return true; // someone already claimed me
      }

      let got = false;
      await db.ref('waiting/' + lookPool + '/' + cu).transaction(cur => { got = !!cur; return null; });
      if (got) {
        await becomeCaller(cu);
        return true;
      }
      if (rescan && wref) {
        await wref.set({ ts: TS() });
        wref.onDisconnect().remove();
      }
    }
    return false;
  } finally {
    claiming = false;
  }
}

async function becomeCaller(partner) {
  stopWaiting();
  const callId = db.ref('calls').push().key;
  await db.ref('matches/' + partner).set({ callId: callId, from: uid });
  startPeer(true, callId, partner);
}

function onMatched(v) {
  stopWaiting();
  db.ref('matches/' + uid).remove().catch(() => {});
  if (blocked.has(v.from)) {
    db.ref('calls/' + v.callId + '/end').set(uid).catch(() => {});
    search();
    return;
  }
  startPeer(false, v.callId, v.from);
}

async function startPeer(isCaller, callId, partner) {
  partnerUid = partner;
  setStatus('Connecting…');

  const myPc = new RTCPeerConnection({ iceServers: ICE });
  pc = myPc;
  const cands = { host: 0, srflx: 0, relay: 0 };
  const showIce = () => dbg('ICE ' + myPc.iceConnectionState + ' · host ' + cands.host + ' · srflx ' + cands.srflx + ' · relay ' + cands.relay);
  myPc.oniceconnectionstatechange = () => { if (pc === myPc) showIce(); };
  localStream.getTracks().forEach(t => myPc.addTrack(t, localStream));
  myPc.ontrack = e => { $('remoteVideo').srcObject = e.streams[0]; };

  callRef = db.ref('calls/' + callId);
  callRef.child('end').onDisconnect().set(uid);

  const mine = callRef.child(isCaller ? 'callerCand' : 'calleeCand');
  const theirs = callRef.child(isCaller ? 'calleeCand' : 'callerCand');
  const queue = [];
  let remoteSet = false, gotRemote = false;
  const addCand = c => myPc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  const flush = () => { remoteSet = true; queue.splice(0).forEach(addCand); };

  myPc.onicecandidate = e => {
    if (!e.candidate) return;
    const m = / typ (host|srflx|relay)/.exec(e.candidate.candidate || '');
    if (m) cands[m[1]]++;
    if (pc === myPc) showIce();
    mine.push(e.candidate.toJSON());
  };
  myPc.onconnectionstatechange = () => {
    if (pc !== myPc) return;
    const s = myPc.connectionState;
    if (s === 'connected') {
      clearTimeout(connectTimer);
      dbg('');
      setStatus('Connected');
      $('remoteWrap').classList.add('live');
    } else if (s === 'failed') {
      partnerGone('Connection lost');
    }
  };

  theirs.on('child_added', s => {
    if (pc !== myPc) return;
    remoteSet ? addCand(s.val()) : queue.push(s.val());
  });
  listeners.push(theirs);

  const endRef = callRef.child('end');
  endRef.on('value', s => {
    const v = s.val();
    if (v && v !== uid && pc === myPc) partnerGone('Partner left');
  });
  listeners.push(endRef);

  connectTimer = setTimeout(() => {
    if (pc === myPc && myPc.connectionState !== 'connected') partnerGone('Could not connect');
  }, 25000);

  try {
    if (isCaller) {
      const offer = await myPc.createOffer();
      await myPc.setLocalDescription(offer);
      await callRef.child('offer').set({ type: offer.type, sdp: offer.sdp });
      const ans = callRef.child('answer');
      listeners.push(ans);
      ans.on('value', async s => {
        const v = s.val();
        if (!v || gotRemote || pc !== myPc) return;
        gotRemote = true;
        await myPc.setRemoteDescription(v);
        flush();
      });
    } else {
      const off = callRef.child('offer');
      listeners.push(off);
      off.on('value', async s => {
        const v = s.val();
        if (!v || gotRemote || pc !== myPc) return;
        gotRemote = true;
        await myPc.setRemoteDescription(v);
        flush();
        const a = await myPc.createAnswer();
        await myPc.setLocalDescription(a);
        await callRef.child('answer').set({ type: a.type, sdp: a.sdp });
      });
    }
  } catch (e) {
    dbg('Error: ' + errText(e));
    partnerGone('Could not connect');
  }
}

function partnerGone(msg) {
  if (!active || !pc) return;
  const cr = callRef;
  cleanupPeer();
  if (cr) cr.remove().catch(() => {});
  setStatus(msg + ' — finding next…');
  setTimeout(() => { if (active) search(); }, 1200);
}

function stopWaiting() {
  clearInterval(heartbeat);
  heartbeat = null;
  if (matchRef) { matchRef.off(); matchRef = null; }
  if (wref) {
    try { wref.onDisconnect().cancel(); } catch (e) {}
    wref.remove().catch(() => {});
    wref = null;
  }
}

function cleanupPeer() {
  clearTimeout(connectTimer);
  stopWaiting();
  listeners.forEach(r => { try { r.off(); } catch (e) {} });
  listeners = [];
  if (callRef) { try { callRef.child('end').onDisconnect().cancel(); } catch (e) {} }
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch (e) {}
    pc = null;
  }
  $('remoteVideo').srcObject = null;
  $('remoteWrap').classList.remove('live');
  callRef = null;
  partnerUid = null;
}

function leaveCall() {
  if (callRef) callRef.child('end').set(uid).catch(() => {});
  cleanupPeer();
}

function goHome() {
  active = false;
  searchToken++;
  leaveCall();
  stopMedia();
  clearInterval(adTimer);
  dbg('');
  $('ad').classList.add('hidden');
  adShowing = false;
  show('homeScreen');
}

function reportAndBlock() {
  const p = partnerUid;
  if (!p) { alert('There is nobody to report yet.'); return; }
  if (!confirm('Report and block this person?')) return;
  db.ref('reports').push({ by: uid, against: p, mode: mode, ts: TS() }).catch(() => {});
  blocked.add(p);
  store.set('orbito_blocked', JSON.stringify([...blocked]));
  leaveCall();
  search();
}

// ---------- Ads (placeholder) ----------
function scheduleAds() {
  clearInterval(adTimer);
  if (premium || wantGender === 'any') return;
  adTimer = setInterval(runAdBreak, ADS_INTERVAL_MS);
}
async function runAdBreak() {
  if (adShowing || !active) return;
  adShowing = true;
  $('ad').classList.remove('hidden');
  for (let i = 1; i <= ADS_PER_BREAK && active; i++) {
    for (let s = AD_SECONDS; s > 0 && active; s--) {
      $('adText').textContent = 'Ad ' + i + ' of ' + ADS_PER_BREAK + ' · ' + s + 's';
      await sleep(1000);
    }
  }
  $('ad').classList.add('hidden');
  adShowing = false;
}

init();
