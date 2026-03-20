const canvas = document.getElementById("xr-canvas");
const logEl = document.getElementById("log");
const enterArBtn = document.getElementById("enter-ar");

let gl = null;
let xrSession = null;
let xrRefSpace = null;

let pendingSnapshot = false;
let latestSnapshot = null;
let lastPinchTime = 0;
const PINCH_COOLDOWN_MS = 1200;

function log(...args) {
  const msg = args.map(String).join(" ");
  console.log(msg);
  logEl.textContent += "\n" + msg;
  logEl.scrollTop = logEl.scrollHeight;
}

function flattenMatrix(mat) {
  return Array.from(mat);
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

function sanitizeNumber(v) {
  return Number.isFinite(v) ? v : null;
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
      const d = depthInfo.getDepthInMeters(nx, ny);
      row.push(sanitizeNumber(d));
    }
    samples.push(row);
  }

  return {
    width,
    height,
    sampleStep,
    sampledWidth: samples[0] ? samples[0].length : 0,
    sampledHeight: samples.length,
    rawValueToMeters: depthInfo.rawValueToMeters ?? null,
    normDepthBufferFromNormView: depthInfo.normDepthBufferFromNormView
      ? flattenMatrix(depthInfo.normDepthBufferFromNormView.matrix)
      : null,
    samplesMeters: samples,
  };
}

function downloadJSON(obj, filename = "snapshot-depth.json") {
  const blob = new Blob(
    [JSON.stringify(obj, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function requestSnapshot(reason = "manual") {
  const now = Date.now();
  if (now - lastPinchTime < PINCH_COOLDOWN_MS) {
    log("Pinch ignored: cooldown active.");
    return;
  }

  lastPinchTime = now;
  pendingSnapshot = true;
  log("Snapshot requested by", reason);
}

function isHandInputSource(inputSource) {
  return inputSource && inputSource.hand;
}

async function initAR() {
  if (!navigator.xr) {
    log("navigator.xr not available.");
    return;
  }

  const supported = await navigator.xr.isSessionSupported("immersive-ar");
  if (!supported) {
    log("immersive-ar not supported on this browser/device.");
    return;
  }

  gl = canvas.getContext("webgl2", {
    xrCompatible: true,
    alpha: true,
    antialias: true,
  });

  if (!gl) {
    log("WebGL2 not available.");
    return;
  }

  xrSession = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["local", "depth-sensing"],
    optionalFeatures: ["hand-tracking"],
    depthSensing: {
      usagePreference: ["cpu-optimized"],
      dataFormatPreference: ["float32", "luminance-alpha"],
    },
  });

  xrSession.addEventListener("end", () => {
    log("XR session ended.");
    xrSession = null;
    xrRefSpace = null;
  });

  // pinch/select 触发 snapshot
  xrSession.addEventListener("select", (event) => {
    if (isHandInputSource(event.inputSource)) {
      const handedness = event.inputSource.handedness || "unknown-hand";
      requestSnapshot(`pinch-${handedness}`);
    } else {
      requestSnapshot("select-non-hand");
    }
  });

  await gl.makeXRCompatible();

  const baseLayer = new XRWebGLLayer(xrSession, gl, {
    alpha: true,
  });

  xrSession.updateRenderState({ baseLayer });
  xrRefSpace = await xrSession.requestReferenceSpace("local");

  log("AR session started.");
  log("Use pinch to capture a snapshot.");

  xrSession.requestAnimationFrame(onXRFrame);
}

function onXRFrame(time, frame) {
  const session = frame.session;
  session.requestAnimationFrame(onXRFrame);

  const pose = frame.getViewerPose(xrRefSpace);
  if (!pose) return;

  const baseLayer = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);

  // 透明背景，显示真实世界 passthrough
  gl.clearColor(0.0, 0.0, 0.0, 0.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const view = pose.views[0];
  if (!view) return;

  if (pendingSnapshot) {
    pendingSnapshot = false;

    let depthInfo = null;
    try {
      depthInfo = frame.getDepthInformation(view);
    } catch (err) {
      log("getDepthInformation failed:", err.message);
    }

    let centerDepth = null;
    if (depthInfo) {
      try {
        centerDepth = depthInfo.getDepthInMeters(0.5, 0.5);
      } catch (err) {
        log("center depth read failed:", err.message);
      }
    }

    latestSnapshot = {
      timestamp: new Date().toISOString(),
      sessionMode: session.mode,
      referenceSpaceType: "local",
      camera: {
        transform: poseToJSON(view.transform),
        projectionMatrix: flattenMatrix(view.projectionMatrix),
      },
      centerDepthMeters: sanitizeNumber(centerDepth),
      depth: depthInfo ? serializeDepthMap(depthInfo, 8) : null,
      notes: [
        "depth.samplesMeters is a sampled depth map in meters",
        "this is not object segmentation",
        "to isolate objects, you still need region annotation or segmentation",
      ],
    };

    if (latestSnapshot.depth) {
      log(
        "Snapshot captured.",
        "Depth size:",
        `${latestSnapshot.depth.width}x${latestSnapshot.depth.height}`,
        "sampleStep:",
        latestSnapshot.depth.sampleStep,
        "centerDepth:",
        latestSnapshot.centerDepthMeters
      );
    } else {
      log("Snapshot captured, but no depth info returned.");
    }

    downloadJSON(latestSnapshot, "snapshot-depth.json");
    log("snapshot-depth.json download triggered.");
  }
}

enterArBtn.addEventListener("click", async () => {
  try {
    await initAR();
  } catch (err) {
    log("Failed to start AR:", err.message);
  }
});