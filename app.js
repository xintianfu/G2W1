const canvas = document.getElementById("xr-canvas");
const logEl = document.getElementById("log");
const enterArBtn = document.getElementById("enter-ar");
const snapshotBtn = document.getElementById("take-snapshot");
const downloadBtn = document.getElementById("download-json");

let gl = null;
let xrSession = null;
let xrRefSpace = null;
let pendingSnapshot = false;
let latestSnapshot = null;

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
    snapshotBtn.disabled = true;
  });

  await gl.makeXRCompatible();

  const baseLayer = new XRWebGLLayer(xrSession, gl);
  xrSession.updateRenderState({ baseLayer });

  xrRefSpace = await xrSession.requestReferenceSpace("local");

  snapshotBtn.disabled = false;
  log("AR session started.");

  xrSession.requestAnimationFrame(onXRFrame);
}

function onXRFrame(time, frame) {
  const session = frame.session;
  const pose = frame.getViewerPose(xrRefSpace);

  session.requestAnimationFrame(onXRFrame);

  gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer.framebuffer);
  gl.clearColor(0.0, 0.0, 0.0, 0.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  if (!pose) return;

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

    latestSnapshot = {
      timestamp: new Date().toISOString(),
      sessionMode: session.mode,
      referenceSpaceType: "local",
      camera: {
        transform: poseToJSON(view.transform),
        projectionMatrix: flattenMatrix(view.projectionMatrix),
      },
      depth: depthInfo ? serializeDepthMap(depthInfo, 8) : null,
      notes: [
        "depth.samplesMeters 是降采样后的深度，单位米",
        "这不是 object-level segmentation，只是 depth map",
        "要区分不同 object，后面还需要 segmentation 或 region annotation",
      ],
    };

    if (latestSnapshot.depth) {
      log(
        "Snapshot captured. Depth size:",
        latestSnapshot.depth.width + "x" + latestSnapshot.depth.height,
        "sampleStep:",
        latestSnapshot.depth.sampleStep
      );
    } else {
      log("Snapshot captured, but no depth info returned.");
    }

    downloadBtn.disabled = false;
  }
}

enterArBtn.addEventListener("click", async () => {
  try {
    await initAR();
  } catch (err) {
    log("Failed to start AR:", err.message);
  }
});

snapshotBtn.addEventListener("click", () => {
  if (!xrSession) {
    log("No XR session.");
    return;
  }

  pendingSnapshot = true;
  log("Snapshot requested. Will capture on next XR frame.");
});

downloadBtn.addEventListener("click", () => {
  if (!latestSnapshot) {
    log("No snapshot data yet.");
    return;
  }

  downloadJSON(latestSnapshot, "snapshot-depth.json");
  log("JSON downloaded.");
});