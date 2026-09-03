import { useRef, useEffect, useState, useCallback } from 'react';
import {
  HandLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';
import './HandTracker.css';

// Random artwork pool shown inside the viewfinder frame
const ART_NAMES = [
  'art-aurora',
  'art-sunset',
  'art-ocean',
  'art-forest',
  'art-space',
  'art-rainbow',
];
// BASE_URL 在 GitHub Pages 部署时为 "/hands_gesture/"，本地开发为 "/"
const ART_FILES = ART_NAMES.map((name) => `${import.meta.env.BASE_URL}images/${name}.svg`);

const COLORS = ['#00FF88', '#FF6B6B'];

// ---- Model / WASM 多源加载 ----
// github.io 在国内访问不稳定，20MB 的 wasm+模型常被卡住。
// 生产环境优先走 CDN（jsDelivr / unpkg 均带 CORS），本地文件兜底；开发环境反之。
const TASKS_WASM_VERSION = '1.0.1';
const MODEL_GH_CDN = `https://cdn.jsdelivr.net/gh/JacobAGY/hands_gesture@main/public/models/hand_landmarker.task`;
const LOCAL_BASE = import.meta.env.BASE_URL;

interface ModelSource {
  name: string;
  wasmDir: string;
  modelPath: string;
}

const CDN_SOURCES: ModelSource[] = [
  {
    name: 'jsDelivr CDN',
    wasmDir: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_WASM_VERSION}/wasm`,
    modelPath: MODEL_GH_CDN,
  },
  {
    name: 'unpkg CDN',
    wasmDir: `https://unpkg.com/@mediapipe/tasks-vision@${TASKS_WASM_VERSION}/wasm`,
    modelPath: MODEL_GH_CDN,
  },
  {
    name: 'this site',
    wasmDir: `${LOCAL_BASE}wasm`,
    modelPath: `${LOCAL_BASE}models/hand_landmarker.task`,
  },
];

// 开发环境优先用本地（快且不依赖外网）；生产环境优先 CDN
const MODEL_SOURCES: ModelSource[] = import.meta.env.DEV
  ? [...CDN_SOURCES].reverse()
  : CDN_SOURCES;

// 👍 手势触发的视频地址（MOCK：先用公开示例视频，之后替换成真实地址即可）
const VIDEO_TRIGGER_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// 洗牌牌堆换图：从打乱后的序号里按游标取下一张，保证连抽不重复。
// 一轮走完（或首次）重新洗牌；若新牌堆首张与当前图相同则挪到末尾，跨牌堆也不会重复。
function pickNextArtIndex(
  poolLength: number,
  currentIndex: number,
  order: { current: number[] | null },
  cursor: { current: number }
): number {
  if (poolLength <= 1) return 0;
  if (!order.current || cursor.current + 1 >= order.current.length) {
    order.current = Array.from({ length: poolLength }, (_, i) => i);
    shuffleArray(order.current);
    if (order.current[0] === currentIndex && order.current.length > 1) {
      order.current.push(order.current.shift()!);
    }
    cursor.current = -1;
  }
  cursor.current += 1;
  return order.current[cursor.current];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function createLandmarkerFromSource(source: ModelSource): Promise<HandLandmarker | null> {
  let vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
  try {
    vision = await withTimeout(FilesetResolver.forVisionTasks(source.wasmDir), 25000);
  } catch (err) {
    console.warn(`[model] ${source.name}: failed to load WASM engine`, err);
    return null;
  }
  for (const delegate of ['GPU', 'CPU'] as const) {
    try {
      const landmarker = await withTimeout(
        HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: source.modelPath,
            delegate,
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }),
        30000
      );
      return landmarker;
    } catch (err) {
      console.warn(`[model] ${source.name}/${delegate}: failed`, err);
    }
  }
  return null;
}

interface Anchor {
  x: number;
  y: number;
  color: string;
}

interface HandData {
  landmarks: NormalizedLandmark[];
  handedness: string;
  score: number;
}

