    import {
      FilesetResolver,
      ObjectDetector,
      HandLandmarker,
      FaceLandmarker,
    } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

    // =====================================================
    // TUNING KNOBS
    // =====================================================
    const RUN_EVERY_MS = 150;        // how often to analyse a frame
    const SCORE_THRESHOLD = 0.3;     // min phone confidence (lower = catches more phones)
    const HAND_MARGIN = 40;          // pixels of slack between hand and phone box

    const WINDOW = 20;               // smoothing window (number of results)
    const AGREE_RATIO = 0.6;         // share of results that must agree

    const COOLDOWN_SECONDS = 60;     // minimum gap between reminders
    const MOTION_THRESHOLD = 0.05;   // movement level considered "lots of movement"

    // Eye / head tracking (measured as the CHANGE from your calibrated baseline)
    const PITCH_DOWN_DELTA = 0.10;   // head tilted down
    const GAZE_DOWN_DELTA = 0.20;    // eyes looking down (0..1 blendshape score)
    const YAW_DELTA = 0.12;          // head turned left/right
    const GAZE_SIDE_DELTA = 0.35;    // eyes looking far left/right
    const CAL_SAMPLES = 20;          // frames used for calibration (~3 s)
    const COUNT_ABSENT = true;       // treat "face not visible" as a distraction

    // Seconds before a reminder, per reason. Looking down alone is slow on
    // purpose, because you may simply be writing notes.
    const REASONS = {
      phone:     { label: 'Phone in hand',            limit: 20, say: 'Put the phone down and get back to studying.' },
      phoneDown: { label: 'Looking down at a phone',  limit: 12, say: 'Are you on your phone? Eyes back on your work.' },
      away:      { label: 'Looking away',             limit: 30, say: 'Eyes back on your work.' },
      absent:    { label: 'Not at your desk',         limit: 30, say: 'Come back to your desk and keep studying.' },
      down:      { label: 'Looking down',             limit: 45, say: 'Lift your head and refocus.' },
    };
    const PRIORITY = ['phone', 'phoneDown', 'away', 'absent', 'down'];

    // Pomodoro
    const LONG_BREAK_EVERY = 4;
    const PHASE_LABEL = { focus: 'Focus', short: 'Short break', long: 'Long break' };

    // =====================================================
    // ELEMENTS
    // =====================================================
    const $ = (id) => document.getElementById(id);
    const video = $('video');
    const canvas = $('overlay');
    const ctx = canvas.getContext('2d');
    const videoWrap = $('videoWrap');
    const pill = $('pill');
    const statusText = $('statusText');
    const liveBadge = $('liveBadge');
    const motionEl = $('motion');
    const debugEl = $('debug');
    const startBtn = $('startBtn');
    const stopBtn = $('stopBtn');
    const recalBtn = $('recalBtn');
    const pauseBtn = $('pauseBtn');
    const skipBtn = $('skipBtn');
    const resetBtn = $('resetBtn');
    const alertBox = $('alertBox');
    const timerCard = $('timerCard');
    const ringEl = $('ringProgress');
    const timeEl = $('timeText');
    const phaseEl = $('phaseText');
    const dotsEl = $('dots');
    const BASE_TITLE = document.title;

    // =====================================================
    // SETTINGS (saved in localStorage)
    // =====================================================
    const SETTINGS_KEY = 'studyGuardSettings';
    function readJSON(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    }
    function writeJSON(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
    }
    const settings = Object.assign(
      { focusMin: 25, shortMin: 5, longMin: 15, overlay: false },
      readJSON(SETTINGS_KEY) || {}
    );

    for (const key of ['focusMin', 'shortMin', 'longMin']) {
      const el = $(key);
      el.value = settings[key];
      el.addEventListener('change', () => {
        const v = Math.min(120, Math.max(1, parseInt(el.value, 10) || settings[key]));
        settings[key] = v;
        el.value = v;
        writeJSON(SETTINGS_KEY, settings);
        if (pomo.phase === 'idle') renderTimer();
      });
    }
    $('overlayToggle').checked = settings.overlay;
    $('overlayToggle').addEventListener('change', (e) => {
      settings.overlay = e.target.checked;
      writeJSON(SETTINGS_KEY, settings);
      if (!settings.overlay) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        debugEl.textContent = '';
      }
    });

    // =====================================================
    // STATUS PILL
    // =====================================================
    function setStatus(text, kind = 'info') {
      statusText.textContent = text;
      pill.dataset.kind = kind;
    }

    // =====================================================
    // CAMERA
    // =====================================================
    async function startCamera() {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      video.srcObject = stream;
      await new Promise((resolve) => (video.onloadedmetadata = resolve));
      await video.play();
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    function stopCamera() {
      const stream = video.srcObject;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }

    function showCamera(on) {
      videoWrap.classList.toggle('on', on);
      liveBadge.hidden = !on;
    }

    // =====================================================
    // MODELS
    // =====================================================
    let detector = null;
    let handLandmarker = null;
    let faceLandmarker = null;
    let modelsLoaded = false;

    async function createModels(vision, delegate) {
      detector = await ObjectDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
          delegate,
        },
        runningMode: 'VIDEO',
        scoreThreshold: SCORE_THRESHOLD,
        categoryAllowlist: ['cell phone'],
      });

      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate,
        },
        runningMode: 'VIDEO',
        numHands: 2,
      });

      faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate,
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
    }

    async function loadModels() {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      try {
        await createModels(vision, 'GPU');
      } catch (e) {
        console.warn('GPU not available, falling back to CPU', e);
        await createModels(vision, 'CPU');
      }
      modelsLoaded = true;
    }

    // =====================================================
    // STATS (saved per day in localStorage)
    // =====================================================
    const statsKey = `studyStats-${new Date().toDateString()}`;
    const stats = Object.assign(
      { focusedSec: 0, distractedSec: 0, reminders: 0, pomodoros: 0 },
      readJSON(statsKey) || {}
    );

    function saveStats() { writeJSON(statsKey, stats); }

    function fmtMin(sec) {
      const m = Math.floor(sec / 60);
      return m < 1 ? `${Math.floor(sec)} s` : `${m} min`;
    }

    function renderStats() {
      $('focused').textContent = fmtMin(stats.focusedSec);
      $('distracted').textContent = fmtMin(stats.distractedSec);
      $('reminders').textContent = stats.reminders;
      $('pomodoros').textContent = stats.pomodoros;
      const total = stats.focusedSec + stats.distractedSec;
      const score = total > 0 ? Math.round((stats.focusedSec / total) * 100) : null;
      $('scoreText').textContent = score === null ? '—' : `${score}%`;
      $('scoreBar').style.width = `${score === null ? 0 : score}%`;
    }
    renderStats();

    // =====================================================
    // SOUND, SPEECH, NOTIFICATIONS
    // =====================================================
    let audioCtx = null;

    function tone(freq, startAt, dur) {
      if (!audioCtx) return;
      const t0 = audioCtx.currentTime + startAt;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }

    const chime = () => { tone(660, 0, 0.25); tone(880, 0.25, 0.35); };
    const alarm = () => { tone(880, 0, 0.3); tone(880, 0.4, 0.3); };

    function speak(text) {
      if (!('speechSynthesis' in window)) return;
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    }

    function notify(title, body) {
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(title, { body }); } catch (e) { /* ignore */ }
      }
    }

    function remind(reasonKey) {
      const r = REASONS[reasonKey];
      $('alertTitle').textContent = r.label;
      $('alertText').textContent = r.say;
      alertBox.hidden = false;
      alarm();
      speak(r.say);
      notify('StudyGuard', r.say);
    }
    $('alertClose').addEventListener('click', () => { alertBox.hidden = true; });

    // =====================================================
    // POMODORO TIMER
    // Time is computed from timestamps, so it stays accurate
    // even if the browser slows timers in a background tab.
    // =====================================================
    const RING_C = 2 * Math.PI * 88;
    ringEl.style.strokeDasharray = RING_C;

    const pomo = { phase: 'idle', endsAt: 0, totalMs: 0, remainingMs: 0, paused: false, cycle: 0 };

    function phaseMinutes(phase) {
      return phase === 'focus' ? settings.focusMin : phase === 'short' ? settings.shortMin : settings.longMin;
    }

    function startPhase(phase) {
      pomo.phase = phase;
      pomo.totalMs = phaseMinutes(phase) * 60000;
      pomo.remainingMs = pomo.totalMs;
      pomo.endsAt = Date.now() + pomo.totalMs;
      pomo.paused = false;
      resetLogic();
      lastTick = Date.now();
      alertBox.hidden = true;
      updatePhaseStatus();
      renderTimer();
      updateTimerButtons();
    }

    function pausePomo() {
      if (pomo.phase === 'idle' || pomo.paused) return;
      pomo.remainingMs = Math.max(0, pomo.endsAt - Date.now());
      pomo.paused = true;
      updatePhaseStatus();
      renderTimer();
      updateTimerButtons();
    }

    function resumePomo() {
      if (!pomo.paused) return;
      pomo.endsAt = Date.now() + pomo.remainingMs;
      pomo.paused = false;
      resetLogic();
      lastTick = Date.now();
      updatePhaseStatus();
      renderTimer();
      updateTimerButtons();
    }

    function completePhase(natural) {
      const was = pomo.phase;
      let next = 'focus';
      if (was === 'focus') {
        if (natural) {
          stats.pomodoros += 1;
          pomo.cycle += 1;
          saveStats();
          renderStats();
        }
        next = natural && pomo.cycle % LONG_BREAK_EVERY === 0 ? 'long' : 'short';
      }
      startPhase(next);
      if (natural) {
        chime();
        if (next === 'focus') {
          speak('Break is over. Back to focus.');
          notify('StudyGuard', 'Break is over. Time to focus.');
        } else {
          speak('Great work. Time for a break.');
          notify('StudyGuard', 'Focus session complete. Enjoy your break.');
        }
      }
    }

    function renderTimer() {
      let ms;
      let total;
      if (pomo.phase === 'idle') {
        total = settings.focusMin * 60000;
        ms = total;
      } else {
        total = pomo.totalMs;
        ms = pomo.paused ? pomo.remainingMs : Math.max(0, pomo.endsAt - Date.now());
      }
      const secs = Math.ceil(ms / 1000);
      const text = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
      timeEl.textContent = text;
      phaseEl.textContent =
        pomo.phase === 'idle' ? 'Ready to focus' : PHASE_LABEL[pomo.phase] + (pomo.paused ? ' (paused)' : '');
      ringEl.style.strokeDashoffset = RING_C * (1 - ms / total);
      timerCard.dataset.phase = pomo.phase;
      document.title = pomo.phase === 'idle' ? BASE_TITLE : `${text} · ${PHASE_LABEL[pomo.phase]} — StudyGuard`;

      const done = pomo.phase === 'long' ? LONG_BREAK_EVERY : pomo.cycle % LONG_BREAK_EVERY;
      dotsEl.innerHTML = '';
      for (let i = 0; i < LONG_BREAK_EVERY; i++) {
        const d = document.createElement('span');
        if (i < done) d.className = 'done';
        dotsEl.appendChild(d);
      }
    }

    function updateTimerButtons() {
      const active = pomo.phase !== 'idle';
      pauseBtn.disabled = !active;
      skipBtn.disabled = !active;
      resetBtn.disabled = !active;
      pauseBtn.textContent = pomo.paused ? 'Resume' : 'Pause';
    }

    function updatePhaseStatus() {
      if (!running || calibrating) return;
      if (pomo.paused) setStatus('Paused', 'info');
      else if (pomo.phase === 'short' || pomo.phase === 'long') setStatus('Break time. Rest your eyes.', 'info');
      else if (pomo.phase === 'focus') setStatus('Focused', 'ok');
    }

    setInterval(() => {
      if (pomo.phase !== 'idle' && !pomo.paused && Date.now() >= pomo.endsAt) completePhase(true);
      renderTimer();
    }, 250);

    pauseBtn.addEventListener('click', () => (pomo.paused ? resumePomo() : pausePomo()));
    skipBtn.addEventListener('click', () => completePhase(false));
    resetBtn.addEventListener('click', () => startPhase(pomo.phase));

    // =====================================================
    // SMOOTHING + DISTRACTION LOGIC
    // =====================================================
    function makeSmoother() {
      const hist = [];
      return (value) => {
        hist.push(value);
        if (hist.length > WINDOW) hist.shift();
        if (hist.length < WINDOW / 2) return false;
        return hist.filter(Boolean).length / hist.length >= AGREE_RATIO;
      };
    }

    let smoothers = {};
    let since = {};
    let lastReminderAt = 0;
    let lastTick = Date.now();

    function resetLogic() {
      smoothers = {};
      since = {};
      for (const k of PRIORITY) {
        smoothers[k] = makeSmoother();
        since[k] = null;
      }
    }
    resetLogic();

    function handleResult(raw) {
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;

      const active = [];
      for (const k of PRIORITY) {
        const on = smoothers[k](Boolean(raw[k]));
        if (on) {
          if (since[k] === null) since[k] = now;
          active.push(k);
        } else {
          since[k] = null;
        }
      }

      if (active.length > 0) {
        stats.distractedSec += dt;
        const top = active[0];
        const secs = Math.floor((now - since[top]) / 1000);
        setStatus(`${REASONS[top].label} · ${secs}s`, 'warn');

        const dueReason = active.find((k) => (now - since[k]) / 1000 >= REASONS[k].limit);
        const cooledDown = now - lastReminderAt > COOLDOWN_SECONDS * 1000;
        if (dueReason && cooledDown) {
          lastReminderAt = now;
          stats.reminders += 1;
          remind(dueReason);
        }
      } else {
        stats.focusedSec += dt;
        alertBox.hidden = true;
        setStatus('Focused', 'ok');
      }
      renderStats();
      saveStats();
    }

    // =====================================================
    // MOVEMENT DETECTION (frame differencing)
    // =====================================================
    const small = document.createElement('canvas');
    small.width = 64;
    small.height = 48;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    let prevPixels = null;

    function motionLevel() {
      sctx.drawImage(video, 0, 0, 64, 48);
      const px = sctx.getImageData(0, 0, 64, 48).data;
      let diff = 0;
      if (prevPixels) {
        for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] - prevPixels[i]);
      }
      prevPixels = px;
      return diff / (64 * 48 * 255);
    }

    // =====================================================
    // EYE / HEAD TRACKING
    // Landmarks: 1 nose tip, 33/263 outer eye corners, 152 chin,
    // 234/454 face edges, 468/473 iris centres
    // =====================================================
    function readFace(result) {
      if (!result.faceLandmarks || result.faceLandmarks.length === 0) return null;
      const lm = result.faceLandmarks[0];

      const eyeMidY = (lm[33].y + lm[263].y) / 2;
      const pitch = (lm[1].y - eyeMidY) / (lm[152].y - eyeMidY);
      const yaw = (lm[1].x - lm[234].x) / (lm[454].x - lm[234].x);

      const bs = {};
      const shapes = result.faceBlendshapes && result.faceBlendshapes[0];
      if (shapes) for (const c of shapes.categories) bs[c.categoryName] = c.score;
      const g = (name) => bs[name] || 0;

      const gazeDown = (g('eyeLookDownLeft') + g('eyeLookDownRight')) / 2;
      const sideA = (g('eyeLookOutLeft') + g('eyeLookInRight')) / 2;
      const sideB = (g('eyeLookInLeft') + g('eyeLookOutRight')) / 2;
      const gazeSide = Math.max(sideA, sideB);

      return { lm, pitch, yaw, gazeDown, gazeSide };
    }

    // Calibration: look at your screen for ~3 seconds so we learn what
    // "focused" looks like for your face, camera angle and seating.
    let calibrating = false;
    let calSamples = [];
    let sessionPending = false;
    let calPaused = false;
    let base = { pitch: 0, yaw: 0.5, gazeDown: 0, gazeSide: 0 };

    function startCalibration(beginSession = false) {
      calibrating = true;
      calSamples = [];
      sessionPending = beginSession;
      calPaused = false;
      if (!beginSession && pomo.phase !== 'idle' && !pomo.paused) {
        pausePomo();
        calPaused = true;
      }
      alertBox.hidden = true;
      resetLogic();
      recalBtn.disabled = true;
      setStatus('Calibrating… look at your screen', 'info');
    }

    function runCalibration(face) {
      if (!face) {
        setStatus('Calibrating… I can’t see your face yet', 'warn');
        return;
      }
      calSamples.push({ pitch: face.pitch, yaw: face.yaw, gazeDown: face.gazeDown, gazeSide: face.gazeSide });
      setStatus(`Calibrating… look at your screen (${calSamples.length}/${CAL_SAMPLES})`, 'info');

      if (calSamples.length >= CAL_SAMPLES) {
        const avg = (key) => calSamples.reduce((s, f) => s + f[key], 0) / calSamples.length;
        base = { pitch: avg('pitch'), yaw: avg('yaw'), gazeDown: avg('gazeDown'), gazeSide: avg('gazeSide') };
        calibrating = false;
        recalBtn.disabled = false;
        if (sessionPending) {
          sessionPending = false;
          startPhase('focus');
        } else if (calPaused) {
          calPaused = false;
          resumePomo();
        } else {
          updatePhaseStatus();
        }
      }
    }

    // =====================================================
    // DETECTION + OPTIONAL OVERLAY
    // =====================================================
    function handTouchesBox(hand, box, margin = HAND_MARGIN) {
      return hand.some((pt) => {
        const x = pt.x * canvas.width;
        const y = pt.y * canvas.height;
        return (
          x > box.originX - margin &&
          x < box.originX + box.width + margin &&
          y > box.originY - margin &&
          y < box.originY + box.height + margin
        );
      });
    }

    function dot(pt, radius, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pt.x * canvas.width, pt.y * canvas.height, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // The camera looks completely normal unless "Show tracking overlay" is on.
    function drawOverlay(phones, hands, face) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!settings.overlay) return;

      ctx.lineWidth = 3;
      ctx.strokeStyle = '#00ffa6';
      for (const p of phones) {
        const b = p.boundingBox;
        ctx.strokeRect(b.originX, b.originY, b.width, b.height);
      }
      for (const hand of hands) for (const pt of hand) dot(pt, 3, '#ff3d81');
      if (face) {
        dot(face.lm[1], 3, '#ffffff');
        if (face.lm.length > 473) {
          dot(face.lm[468], 4, '#00e0ff');
          dot(face.lm[473], 4, '#00e0ff');
        }
      }
    }

    function analyseFrame(now) {
      const phones = detector.detectForVideo(video, now).detections;
      const hands = handLandmarker.detectForVideo(video, now).landmarks;
      const face = readFace(faceLandmarker.detectForVideo(video, now));
      drawOverlay(phones, hands, face);

      const moving = motionLevel() > MOTION_THRESHOLD;
      motionEl.textContent = moving && settings.overlay ? 'Lots of movement' : '';

      if (calibrating) {
        runCalibration(face);
        return;
      }

      const phoneInHand = phones.some((p) => hands.some((h) => handTouchesBox(h, p.boundingBox)));

      let lookingDown = false;
      let lookingAway = false;
      if (face) {
        const dPitch = face.pitch - base.pitch;
        const dGazeDown = face.gazeDown - base.gazeDown;
        const dYaw = face.yaw - base.yaw;
        const dSide = face.gazeSide - base.gazeSide;

        lookingDown = dPitch > PITCH_DOWN_DELTA || dGazeDown > GAZE_DOWN_DELTA;
        lookingAway = Math.abs(dYaw) > YAW_DELTA || dSide > GAZE_SIDE_DELTA;

        debugEl.textContent = settings.overlay
          ? `head-down ${dPitch.toFixed(2)} (>${PITCH_DOWN_DELTA}) · eyes-down ${dGazeDown.toFixed(2)} (>${GAZE_DOWN_DELTA}) · ` +
            `turn ${dYaw.toFixed(2)} (>${YAW_DELTA}) · eyes-side ${dSide.toFixed(2)} (>${GAZE_SIDE_DELTA})`
          : '';
      } else {
        debugEl.textContent = settings.overlay ? 'no face detected' : '';
      }

      handleResult({
        phone: phoneInHand,
        phoneDown: phones.length > 0 && lookingDown,
        away: lookingAway,
        down: lookingDown,
        absent: COUNT_ABSENT && !face,
      });
    }

    // =====================================================
    // MAIN LOOP
    // Detection only runs while calibrating or during a focus session,
    // which saves battery during breaks and pauses.
    // =====================================================
    let running = false;
    let loopStarted = false;
    let lastRun = 0;

    function isFocusing() {
      return running && !calibrating && pomo.phase === 'focus' && !pomo.paused;
    }

    function loop() {
      const now = performance.now();
      if (running && video.readyState >= 2 && now - lastRun >= RUN_EVERY_MS) {
        lastRun = now;
        if (calibrating || isFocusing()) {
          analyseFrame(now);
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          motionEl.textContent = '';
          debugEl.textContent = '';
          lastTick = Date.now();
        }
      }
      requestAnimationFrame(loop);
    }

    // =====================================================
    // START / STOP STUDYING
    // =====================================================
    function friendlyError(err) {
      if (err && err.name === 'NotAllowedError') return 'Camera permission was denied. Allow access and try again.';
      if (err && err.name === 'NotFoundError') return 'No camera found on this device.';
      return 'Could not start: ' + (err && err.message ? err.message : 'unknown error');
    }

    async function startStudying() {
      startBtn.disabled = true;
      try {
        if (!audioCtx) audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

        setStatus('Starting camera…', 'info');
        await startCamera();
        showCamera(true);

        if (!modelsLoaded) {
          setStatus('Loading focus detection…', 'info');
          await loadModels();
        }

        running = true;
        stopBtn.disabled = false;
        pomo.cycle = 0;
        startCalibration(true);
        if (!loopStarted) {
          loopStarted = true;
          requestAnimationFrame(loop);
        }
      } catch (err) {
        console.error(err);
        stopCamera();
        showCamera(false);
        running = false;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        setStatus(friendlyError(err), 'warn');
      }
    }

    function stopStudying() {
      running = false;
      calibrating = false;
      sessionPending = false;
      calPaused = false;

      stopCamera();
      showCamera(false);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      alertBox.hidden = true;
      motionEl.textContent = '';
      debugEl.textContent = '';

      pomo.phase = 'idle';
      pomo.paused = false;
      pomo.cycle = 0;
      resetLogic();
      saveStats();
      renderStats();
      renderTimer();
      updateTimerButtons();

      startBtn.disabled = false;
      stopBtn.disabled = true;
      recalBtn.disabled = true;
      setStatus('Session ended. Nice work!', 'info');
    }

    startBtn.addEventListener('click', startStudying);
    stopBtn.addEventListener('click', stopStudying);
    recalBtn.addEventListener('click', () => startCalibration(false));

    renderTimer();
    updateTimerButtons();
