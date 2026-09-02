import { useRef, useEffect, useState, useCallback } from 'react';
import {
  HandLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';
import './HandTracker.css';

// Random artwork pool shown inside the viewfinder frame
const ART_FILES = [
  '/images/art-aurora.svg',
  '/images/art-sunset.svg',
  '/images/art-ocean.svg',
  '/images/art-forest.svg',
  '/images/art-space.svg',
  '/images/art-rainbow.svg',
];

const COLORS = ['#00FF88', '#FF6B6B'];

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
  const wasFramingRef = useRef(false);

  const [status, setStatus] = useState<'starting' | 'ready' | 'error'>('starting');
  const [statusMsg, setStatusMsg] = useState('Loading vision model...');
  const [cameraOk, setCameraOk] = useState(false);
  const [modelOk, setModelOk] = useState(false);
  const [handCount, setHandCount] = useState(0);
  const [framing, setFraming] = useState(false);
  const [hint, setHint] = useState('Starting…');
  const [hands, setHands] = useState<HandData[]>([]);

  useEffect(() => {
    artImagesRef.current = ART_FILES.map((src) => {
      const img = new Image();
      img.src = src;
      return img;
    });
  }, []);

  const initHandLandmarker = useCallback(async () => {
    try {
      setStatusMsg('Loading vision model...');
      const wasmBase = new URL('/wasm', window.location.origin).toString();
      const vision = await FilesetResolver.forVisionTasks(wasmBase);

      setStatusMsg('Initializing hand tracking...');
      const create = async (delegate: 'GPU' | 'CPU') => {
        try {
          return await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: '/models/hand_landmarker.task',
              delegate,
            },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
        } catch (err) {
          console.warn('HandLandmarker init failed with delegate:', delegate, err);
          return null;
        }
      };

      const landmarker = (await create('GPU')) ?? (await create('CPU'));
      if (!landmarker) throw new Error('Hand tracker failed to initialize (GPU & CPU)');
      handLandmarkerRef.current = landmarker;
      return true;
    } catch (err) {
      console.error('Failed to load HandLandmarker:', err);
      setStatusMsg('Model load failed: ' + (err as Error).message);
      setStatus('error');
      return false;
    }
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

        // Pick a new random artwork each time a new framing session starts
        if (frame && !wasFramingRef.current) {
          const pool = artImagesRef.current;
          curArtRef.current = pool[Math.floor(Math.random() * pool.length)] ?? null;
        }
        wasFramingRef.current = !!frame;

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
            : result.landmarks.length === 0
              ? 'Show both palms to the camera 🙌'
              : result.landmarks.length === 1
                ? 'One hand detected — show the other one ✋'
                : 'Spread both hands: extend thumbs & index fingers to frame'
        );
      }
      animFrameRef.current = requestAnimationFrame(detectLoop);
    };

    return () => {
      window.clearInterval(sizeTimer);
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [status]);

  // ---- Four-finger gesture detection & viewfinder construction ----

  const dist = (a: NormalizedLandmark, b: NormalizedLandmark) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  // Index extended when the tip sits clearly farther from the knuckle than the PIP joint
  const indexExtended = (lm: NormalizedLandmark[]) => dist(lm[8], lm[5]) > dist(lm[7], lm[5]) * 1.05;
  // Thumb spread open when the tip stays far from the pinky knuckle
  const thumbExtended = (lm: NormalizedLandmark[]) => dist(lm[4], lm[17]) > dist(lm[2], lm[17]) * 1.05;

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
    now: number
  ) {
    ctx.clearRect(0, 0, w, h);
    if (!frame) return;
    drawFrame(ctx, frame, w, h, now);
  }

  function drawFrame(
    ctx: CanvasRenderingContext2D,
    frame: Anchor[],
    w: number,
    h: number,
    now: number
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

    // 1) Dim everything outside the frame
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.moveTo(lb.x * w, lb.y * h);
    ctx.lineTo(rb.x * w, rb.y * h);
    ctx.lineTo(rt.x * w, rt.y * h);
    ctx.lineTo(lt.x * w, lt.y * h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fill('evenodd');

    // 2) Random artwork inside the frame (cover-fit, clipped)
    const art = curArtRef.current;
    if (art && art.naturalWidth > 0) {
      const iw = art.naturalWidth;
      const ih = art.naturalHeight;
      const scale = Math.max((maxX - minX) / iw, (maxY - minY) / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = (minX + maxX) / 2 - dw / 2;
      const dy = (minY + maxY) / 2 - dh / 2;
      ctx.save();
      ctx.clip(quad);
      ctx.drawImage(art, dx, dy, dw, dh);
      ctx.restore();
    }

    // 3) Glowing edges + rule-of-thirds grid + corner brackets + focus reticle
    ctx.strokeStyle = '#00FF88';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#00FF88';
    ctx.shadowBlur = 14;
    ctx.stroke(quad);
    ctx.shadowBlur = 0;

    ctx.save();
    ctx.clip(quad);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    for (let t = 1; t <= 2; t++) {
      const gx = minX + ((maxX - minX) * t) / 3;
      const gy = minY + ((maxY - minY) * t) / 3;
      ctx.moveTo(gx, minY);
      ctx.lineTo(gx, maxY);
      ctx.moveTo(minX, gy);
      ctx.lineTo(maxX, gy);
    }
    ctx.stroke();
    ctx.restore();

    const topLen = Math.hypot((lt.x - rt.x) * w, (lt.y - rt.y) * h);
    const corner = Math.min(22, Math.max(10, topLen * 0.12));
    for (const [pt, dx, dy] of [
      [lt, 1, 1],
      [rt, -1, 1],
      [rb, -1, -1],
      [lb, 1, -1],
    ] as const) {
      const px = pt.x * w;
      const py = pt.y * h;
      ctx.strokeStyle = pt.color;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(px + dx * corner, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + dy * corner);
      ctx.stroke();
    }

    const cx = (lt.x + rt.x + rb.x + lb.x) * 0.25 * w;
    const cy = (lt.y + rt.y + rb.y + lb.y) * 0.25 * h;
    const pulse = 0.5 + 0.5 * Math.sin(now / 400);
    const radius = 12 + pulse * 8;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0, 255, 136, ${0.5 + pulse * 0.5})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 255, 136, 0.9)';
    ctx.fill();
  }

  return (
    <div className="hand-tracker">
      <div className={`viewport-container ${framing ? 'framing' : handCount > 0 ? 'has-hands' : ''}`}>
        <video ref={videoRef} className="webcam-video" autoPlay playsInline muted />

        <div className="vf-corner vf-tl" />
        <div className="vf-corner vf-tr" />
        <div className="vf-corner vf-bl" />
        <div className="vf-corner vf-br" />

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
    </div>
  );
}