import { fal } from "@fal-ai/client";

// 通用实时编辑模型：换角色/加物体/换背景/换风格/VFX 全能
// （之前用的 lucy2-vton 只换衣服，做不了假发/美颜这类大改动）
const REALTIME_APP = "decart/lucy-2-5/realtime";

// 默认参考图（项目根目录，连接时自动加载为 character reference）
const DEFAULT_REF_IMAGE_PATH = "/0dea0fb4a4bda8d7f841a86034a72f4c.jpg";

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
const statusPill = $("statusPill");
const outputVideo = $("output");
const previewVideo = $("preview");

let pc = null;           // RTCPeerConnection
let connection = null;   // fal realtime connection
let localStream = null;  // 原始摄像头流（预览用）
let sendStream = null;   // 实际发给模型的流（竖屏时是 canvas 重组流）
let currentRefDataUrl = null; // 当前参考图 data URI

// 竖屏（9:16）重组：macOS 摄像头是横屏 16:9，微信通话窗口是竖屏，
// 先用 canvas 按所选比例裁剪再发给模型，模型输出即为对应比例。
// 比例需与微信视频窗口一致，且 OBS 画布分辨率要同步设置。
const ASPECTS = {
  "9:16": [720, 1280],
  "3:4": [720, 960],
  "4:5": [720, 900],
  "1:1": [720, 720],
  "4:3": [960, 720],
  "16:9": [1280, 720],
};
let portraitCanvas = null;
let portraitCtx = null;
let drawTimer = null;

function setStatus(text, type = "warn") {
  statusPill.textContent = text;
  statusPill.className = type;
}

// 恢复已保存的 API Key（本地输入优先，其次读 .env 配置）
apiKeyEl.value =
  localStorage.getItem("fal_api_key") ||
  import.meta.env.VITE_FAL_KEY ||
  "";

// 纯净模式：隐藏控制面板与小窗，只留变换画面（供 OBS 采集）
let pureMode = false;
function togglePureMode() {
  pureMode = !pureMode;
  $("panel").style.display = pureMode ? "none" : "flex";
  previewVideo.style.display = pureMode ? "none" : "block";
  pureModeBtn.textContent = pureMode ? "退出纯净模式" : "纯净模式";
  pureModeBtn.classList.toggle("on", pureMode);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 参考图压缩：统一缩放到最大边 ≤768px 的 JPEG data URI，
// 减小 WebSocket 负载、加快指令生效（模型只需 ≥512px）
async function toCompressedDataUrl(blob) {
  try {
    const img = await createImageBitmap(blob);
    const scale = Math.min(1, 768 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    img.close();
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch (err) {
    console.warn("参考图压缩失败，使用原始 data URI:", err);
    return fileToDataUrl(blob);
  }
}

// 用 canvas 把横屏摄像头画面中心裁剪重组为所选比例的竖屏流
function createPortraitStream(landscapeStream) {
  const [cw, ch] = ASPECTS[aspectEl.value] || ASPECTS["9:16"];
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
    const fitScale = cw / vw;
    const coverScale = ch / vh;
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

// 加载指定路径的参考图（转成 data URI，因为 Decart 云端无法访问本机 localhost URL）
async function loadRefFromPath(path, label) {
  if (!path) return null;
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
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
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
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

// 切换比例提示需重连生效（canvas 流建立后尺寸固定）
aspectEl.addEventListener("change", () => {
  if (connection) {
    setStatus("比例已修改，请断开后重新连接生效", "warn");
  }
});

connectBtn.addEventListener("click", () =>
  connection ? disconnect() : connect()
);
applyBtn.addEventListener("click", applyEdit);
pureModeBtn.addEventListener("click", togglePureMode);

window.addEventListener("keydown", (e) => {
  if (e.key === "h" || e.key === "H") togglePureMode();
});
