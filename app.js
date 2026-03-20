import * as THREE from 'https://unpkg.com/three@0.179.1/build/three.module.js';

const enterBtn = document.getElementById('enter-ar');
const logEl = document.getElementById('log');

let renderer, scene, camera;
let latestSnapshot = null;
let pendingSnapshot = false;

const pinchState = {
  left: false,
  right: false,
};

const PINCH_THRESHOLD_METERS = 0.025;   // 2.5 cm
const RELEASE_THRESHOLD_METERS = 0.04;  // 4 cm

function log(...args) {
  const msg = args.join(' ');
  console.log(msg);
  logEl.textContent += '\n' + msg;
  logEl.scrollTop = logEl.scrollHeight;
}

function flattenMatrix(mat) {
  return Array.from(mat);
}

function sanitizeNumber(v) {
  return Number.isFinite(v) ? v : null;
}

function poseToJSON(xrRigidTransform) {
  return {
    position: {
      x: xrRigidTransform.position.x,
      y: xrRigidTransform.position.y,
      z: xrRigidTransform.position.z,
      w: xrRigidTransform.position.w,
    },
    orientation: {
      x: xrRigidTransform.orientation.x,
      y: xrRigidTransform.orientation.y,
      z: xrRigidTransform.orientation.z,
      w: xrRigidTransform.orientation.w,
    },
    matrix: flattenMatrix(xrRigidTransform.matrix),
    inverseMatrix: flattenMatrix(xrRigidTransform.inverse.matrix),
  };
}

function serializeDepthMap(depthInfo, sampleStep = 8) {
  const width = depthInfo.width;
  const height = depthInfo.height;
  const samples = [];

  for (let py = 0; py < height; py += sampleStep) {
    const row = [];
    for (let px = 0; px < width; px += sampleStep) {
      const nx = width > 1 ? px / (width - 1) : 0;
      const ny = height > 1 ? py / (height - 1) : 0;
      row.push(sanitizeNumber(depthInfo.getDepthInMeters(nx, ny)));
    }
    samples.push(row);
  }

  return {
    width,
    height,
    sampleStep,
    sampledWidth: samples[0]?.length ?? 0,
    sampledHeight: samples.length,
    rawValueToMeters: depthInfo.rawValueToMeters ?? null,
    normDepthBufferFromNormView: depthInfo.normDepthBufferFromNormView
      ? flattenMatrix(depthInfo.normDepthBufferFromNormView.matrix)
      : null,
    samplesMeters: samples,
  };
}

function downloadJSON(obj, filename = 'snapshot-depth.json') {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function initThree() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera();

  renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
  });

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  document.body.appendChild(renderer.domElement);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function getJointPose(frame, hand, jointName, refSpace) {
  const jointSpace = hand.get(jointName);
  if (!jointSpace) return null;
  return frame.getJointPose(jointSpace, refSpace);
}

function distance3D(a, b) {
  const dx = a.transform.position.x - b.transform.position.x;
  const dy = a.transform.position.y - b.transform.position.y;
  const dz = a.transform.position.z - b.transform.position.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function updateHandPinch(frame, refSpace, inputSource) {
  if (!inputSource?.hand) return;

  const handedness = inputSource.handedness || 'unknown';
  const hand = inputSource.hand;

  const thumbTip = getJointPose(frame, hand, 'thumb-tip', refSpace);
  const indexTip = getJointPose(frame, hand, 'index-finger-tip', refSpace);

  if (!thumbTip || !indexTip) return;

  const d = distance3D(thumbTip, indexTip);

  // pinch down
  if (!pinchState[handedness] && d < PINCH_THRESHOLD_METERS) {
    pinchState[handedness] = true;
    pendingSnapshot = true;
    log(`Pinch detected: ${handedness}, distance=${d.toFixed(4)}m`);
  }

  // pinch release
  if (pinchState[handedness] && d > RELEASE_THRESHOLD_METERS) {
    pinchState[handedness] = false;
  }
}

async function enterAR() {
  if (!navigator.xr) {
    log('navigator.xr not available.');
    return;
  }

  const supported = await navigator.xr.isSessionSupported('immersive-ar');
  if (!supported) {
    log('immersive-ar not supported.');
    return;
  }

  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local', 'depth-sensing'],
    optionalFeatures: ['hand-tracking'],
    depthSensing: {
      usagePreference: ['cpu-optimized'],
      dataFormatPreference: ['float32', 'luminance-alpha'],
    },
  });

  await renderer.xr.setSession(session);

  session.addEventListener('inputsourceschange', () => {
    const summary = session.inputSources.map((s) => {
      const kind = s.hand ? 'hand' : 'other';
      return `${kind}:${s.handedness || 'unknown'}`;
    });
    log('inputSources:', summary.join(', '));
  });

  log('AR session started.');
  log('Use thumb + index pinch to capture.');

  renderer.setAnimationLoop((time, frame) => {
    renderer.render(scene, camera);

    if (!frame) return;

    const refSpace = renderer.xr.getReferenceSpace();
    const session = frame.session;

    // 每帧自己检测 pinch
    for (const inputSource of session.inputSources) {
      updateHandPinch(frame, refSpace, inputSource);
    }

    if (!pendingSnapshot) return;
    pendingSnapshot = false;

    const pose = frame.getViewerPose(refSpace);
    if (!pose || !pose.views.length) {
      log('No viewer pose.');
      return;
    }

    const view = pose.views[0];

    let depthInfo = null;
    try {
      depthInfo = frame.getDepthInformation(view);
    } catch (err) {
      log('getDepthInformation failed:', err.message);
    }

    let centerDepth = null;
    if (depthInfo) {
      try {
        centerDepth = depthInfo.getDepthInMeters(0.5, 0.5);
      } catch (err) {
        log('center depth read failed:', err.message);
      }
    }

    latestSnapshot = {
      timestamp: new Date().toISOString(),
      sessionMode: session.mode,
      referenceSpaceType: 'local',
      camera: {
        transform: poseToJSON(view.transform),
        projectionMatrix: flattenMatrix(view.projectionMatrix),
      },
      centerDepthMeters: sanitizeNumber(centerDepth),
      depth: depthInfo ? serializeDepthMap(depthInfo, 8) : null,
    };

    log(
      'Snapshot captured.',
      'centerDepth:',
      String(latestSnapshot.centerDepthMeters)
    );

    downloadJSON(latestSnapshot);
  });
}

initThree();
enterBtn.addEventListener('click', enterAR);