export default function HandTracker() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const animFrameRef = useRef<number>(0);
  const lastVideoTimeRef = useRef<number>(-1);
  const streamRef = useRef<MediaStream | null>(null);

  const artImagesRef = useRef<HTMLImageElement[]>([]);
  const curArtRef = useRef<HTMLImageElement | null>(null);
  const curArtIndexRef = useRef<number>(-1);
  // 不重复选图：洗牌后的播放顺序 + 游标，一轮 6 张走完才会重新洗牌
  const artOrderRef = useRef<number[] | null>(null);
  const artCursorRef = useRef(-1);
  // 换图状态机：取景框中断一段时间后，再次张开才换新图
  const noFrameSinceRef = useRef<number | null>(null);
  const armedRef = useRef(true);
  // 👍 视频手势状态机：姿势保持 ~800ms 触发一次
  const videoPoseSinceRef = useRef<number | null>(null);
  const videoFiredRef = useRef(false);
  const videoLastOpenedRef = useRef(0);

  const [status, setStatus] = useState<'starting' | 'ready' | 'error'>('starting');
  const [statusMsg, setStatusMsg] = useState('Loading vision model...');
  const [cameraOk, setCameraOk] = useState(false);
  const [modelOk, setModelOk] = useState(false);
  const [handCount, setHandCount] = useState(0);
  const [framing, setFraming] = useState(false);
  const [hint, setHint] = useState('Starting…');
  const [hands, setHands] = useState<HandData[]>([]);
  const [videoOpen, setVideoOpen] = useState(false);
  const overlayVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    artImagesRef.current = ART_FILES.map((src) => {
      const img = new Image();
      img.src = src;
      return img;
    });
  }, []);

  const initHandLandmarker = useCallback(async () => {
    for (const source of MODEL_SOURCES) {
      setStatusMsg(`Loading AI engine from ${source.name}...`);
      const landmarker = await createLandmarkerFromSource(source);
      if (landmarker) {
        handLandmarkerRef.current = landmarker;
        console.info(`[model] initialized via ${source.name}`);
        return true;
      }
    }
    console.error('[model] all sources failed');
    setStatusMsg(
      'Model load failed: all sources unreachable. Check your network, then retry.'
    );
    setStatus('error');
    return false;
  }, []);

  const startWebcam = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      return true;
    } catch (err) {
      console.error('Failed to access webcam:', err);
      setStatusMsg('Camera access failed: ' + (err as Error).message);
      setStatus('error');
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const camOk = await startWebcam();
      if (cancelled) return;
      if (camOk) setCameraOk(true);

      const mdlOk = await initHandLandmarker();
      if (cancelled) return;
      if (mdlOk) setModelOk(true);
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrameRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [startWebcam, initHandLandmarker]);

  useEffect(() => {
    if (cameraOk && modelOk) {
      setStatus('ready');
      setStatusMsg('');
    } else if (status === 'starting' && !cameraOk) {
      setStatusMsg('Opening camera...');
    } else if (status === 'starting' && cameraOk && !modelOk) {
      setStatusMsg('Camera ready, loading model...');
    }
  }, [cameraOk, modelOk, status]);

  useEffect(() => {
    if (status !== 'ready') return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const hlm = handLandmarkerRef.current;
    if (!video || !canvas || !hlm) return;

    const ctx = canvas.getContext('2d')!;

    // Poll until video dimensions are available (videoWidth can be 0 on loadeddata)
    let sizeTimer = window.setInterval(() => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        window.clearInterval(sizeTimer);
        sizeTimer = 0;
        detectLoop();
      }
    }, 100);

    const detectLoop = () => {
      const now = performance.now();
      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime;
        const result: HandLandmarkerResult = hlm.detectForVideo(video, now);

        const frame = buildFrameFromHands(result, canvas.width, canvas.height);

        // 👍 视频手势：任一手指向镜头伸出拇指（其余手指收拢）并保持 ~800ms
        const thumbsUpNow = result.landmarks.some((lm) => thumbsUpPose(lm));
        if (thumbsUpNow) {
          const vt = performance.now();
          if (videoPoseSinceRef.current === null) {
            videoPoseSinceRef.current = vt;
          }
          if (
            !videoFiredRef.current &&
            vt - videoPoseSinceRef.current > 800 &&
            vt - videoLastOpenedRef.current > 2500
          ) {
            videoFiredRef.current = true;
            videoLastOpenedRef.current = vt;
            setVideoOpen(true);
          }
        } else {
          videoPoseSinceRef.current = null;
          videoFiredRef.current = false;
        }

        // 换图规则：只要取景框中断超过 ~250ms（收拢手指/放下手都可以），
        // 下一次张开成框就换图 —— 洗牌顺序保证连续两次不重复。
        const t = performance.now();
        if (frame) {
          if (armedRef.current || !curArtRef.current) {
            curArtIndexRef.current = pickNextArtIndex(
              artImagesRef.current.length,
              curArtIndexRef.current,
              artOrderRef,
              artCursorRef
            );
            curArtRef.current = artImagesRef.current[curArtIndexRef.current] ?? null;
            armedRef.current = false;
          }
          noFrameSinceRef.current = null;
        } else {
          if (noFrameSinceRef.current === null) {
            noFrameSinceRef.current = t;
          } else if (t - noFrameSinceRef.current > 250) {
            armedRef.current = true;
          }
        }

        drawResults(ctx, frame, canvas.width, canvas.height, now);

        setHandCount(result.landmarks.length);
        setHands(
          result.landmarks.map((lm, i) => ({
            landmarks: lm,
            handedness: result.handedness[i]?.[0]?.categoryName ?? 'Unknown',
            score: result.handedness[i]?.[0]?.score ?? 0,
          }))
        );
        setFraming(!!frame);
        setHint(
          frame
            ? 'Viewfinder ready!'
            : thumbsUpNow
              ? videoFiredRef.current
                ? '👍 Opening video...'
                : '👍 Hold to open the video'
              : result.landmarks.length === 0
                ? 'Show both palms to the camera 🙌'
                : result.landmarks.length === 1
                  ? 'One hand detected — show the other one ✋'
                  : armedRef.current
                    ? 'Armed! Spread thumbs & index again to load a new image'
                    : 'Fold fingers to arm, then spread to switch the image'
        );
      }
      animFrameRef.current = requestAnimationFrame(detectLoop);
    };

    return () => {
      window.clearInterval(sizeTimer);
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [status]);

  // 自动播放：手势触发属于"无用户激活"，带声播放可能被浏览器拦截，
  // 拦截时退回静音自动播放，点一下画面即可开启声音/进入全屏。
  useEffect(() => {
    if (!videoOpen) return;
    const v = overlayVideoRef.current;
    if (!v) return;
    const tryPlay = async () => {
      try {
        v.muted = false;
        await v.play();
      } catch {
        v.muted = true;
        try {
          await v.play();
        } catch {
          // 完全无法自动播放时保留画面，用户点击后播放
        }
      }
    };
    void tryPlay();
    return () => {
      v.pause();
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  }, [videoOpen]);

  // ---- Four-finger gesture detection & viewfinder construction ----

  const dist = (a: NormalizedLandmark, b: NormalizedLandmark) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  // Index extended when the tip sits clearly farther from the knuckle than the PIP joint
  const indexExtended = (lm: NormalizedLandmark[]) => dist(lm[8], lm[5]) > dist(lm[7], lm[5]) * 1.05;
  // Thumb spread open when the tip stays far from the pinky knuckle
  const thumbExtended = (lm: NormalizedLandmark[]) => dist(lm[4], lm[17]) > dist(lm[2], lm[17]) * 1.05;

  // Thumb-up pose: thumb extended upward while the other fingers stay bent inward.
  // Uses only relative finger-tip distances so it works in any hand rotation.
  const thumbsUpPose = (lm: NormalizedLandmark[]) =>
    dist(lm[4], lm[17]) > dist(lm[2], lm[17]) * 1.08 &&
    dist(lm[8], lm[5]) < dist(lm[7], lm[5]) * 0.98 &&
    dist(lm[12], lm[9]) < dist(lm[11], lm[9]) * 0.98 &&
    dist(lm[16], lm[13]) < dist(lm[15], lm[13]) * 0.98 &&
    dist(lm[20], lm[17]) < dist(lm[19], lm[17]) * 0.98;

  // Build the viewfinder quad from the four fingertips; null when the pose is incomplete
  function buildFrameFromHands(
    result: HandLandmarkerResult,
    w: number,
    h: number
  ): Anchor[] | null {
    if (!result.landmarks || result.landmarks.length < 2) return null;

    const a = result.landmarks[0];
    const b = result.landmarks[1];
    if (!indexExtended(a) || !thumbExtended(a)) return null;
    if (!indexExtended(b) || !thumbExtended(b)) return null;

    // Raw camera coordinates (unmirrored): the display layer applies scaleX(-1),
    // so the hand on the LEFT side of the screen has the LARGER x in the image.
    const idxTips = [a[8], b[8]];
    const thbTips = [a[4], b[4]];
    const lt = idxTips[0].x > idxTips[1].x ? idxTips[0] : idxTips[1];
    const rt = idxTips[0].x > idxTips[1].x ? idxTips[1] : idxTips[0];
    const lb = thbTips[0].x > thbTips[1].x ? thbTips[0] : thbTips[1];
    const rb = thbTips[0].x > thbTips[1].x ? thbTips[1] : thbTips[0];

    // Skip degenerate frames (fingers too close together)
    const topLen = Math.hypot((lt.x - rt.x) * w, (lt.y - rt.y) * h);
    const height = Math.hypot((lt.x - lb.x) * w, (lt.y - lb.y) * h);
    if (topLen < 50 || height < 30) return null;

    return [
      { x: lt.x, y: lt.y, color: COLORS[0] },
      { x: rt.x, y: rt.y, color: COLORS[1] },
      { x: rb.x, y: rb.y, color: COLORS[1] },
      { x: lb.x, y: lb.y, color: COLORS[0] },
    ];
  }

  function drawResults(
    ctx: CanvasRenderingContext2D,
    frame: Anchor[] | null,
    w: number,
    h: number,
    _now: number
  ) {
    ctx.clearRect(0, 0, w, h);
    if (!frame) return;
    drawFrame(ctx, frame, w, h);
  }

  function drawFrame(
    ctx: CanvasRenderingContext2D,
    frame: Anchor[],
    w: number,
    h: number
  ) {
    const [lt, rt, rb, lb] = frame;

    const minX = Math.min(lt.x, rt.x, rb.x, lb.x) * w;
    const maxX = Math.max(lt.x, rt.x, rb.x, lb.x) * w;
    const minY = Math.min(lt.y, rt.y, rb.y, lb.y) * h;
    const maxY = Math.max(lt.y, rt.y, rb.y, lb.y) * h;

    const quad = new Path2D();
    quad.moveTo(lt.x * w, lt.y * h);
    quad.lineTo(rt.x * w, rt.y * h);
    quad.lineTo(rb.x * w, rb.y * h);
    quad.lineTo(lb.x * w, lb.y * h);
    quad.closePath();

    // Natural "held plate" look (like the reference clip): the artwork sits on a
    // shadowed quad with a crisp thin edge — no neon glow, no HUD brackets.
    const art = curArtRef.current;

    // Drop shadow pass first so the plate visually floats above the video.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 22;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.95)';
    ctx.fill(quad);
    ctx.restore();

    if (art && art.naturalWidth > 0) {
      const iw = art.naturalWidth;
      const ih = art.naturalHeight;
      const fw = maxX - minX;
      const fh = maxY - minY;
      const scale = Math.max(fw / iw, fh / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = minX + (fw - dw) / 2;
      const dy = minY + (fh - dh) / 2;
      ctx.save();
      ctx.clip(quad);
      ctx.drawImage(art, dx, dy, dw, dh);
      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke(quad);
  }

  return (
    <div className="hand-tracker">
      <div className={`viewport-container ${framing ? 'framing' : handCount > 0 ? 'has-hands' : ''}`}>
        <video ref={videoRef} className="webcam-video" autoPlay playsInline muted />

        <canvas ref={canvasRef} className="overlay-canvas" />

        {status === 'starting' && !cameraOk && (
          <div className="status-overlay">
            <div className="spinner" />
            <p>{statusMsg}</p>
          </div>
        )}

        {status === 'starting' && cameraOk && !modelOk && (
          <div className="status-overlay small">
            <div className="spinner small" />
            <p>{statusMsg}</p>
          </div>
        )}

        {status === 'error' && (
          <div className="status-overlay error">
            <p>⚠️ {statusMsg}</p>
            <button onClick={() => window.location.reload()} className="retry-btn">
              Retry
            </button>
          </div>
        )}

        {status === 'ready' && (
          <div className={`hand-count-badge ${framing ? 'active' : ''}`}>
            <span className="hand-icon">🖐️</span>
            <span className="hand-count-text">
              Hands detected: <strong>{handCount}</strong>
            </span>
          </div>
        )}

        {status === 'ready' && (
          <div className={`hint-overlay ${framing ? 'done' : ''}`}>{hint}</div>
        )}
      </div>

      {status === 'ready' && hands.length > 0 && (
        <div className="hands-info">
          {hands.map((hand, i) => (
            <div key={i} className="hand-info-card" style={{ borderColor: COLORS[i % COLORS.length] }}>
              <span className="hand-label" style={{ color: COLORS[i % COLORS.length] }}>
                {hand.handedness === 'Left' ? 'Left Hand' : 'Right Hand'}
              </span>
              <span className="hand-score">Confidence: {(hand.score * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}

      {videoOpen && (
        <div className="video-overlay" onClick={() => setVideoOpen(false)}>
          <video
            ref={overlayVideoRef}
            className="video-overlay-player"
            src={VIDEO_TRIGGER_URL}
            playsInline
            loop
            onClick={(e) => {
              e.stopPropagation();
              const v = overlayVideoRef.current;
              if (!v) return;
              if (document.fullscreenElement) {
                void document.exitFullscreen().catch(() => {});
              } else {
                void v.requestFullscreen?.().catch(() => {});
              }
            }}
          />
          <button
            className="video-overlay-close"
            aria-label="Close video"
            onClick={(e) => {
              e.stopPropagation();
              setVideoOpen(false);
            }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}