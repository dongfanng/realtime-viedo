import { fal } from "@fal-ai/client";

// 通用实时编辑模型：换角色/加物体/换背景/换风格/VFX 全能
// （之前用的 lucy2-vton 只换衣服，做不了假发/美颜这类大改动）
const REALTIME_APP = "decart/lucy-2-5/realtime";

// 默认参考图（项目根目录，连接时自动加载为 character reference）
const DEFAULT_REF_IMAGE_PATH = "/ali.png";

const $ = (id) => document.getElementById(id);
const apiKeyEl = $("apiKey");
const promptEl = $("promptInput");
const enhanceEl = $("enhance");
const portraitEl = $("portrait");
const zoomEl = $("zoom");
const aspectEl = $("aspect");
const imageEl = $("imageInput");
const clearRefBtn = $("clearRefBtn");
const refNameEl = $("refName");
const connectBtn = $("connectBtn");
const applyBtn = $("applyBtn");
const pureModeBtn = $("pureModeBtn");
const copySizeBtn = $("copySizeBtn");
const statusPill = $("statusPill");
const outputVideo = $("output");
const outputCanvas = $("outputCanvas");
const previewVideo = $("preview");

let pc = null;           // RTCPeerConnection
let connection = null;   // fal realtime connection
let localStream = null;  // 原始摄像头流（预览用）
let sendStream = null;   // 实际发给模型的流（竖屏时是 canvas 重组流）
let currentRefDataUrl = null; // 当前参考图 data URI
let outputPaintTimer = null;  // OBS 采集用：把 video 帧画到 canvas

// 舞台/发送像素。微信视频窗口实测约 360×640（9:16），OBS 画布请同步。
const ASPECTS = {
  "9:16": [360, 640],
  "9:16@720": [720, 1280],
  "3:4": [720, 960],
  "4:5": [720, 900],
  "1:1": [720, 720],
  "4:3": [960, 720],
  "16:9": [1280, 720],
};

function getStageSize() {
  return ASPECTS[aspectEl.value] || ASPECTS["9:16"];
}

function applyStageSize() {
  const [w, h] = getStageSize();
  document.documentElement.style.setProperty("--stage-w", w + "px");
  document.documentElement.style.setProperty("--stage-h", h + "px");
  if (outputCanvas) {
    outputCanvas.width = w;
    outputCanvas.height = h;
  }
}

// fal realtime 短期 JWT 有效期（秒）；需与 tokenProvider 请求一致，才会自动刷新
const TOKEN_EXPIRATION_SECONDS = 120;
let portraitCanvas = null;
let portraitCtx = null;
let drawTimer = null;

// 用 API Key 换短期 JWT，避免默认 token provider 的弃用警告
async function falTokenProvider(app) {
  const apiKey = apiKeyEl.value.trim();
  if (!apiKey) throw new Error("Missing API Key");
  // /tokens/realtime 要求字段为 app + duration（不是文档旧示例里的 allowed_apps）
  const res = await fetch("https://rest.fal.ai/tokens/realtime", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${apiKey}`,
    },
    body: JSON.stringify({
      app,
      duration: TOKEN_EXPIRATION_SECONDS,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`获取 fal token 失败 (${res.status}): ${text || res.statusText}`);
  }
  const data = await res.json();
  if (typeof data === "string") return data;
  if (data?.token) return data.token;
  if (data?.detail && typeof data.detail === "string") return data.detail;
  throw new Error("fal token 响应格式异常");
}

function setStatus(text, type = "warn") {
  statusPill.textContent = text;
  statusPill.className = type;
}

// 恢复已保存的 API Key（本地输入优先，其次读 .env 配置）
apiKeyEl.value =
  localStorage.getItem("fal_api_key") ||
  import.meta.env.VITE_FAL_KEY ||
  "";

// 纯净模式：只隐藏 UI，舞台保持固定像素（360×640），避免全屏把比例变成显示器的 16:9
let pureMode = false;

function setPureMode(on) {
  pureMode = on;
  $("panel").style.display = on ? "none" : "flex";
  previewVideo.style.display = on ? "none" : "block";
  $("statusPill").style.display = on ? "none" : "block";
  document.body.classList.toggle("pure", on);
  pureModeBtn.textContent = on ? "退出纯净模式" : "纯净模式";
  pureModeBtn.classList.toggle("on", on);
}

function togglePureMode() {
  setPureMode(!pureMode);
  if (pureMode) {
    const [w, h] = getStageSize();
    setStatus(`纯净 ${w}×${h}：OBS 采到标题栏时，按住 Option 拖源边缘裁到蓝框舞台`, "warn");
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 解码参考图：createImageBitmap 失败时回退到 Image 元素（部分 PNG/浏览器组合会解码失败）
async function decodeImageSource(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  } catch {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = "async";
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("图片解码失败"));
        img.src = url;
      });
      if (img.decode) await img.decode().catch(() => {});
      return {
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        close: () => URL.revokeObjectURL(url),
      };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }
}

// 参考图压缩：统一缩放到最大边 ≤768px 的 JPEG data URI，
// 减小 WebSocket 负载、加快指令生效（模型只需 ≥512px）
async function toCompressedDataUrl(blob) {
  try {
    const decoded = await decodeImageSource(blob);
    try {
      const scale = Math.min(1, 768 / Math.max(decoded.width, decoded.height));
      const w = Math.max(1, Math.round(decoded.width * scale));
      const h = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(decoded.source, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.85);
    } finally {
      decoded.close();
    }
  } catch (err) {
    console.warn("参考图压缩失败，使用原始 data URI:", err);
    return fileToDataUrl(blob);
  }
}

// 用 canvas 把横屏摄像头画面中心裁剪重组为所选比例的竖屏流
function createPortraitStream(landscapeStream) {
  const [cw, ch] = getStageSize();
  portraitCanvas = document.createElement("canvas");
  portraitCanvas.width = cw;
  portraitCanvas.height = ch;
  portraitCtx = portraitCanvas.getContext("2d");

  const draw = () => {
    drawTimer = requestAnimationFrame(draw);
    const vw = previewVideo.videoWidth;
    const vh = previewVideo.videoHeight;
    if (!vw || !vh) return;
    // 缩放 0~100：0 = 完整显示原画面（fit，上下黑边），100 = 裁满画布（cover，放大）
    // 默认 55 为人像正常大小，可实时调节
    const zoom = Number(zoomEl.value) / 100;
    const fitScale = Math.min(cw / vw, ch / vh);
    const coverScale = Math.max(cw / vw, ch / vh);
    const s = fitScale + (coverScale - fitScale) * zoom;
    const dw = vw * s;
    const dh = vh * s;
    portraitCtx.fillStyle = "#000";
    portraitCtx.fillRect(0, 0, cw, ch);
    portraitCtx.drawImage(previewVideo, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  };
  draw();

  const canvasStream = portraitCanvas.captureStream(30);
  const out = new MediaStream();
  out.addTrack(canvasStream.getVideoTracks()[0]);
  landscapeStream.getAudioTracks().forEach((t) => out.addTrack(t));
  return out;
}

function stopPortrait() {
  if (drawTimer) cancelAnimationFrame(drawTimer);
  drawTimer = null;
  portraitCanvas = null;
  portraitCtx = null;
}

// OBS Browser Source 对 WebRTC <video> 常只显示首帧；每帧画到 canvas 才能持续刷新
function stopOutputPaint() {
  if (outputPaintTimer) cancelAnimationFrame(outputPaintTimer);
  outputPaintTimer = null;
  if (outputCanvas) {
    const ctx = outputCanvas.getContext("2d");
    ctx && ctx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
  }
}

function startOutputPaint() {
  stopOutputPaint();
  applyStageSize();
  const ctx = outputCanvas.getContext("2d");
  const paint = () => {
    outputPaintTimer = requestAnimationFrame(paint);
    const vw = outputVideo.videoWidth;
    const vh = outputVideo.videoHeight;
    if (!vw || !vh) return;

    const [cw, ch] = getStageSize();
    if (outputCanvas.width !== cw || outputCanvas.height !== ch) {
      outputCanvas.width = cw;
      outputCanvas.height = ch;
    }

    // cover：铺满舞台，与 OBS 360×640 画布对齐，不留黑边
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(outputVideo, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  };
  paint();
}

// 加载指定路径的参考图（转成 data URI，因为 Decart 云端无法访问本机 localhost URL）
async function loadRefFromPath(path, label) {
  if (!path) return null;
  try {
    const res = await fetch(encodeURI(path));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const type = blob.type || res.headers.get("content-type") || "";
    if (type && !type.startsWith("image/")) {
      throw new Error("非图片响应: " + type);
    }
    const dataUrl = await toCompressedDataUrl(blob);
    currentRefDataUrl = dataUrl;
    refNameEl.textContent = "参考图: " + (label || path);
    return dataUrl;
  } catch (err) {
    console.warn("参考图加载失败:", path, err);
    return null;
  }
}

async function getCameraStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前环境不支持摄像头（getUserMedia 不可用）");
  }
  const videoConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: videoConstraints,
    });
  } catch (err) {
    const name = err?.name || "";
    const msg = String(err?.message || err || "");
    // 麦克风被拒时再试仅视频，避免整条链路挂掉
    if (name === "NotAllowedError" || /permission|denied/i.test(msg)) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: videoConstraints,
        });
      } catch (err2) {
        throw new Error(
          "摄像头权限被拒绝（OBS 内置浏览器常无法弹出授权）。请改用：Chrome 打开本页点连接 → OBS 用主列表「macOS 屏幕采集」抓 Chrome；" +
            "不要在 OBS 浏览器源里点连接。若必须用浏览器源，可用终端启动：/Applications/OBS.app/Contents/MacOS/OBS --use-fake-ui-for-media-stream"
        );
      }
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      throw new Error("未找到摄像头设备");
    }
    if (name === "NotReadableError" || name === "TrackStartError" || /in use|busy|could not start/i.test(msg)) {
      throw new Error("摄像头被占用：请先断开 Chrome/其他应用里的摄像头，再在 OBS 里连接");
    }
    throw err;
  }
}

// fal realtime WebRTC 信令处理（协议见 fal.ai 官方模型页示例）
async function handleResult(result) {
  try {
    switch (result.type) {
      case "iceservers":
      case "iceServers": {
        const servers = (result.iceservers || result.iceServers || result.ice_servers || [])
          .map((s) => ({ urls: s.urls, username: s.username, credential: s.credential }));

        pc = new RTCPeerConnection({ iceServers: servers });
        sendStream.getTracks().forEach((track) => pc.addTrack(track, sendStream));

        pc.ontrack = (e) => {
          outputVideo.srcObject = e.streams[0];
          outputVideo.play().catch(() => {});
          startOutputPaint();
          // 记录模型实际输出的画面尺寸，便于核对比例
          outputVideo.onloadedmetadata = () => {
            const w = outputVideo.videoWidth;
            const h = outputVideo.videoHeight;
            console.log("模型输出尺寸:", w + "x" + h, "选择比例:", aspectEl.value);
            setStatus(`已连接，输出 ${w}x${h}`, "ok");
          };
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            connection.send({
              type: "icecandidate",
              candidate: {
                candidate: e.candidate.candidate,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex,
              },
            });
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        connection.send({ type: "offer", sdp: offer.sdp });
        break;
      }
      case "answer":
        await pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
        break;
      case "icecandidate":
        await pc.addIceCandidate(new RTCIceCandidate(result.candidate));
        break;
      case "ice-restart":
        if (result.turn_config && pc) {
          pc.setConfiguration({
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              {
                urls: result.turn_config.server_url,
                username: result.turn_config.username,
                credential: result.turn_config.credential,
              },
            ],
          });
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          connection.send({ type: "offer", sdp: offer.sdp });
        }
        break;
      case "prompt_ack":
        if (!result.success) console.error("Prompt failed:", result.error);
        break;
      case "set_image_ack":
        if (!result.success) console.error("Image failed:", result.error);
        break;
      case "generation_started":
        setStatus("模型开始生成画面…", "ok");
        break;
      case "error":
        console.error("Server error:", result.error);
        setStatus("服务端错误: " + (result.error || ""), "err");
        break;
      default:
        console.log("未处理的消息:", result);
    }
  } catch (err) {
    console.error("handleResult error:", err);
    setStatus("信令错误: " + (err?.message || err), "err");
  }
}

async function connect() {
  const apiKey = apiKeyEl.value.trim();
  if (!apiKey) {
    setStatus("请先填写 API Key", "err");
    return;
  }
  localStorage.setItem("fal_api_key", apiKey);
  fal.config({ credentials: apiKey });

  try {
    setStatus("正在请求摄像头…", "warn");
    localStream = await getCameraStream();
    previewVideo.srcObject = localStream;
    await previewVideo.play().catch(() => {});

    // 竖屏开关：勾选时用 canvas 重组为 9:16 竖屏流发给模型
    sendStream = portraitEl.checked ? createPortraitStream(localStream) : localStream;
    setStatus("正在连接 Lucy…", "warn");
    connection = fal.realtime.connect(REALTIME_APP, {
      connectionKey: `session-${Date.now()}`,
      throttleInterval: 0,
      tokenProvider: falTokenProvider,
      tokenExpirationSeconds: TOKEN_EXPIRATION_SECONDS,
      onResult: handleResult,
      onError: (err) => {
        console.error("realtime error:", err);
        setStatus("连接错误: " + (err?.message || err), "err");
      },
    });

    // 加载默认参考图（若无手动选择），并作为初始状态发送；
    // 未填指令但带参考图时，默认执行角色替换
    if (!currentRefDataUrl) await loadRefFromPath(DEFAULT_REF_IMAGE_PATH, "默认");
    const initialPrompt =
      promptEl.value.trim() ||
      (currentRefDataUrl
        ? "Substitute the character in the video with the person in the reference image."
        : "");
    connection.send({
      ...(initialPrompt ? { prompt: initialPrompt, enable_prompt_expansion: enhanceEl.checked } : {}),
      ...(currentRefDataUrl ? { reference_image_url: currentRefDataUrl } : {}),
    });

    connectBtn.textContent = "断开";
    connectBtn.classList.add("danger");
    setStatus("已连接，等待变换画面…", "ok");
  } catch (err) {
    console.error("connect failed:", err);
    setStatus("连接失败: " + (err?.message || err), "err");
    stopPortrait();
    if (sendStream && sendStream !== localStream) {
      sendStream.getTracks().forEach((t) => t.stop());
    }
    sendStream = null;
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
  }
}

function disconnect() {
  if (pc) { pc.close(); pc = null; }
  if (connection) { try { connection.close(); } catch {} connection = null; }
  stopPortrait();
  stopOutputPaint();
  if (sendStream && sendStream !== localStream) {
    sendStream.getTracks().forEach((t) => t.stop());
  }
  sendStream = null;
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  previewVideo.srcObject = null;
  outputVideo.srcObject = null;
  connectBtn.textContent = "连接";
  connectBtn.classList.remove("danger");
  setStatus("未连接", "warn");
}

async function applyEdit() {
  if (!connection) {
    setStatus("请先连接", "warn");
    return;
  }
  try {
    const promptText = promptEl.value.trim();
    const imageFile = imageEl.files[0];
    if (!promptText && !imageFile && !currentRefDataUrl) {
      setStatus("请输入指令或选择参考图", "warn");
      return;
    }

    // 新选了参考图则压缩转成 data URI
    if (imageFile) {
      currentRefDataUrl = await toCompressedDataUrl(imageFile);
      refNameEl.textContent = "参考图: " + imageFile.name;
    }

    connection.send({
      ...(promptText ? { prompt: promptText, enable_prompt_expansion: enhanceEl.checked } : {}),
      ...(currentRefDataUrl ? { reference_image_url: currentRefDataUrl } : {}),
    });
    setStatus("指令已发送: " + (promptText || "(仅参考图)"), "ok");
  } catch (err) {
    console.error("send failed:", err);
    setStatus("发送失败: " + (err?.message || err), "err");
  }
}

// 预设指令 chip：设置 prompt，带 data-ref 的还会先加载对应参考图
document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", async () => {
    promptEl.value = chip.dataset.p;
    if (chip.dataset.ref) {
      await loadRefFromPath(chip.dataset.ref, chip.dataset.refname || "参考图");
    }
    applyEdit();
  });
});

// 选择参考图时立即显示文件名
imageEl.addEventListener("change", () => {
  if (imageEl.files[0]) {
    refNameEl.textContent = "参考图: " + imageEl.files[0].name;
  }
});

// 清除参考图：回到纯文字编辑模式
clearRefBtn.addEventListener("click", () => {
  currentRefDataUrl = null;
  imageEl.value = "";
  refNameEl.textContent = "";
  setStatus("已清除参考图（纯文字模式）", "warn");
});

// 切换比例：立刻改舞台像素；已连接时需重连才能改发送流尺寸
aspectEl.addEventListener("change", () => {
  applyStageSize();
  const [w, h] = getStageSize();
  if (connection) {
    setStatus(`舞台 ${w}×${h}；请断开后重新连接以同步发送尺寸`, "warn");
  } else {
    setStatus(`舞台 ${w}×${h}（OBS 画布请设为相同）`, "warn");
  }
});

copySizeBtn?.addEventListener("click", async () => {
  const [w, h] = getStageSize();
  const text = `${w}x${h}`;
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`已复制 OBS 画布尺寸 ${text}`, "ok");
  } catch {
    setStatus(`OBS 画布请设为 ${text}`, "warn");
  }
});

applyStageSize();

connectBtn.addEventListener("click", () =>
  connection ? disconnect() : connect()
);
applyBtn.addEventListener("click", applyEdit);
pureModeBtn.addEventListener("click", togglePureMode);

window.addEventListener("keydown", (e) => {
  if (e.key === "h" || e.key === "H") togglePureMode();
});
