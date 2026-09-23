import { useRef, useEffect, useState, useCallback } from 'react';
import {
  HandLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';
import './HandTracker.css';
import { SUBMISSIONS } from '../data/submissions';

// 第一部分活动照片：Excel 全部 15 件投稿，每次打开页面随机选出 8 件展示。
// 真实照片位于 public/images/submissions/<作品序号>.jpg。
const POOL_SIZE = 8;
const ART_FILES = SUBMISSIONS.map((s) => s.image);
const ART_NAMES = SUBMISSIONS.map((s) => `#${s.id} ${s.title} — ${s.author}`);

function pickRandomPool(): number[] {
  const idx = SUBMISSIONS.map((_, i) => i);
  shuffleArray(idx);
  return idx.slice(0, POOL_SIZE);
}

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

// 两阶段流转：1 双手展开抽图 → 2 ✊握拳抽红包（均由顶部阶段条点击切换，不自动跳转）
type Phase = 'images' | 'redpacket';

// ---- 阶段二：红包名单（41 人，每轮抽出 5 人） ----
interface RedPacket {
  id: number;
  name: string;
  avatar?: string; // 预留：正式头像图片地址
}

// 每轮抽出的人数
const RED_PACKET_DRAW_COUNT = 5;

const RED_PACKET_PEOPLE: RedPacket[] = [
  'Nicole Q Y WU',
  'Maple Ye LI',
  'Yuna J W ZHENG',
  'May M SU',
  'Kohl K ZHENG_SP',
  'Wen Tao DENG',
  'Stephen Q WANG',
  'Daniel J C SHANG',
  'Miller Q L DING',
  'Zechao PENG',
  'Beth CHEN',
  'Ping Zhang LAN',
  'Chenny Jun CHEN',
  'Elijah R WU',
  'Jeanette Z JIAN',
  'Ares H J ZHANG',
  'Zu Shun TAN',
  'Jackson Z C HAO',
  'Wing1 Y ZENG',
  'Leon T E LAN',
  'Raymond W W YUAN',
  'Gary Y ZHANG',
  'Faye F LIAO',
  'Murphy C WANG',
  'Kenji ZHANG',
  'Nickolas G J YU',
  'Rene W R Q ZHANG',
  'Alex Y C YU',
  'Lucia X Y LU',
  'Holy G Y AO',
  'Richard R H ZHAO',
  'Tracy T LI',
  'Cara K Q HUANG',
  'Ivy F Zhang',
  'Leo J F LIAO',
  'Eric C F LI',
  'Wason Y H WANG',
  'Effy Y F WANG',
  'Sherry1 X L LI',
  'Raymond P REN',
  'Vincent Y MA',
].map((name, i) => ({ id: i, name }));

// 头像占位底色：正式头像接入后可移除
const AVATAR_COLORS = [
  '#FF6B6B',
  '#FFB84C',
  '#4ECDC4',
  '#5B8DEF',
  '#9B5DE5',
  '#F15BB5',
  '#00BBF9',
  '#00F5D4',
  '#FEE440',
  '#C77DFF',
];

// ---- 翻页手势（阶段一/二通用）：左手张开手掌向右快速挥动 → 跳到下一阶段 ----
// 坐标说明：检测用原始相机坐标，预览做了镜像，所以 x 减小 = 画面上向右
const SWIPE_HAND = 'Left'; // MediaPipe 标注的左手
const SWIPE_WINDOW_MS = 400; // 位移统计窗口
const SWIPE_DIST = 0.28; // 窗口内最小水平位移（归一化坐标），须快速大幅挥动
const SWIPE_COOLDOWN_MS = 1500; // 两次翻页最小间隔

const FIST_HAND = 'Right'; // 抽红包用手：MediaPipe 标注的右手

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// 换图牌堆：只在"尚未展示过"的图里按洗牌顺序取下一张，展示过的图绝不复选。
// 展示过的序号（shown）只增不减；全部展示完后返回 -1，由调用方进入"展示完毕"状态。
function pickNextArtIndex(
  poolLength: number,
  shown: number[],
  order: { current: number[] | null },
  cursor: { current: number }
): number {
  const shownSet = new Set(shown);
  const remaining: number[] = [];
  for (let i = 0; i < poolLength; i++) {
    if (!shownSet.has(i)) remaining.push(i);
  }
  if (remaining.length === 0) return -1;
  // 牌堆走完（或首次）时，用剩余未展示的图重新洗牌
  if (!order.current || cursor.current + 1 >= order.current.length) {
    shuffleArray(remaining);
    order.current = remaining;
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
  // 本轮随机选出的 8 张（从 15 件投稿中抽取），展示条只渲染这 8 格
  const [artPool] = useState<number[]>(() => pickRandomPool());
  // 不重复选图：只从未展示的图里按洗牌顺序取，展示过的图进入顶部展示条后不再复选
  const artOrderRef = useRef<number[] | null>(null);
  const artCursorRef = useRef(-1);
  if (artOrderRef.current === null) {
    artOrderRef.current = [...artPool];
  }
  // 顶部展示条：已展示的图（状态供渲染，ref 供检测循环读取）
  const [shownArts, setShownArts] = useState<number[]>([]);
  const shownArtsRef = useRef<number[]>([]);
  // 全部展示完后的"图片展示完毕"状态
  const [poolDone, setPoolDone] = useState(false);
  const poolDoneRef = useRef(false);
  // 换图状态机：取景框中断一段时间后，再次张开才换新图
  const noFrameSinceRef = useRef<number | null>(null);
  const armedRef = useRef(true);
  const [status, setStatus] = useState<'starting' | 'ready' | 'error'>('starting');
  const [statusMsg, setStatusMsg] = useState('Loading vision model...');
  const [cameraOk, setCameraOk] = useState(false);
  const [modelOk, setModelOk] = useState(false);
  const [handCount, setHandCount] = useState(0);
  const [framing, setFraming] = useState(false);
  const [hint, setHint] = useState('Starting…');
  const [hands, setHands] = useState<HandData[]>([]);

  // 两阶段状态机：images → redpacket，手势只在所属阶段生效；阶段切换只靠点击阶段条
  const [phase, setPhase] = useState<Phase>('images');
  const phaseRef = useRef<Phase>('images');
  // ✊ 红包手势状态机：单手握拳保持 ~800ms 抽一个，两次抽取间隔 >1.2s
  const fistSinceRef = useRef<number | null>(null);
  const fistFiredRef = useRef(false);
  const lastDrawAtRef = useRef(0);
  const drawQueueRef = useRef<RedPacket[]>([]);
  const drawnRef = useRef<RedPacket[]>([]);
  const [drawnPackets, setDrawnPackets] = useState<RedPacket[]>([]);
  const [giftsSent, setGiftsSent] = useState(false);
  const giftsSentRef = useRef(false);
  // 中央揭示动画：抽中的红包先在画面中心展示 ~2.2s，期间锁定下一次抽取
  const REVEAL_MS = 2200;
  const [revealPacket, setRevealPacket] = useState<RedPacket | null>(null);
  const revealRef = useRef<{ packet: RedPacket; until: number } | null>(null);
  const revealCommitTimerRef = useRef(0);
  // ✋ 翻页手势轨迹（左手掌心位置）：用于判断向右快速挥动
  const swipeTrailRef = useRef<{ t: number; x: number; y: number; open: boolean }[]>([]);
  const lastSwipeAtRef = useRef(0);

  useEffect(() => {
    artImagesRef.current = ART_FILES.map((src) => {
      const img = new Image();
      img.src = src;
      return img;
    });
  }, []);

  // 进入第二阶段：41 人洗牌，每轮抽出 5 人（抽中顺序随机，展示按抽取顺序从第一格排起）
  const enterRedPacketPhase = useCallback(() => {
    drawQueueRef.current = [...RED_PACKET_PEOPLE];
    shuffleArray(drawQueueRef.current);
    drawnRef.current = [];
    setDrawnPackets([]);
    giftsSentRef.current = false;
    setGiftsSent(false);
    revealRef.current = null;
    setRevealPacket(null);
    fistSinceRef.current = null;
    fistFiredRef.current = false;
    phaseRef.current = 'redpacket';
    setPhase('redpacket');
  }, []);

  // 抽一个红包：从洗牌队列取出一位 → 先在画面中央揭示，落位后从队列移除。
  // 队列 pop 即永久移除，抽中的人绝不会再被抽到；抽满 5 个 → 全部礼物发出（停留本阶段）。
  const drawRedPacket = useCallback(() => {
    // 本轮 5 个名额已满：不再抽取
    if (drawnRef.current.length >= RED_PACKET_DRAW_COUNT) return;
    const next = drawQueueRef.current.pop();
    if (!next) return;
    revealRef.current = { packet: next, until: performance.now() + REVEAL_MS };
    setRevealPacket(next);
    // 揭示动画结束后：落位到上方展示条
    window.clearTimeout(revealCommitTimerRef.current);
    revealCommitTimerRef.current = window.setTimeout(() => {
      revealRef.current = null;
      setRevealPacket(null);
      drawnRef.current = [...drawnRef.current, next];
      setDrawnPackets(drawnRef.current);
      if (drawnRef.current.length >= RED_PACKET_DRAW_COUNT) {
        giftsSentRef.current = true;
        setGiftsSent(true);
      }
    }, REVEAL_MS);
  }, []);

  // 翻页手势：暂时停用（保留代码以便将来恢复），目前改用阶段条点击跳转
  const advancePhase = useCallback(() => {
    if (phaseRef.current === 'images') {
      enterRedPacketPhase();
    }
  }, [enterRedPacketPhase]);

  // 点击阶段条直接跳转到对应阶段（images 内部不重置，保留当前进度）
  const jumpToPhase = useCallback(
    (target: Phase) => {
      if (target === 'images' && phaseRef.current !== 'images') {
        phaseRef.current = 'images';
        setPhase('images');
      } else if (target === 'redpacket' && phaseRef.current !== 'redpacket') {
        enterRedPacketPhase();
      }
    },
    [enterRedPacketPhase]
  );

  // 按阶段生成取景框底部提示（只读 ref，闭包过期也安全）
  const hintForPhase = (
    ph: Phase,
    framing: boolean,
    handCount: number,
    fistNow: boolean
  ): string => {
    if (ph === 'redpacket') {
      if (giftsSentRef.current) return '🎁 All gifts sent! Click 1. Image Draw to replay';
      if (fistNow) {
        return fistFiredRef.current ? '✊ Got one! Release and fist again' : '✊ Keep the right fist to draw…';
      }
      return `✊ Right-hand fist 0.8s to draw (${drawnRef.current.length}/${RED_PACKET_DRAW_COUNT}) · click the stage bar to switch`;
    }
    if (poolDoneRef.current) return 'All images shown 🎉 Click 2. Red Packet to continue';
    // 取景框里出现图片时，下方同步显示该作品的名字
    if (curArtRef.current) {
      const artIdx = artImagesRef.current.indexOf(curArtRef.current);
      const sub = artIdx >= 0 ? SUBMISSIONS[artIdx] : undefined;
      if (sub) return `🖼️ ${sub.title} — ${sub.author}`;
    }
    if (framing) return 'Viewfinder ready!';
    if (handCount === 0) return 'Show both palms to the camera 🙌';
    if (handCount === 1) return 'One hand detected — show the other one ✋';
    return armedRef.current
      ? 'Armed! Spread thumbs & index again · click the stage bar to switch'
      : 'Fold fingers to arm, then spread to switch the image';
  };

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
      window.clearTimeout(revealCommitTimerRef.current);
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

        // ---- 阶段门控：每套手势只在所属阶段解析，互不干扰 ----
        const ph = phaseRef.current;
        const frame = ph === 'images' ? buildFrameFromHands(result, canvas.width, canvas.height) : null;
        // ✊ 抽红包只认右手：左手握拳不触发
        const fistNow =
          ph === 'redpacket' &&
          result.landmarks.some(
            (lm, i) => result.handedness[i]?.[0]?.categoryName === FIST_HAND && fistPose(lm)
          );

        // ---- 翻页手势：暂时停用（改由顶部阶段条点击跳转），整块逻辑短路保留 ----
        const leftIdx = result.handedness.findIndex(
          (h) => h[0]?.categoryName === SWIPE_HAND
        );
        const onlyLeftHand = leftIdx >= 0 && result.landmarks.length === 1;
        const swipeBlocked = true;
        if (!swipeBlocked && onlyLeftHand && leftIdx >= 0) {
          const leftHand = result.landmarks[leftIdx];
          const palmX = leftHand[9].x;
          const palmY = leftHand[9].y;
          // 必须四指全部伸直的张开手掌：取景框手势（三指弯曲）被排除
          const openHand = openPalmPose(leftHand);
          const trail = swipeTrailRef.current;
          // 手离开画面再进入时轨迹断裂，直接重开，避免跨帧"瞬移"被误判为挥动
          if (trail.length > 0 && now - trail[trail.length - 1].t > 200) trail.length = 0;
          trail.push({ t: now, x: palmX, y: palmY, open: openHand });
          while (trail.length > 0 && now - trail[0].t > SWIPE_WINDOW_MS) trail.shift();

          const sinceLast = now - lastSwipeAtRef.current;
          const openCount = trail.reduce((n, p) => n + (p.open ? 1 : 0), 0);
          if (
            sinceLast > SWIPE_COOLDOWN_MS &&
            trail.length >= 2 &&
            openCount >= trail.length * 0.7 && // 允许个别帧抖动，但主体须为张开手掌
            trail[trail.length - 1].open &&
            trail[0].x - trail[trail.length - 1].x > SWIPE_DIST
          ) {
            lastSwipeAtRef.current = now;
            swipeTrailRef.current = [];
            advancePhase();
          }
        } else if (now - (swipeTrailRef.current[swipeTrailRef.current.length - 1]?.t ?? 0) > 250) {
          // 手消失或已到最后一阶段：清空轨迹，避免旧轨迹误触发
          swipeTrailRef.current = [];
        }

        // ---- 阶段二：✊ 握拳保持 ~800ms 抽一个红包 ----
        if (ph === 'redpacket') {
          // 中央揭示动画期间锁定：不检测手势、不触发新抽取
          if (revealRef.current) {
            fistSinceRef.current = null;
            fistFiredRef.current = false;
            if (now >= revealRef.current.until) {
              revealRef.current = null;
              setRevealPacket(null);
            }
          } else if (fistNow) {
            if (fistSinceRef.current === null) fistSinceRef.current = now;
            if (
              !fistFiredRef.current &&
              now - fistSinceRef.current > 800 &&
              now - lastDrawAtRef.current > 1200
            ) {
              fistFiredRef.current = true;
              lastDrawAtRef.current = now;
              drawRedPacket();
            }
          } else {
            fistSinceRef.current = null;
            fistFiredRef.current = false;
          }
        }

        // ---- 阶段一：换图规则（其余阶段取景框手势失效）----
        const t = now;
        if (ph === 'images') {
          if (frame) {
            if ((armedRef.current || !curArtRef.current) && !poolDoneRef.current) {
              // 本轮只展示随机选出的 8 张：8 张出完即结束，不再从剩余投稿里补
              const nextIdx =
                shownArtsRef.current.length >= artPool.length
                  ? -1
                  : pickNextArtIndex(
                      artImagesRef.current.length,
                      shownArtsRef.current,
                      artOrderRef,
                      artCursorRef
                    );
              if (nextIdx >= 0) {
                curArtRef.current = artImagesRef.current[nextIdx] ?? null;
                shownArtsRef.current = [...shownArtsRef.current, nextIdx];
                setShownArts(shownArtsRef.current);
              } else {
                // 候选池清空：8 张图片都已展示，停留本阶段等待点击切换（不自动跳转）
                curArtRef.current = null;
                poolDoneRef.current = true;
                setPoolDone(true);
              }
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
        } else {
          noFrameSinceRef.current = null;
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
        setHint(hintForPhase(ph, !!frame, result.landmarks.length, fistNow));
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

  // ✊ Fist pose (阶段二抽红包)：四指指尖收拢贴向各自指根，拇指折起压在食指上。
  // 与阶段一的双手取景框也不同形，保证各阶段手势不会误触发。
  const fistPose = (lm: NormalizedLandmark[]) => {
    const palm = dist(lm[0], lm[9]);
    if (palm < 1e-6) return false;
    const curled = ([8, 12, 16, 20] as const).every(
      (tip) => dist(lm[tip], lm[tip - 2]) < palm * 0.55
    );
    const thumbIn = dist(lm[4], lm[6]) < palm * 0.6;
    return curled && thumbIn;
  };

  // 🖐 Open-palm pose (page-flip gesture): all four fingers clearly extended.
  // 与取景框手势（只伸拇指+食指、其余三指弯曲）天然互斥，
  // 避免阶段一摆取景框时的大幅移动被误判成翻页。
  const fingerExtended = (lm: NormalizedLandmark[], tip: number) =>
    dist(lm[tip], lm[tip - 2]) > dist(lm[tip - 1], lm[tip - 2]) * 1.25;

  const openPalmPose = (lm: NormalizedLandmark[]) =>
    fingerExtended(lm, 8) && fingerExtended(lm, 12) && fingerExtended(lm, 16) && fingerExtended(lm, 20);

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
      {/* 顶部两阶段导航：点击切换阶段，不自动跳转 */}
      <div className="phase-bar" role="tablist" aria-label="Activity stages">
        <div
          role="tab"
          aria-selected={phase === 'images'}
          tabIndex={0}
          onClick={() => jumpToPhase('images')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') jumpToPhase('images');
          }}
          className={`phase-chip clickable ${phase === 'images' ? 'current' : 'done'}`}
        >
          <span className="phase-icon">{phase !== 'images' ? '✓' : '🖼️'}</span>
          <span className="phase-name">1. Image Draw</span>
        </div>
        <span className="phase-arrow">→</span>
        <div
          role="tab"
          aria-selected={phase === 'redpacket'}
          tabIndex={0}
          onClick={() => jumpToPhase('redpacket')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') jumpToPhase('redpacket');
          }}
          className={`phase-chip clickable ${phase === 'redpacket' ? 'current' : ''}`}
        >
          <span className="phase-icon">🧧</span>
          <span className="phase-name">2. Red Packet</span>
        </div>
      </div>

      {/* 阶段一展示条：抽中的图按顺序落位；离开该阶段后自动收起 */}
      {phase === 'images' && (
        <div
          className={`selected-strip ${poolDone ? 'strip-done' : ''}`}
          role="status"
          aria-live="polite"
        >
          <span className="strip-label">
            {poolDone ? 'All images shown 🎉' : `Images ${shownArts.length}/${artPool.length}`}
          </span>
          <div className="strip-slots">
            {artPool.map((subIdx, slot) => {
              // 未抽中时格子留空（不剧透）；抽中后展示照片 + 作者名，按选中顺序从第一格排起
              const artIdx = shownArts[slot];
              const drawn = artIdx !== undefined;
              const sub = drawn ? SUBMISSIONS[artIdx] : undefined;
              return (
                <div key={SUBMISSIONS[subIdx].id} className={`strip-slot art-slot ${drawn ? 'filled' : ''}`} title={sub ? `#${sub.id} ${sub.title} — ${sub.author}` : undefined}>
                  {sub && (
                    <div className="art-card">
                      <img
                        src={ART_FILES[artIdx]}
                        alt={ART_NAMES[artIdx]}
                        className="strip-thumb"
                      />
                      <span className="art-name">{sub.title}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 阶段二展示板：抽中的红包按抽取顺序落位，抽满 10 个发礼物 */}
      {phase !== 'images' && (
        <div className={`redpacket-strip ${giftsSent ? 'rp-done' : ''}`}>
          <span className="strip-label">
            {giftsSent
              ? '🎁 All 5 gifts sent!'
              : `Red packets ${drawnPackets.length}/${RED_PACKET_DRAW_COUNT} · ✊ fist to draw next`}
          </span>
          <div className="strip-slots">
            {Array.from({ length: RED_PACKET_DRAW_COUNT }, (_, slot) => {
              const packet = drawnPackets[slot];
              return (
                <div
                  key={slot}
                  className={`strip-slot rp-slot ${packet ? 'filled' : ''}`}
                  title={packet?.name}
                >
                  {packet && (
                    <div className="rp-card">
                      <span
                        className="rp-avatar"
                        style={{
                          background:
                            packet.avatar ? undefined : AVATAR_COLORS[slot % AVATAR_COLORS.length],
                        }}
                      >
                        {packet.avatar ? (
                          <img src={packet.avatar} alt={packet.name} />
                        ) : (
                          packet.name.slice(0, 1)
                        )}
                      </span>
                      <span className="rp-name">{packet.name}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className={`viewport-container ${framing ? 'framing' : handCount > 0 ? 'has-hands' : ''}`}>
        <video ref={videoRef} className="webcam-video" autoPlay playsInline muted />

        <canvas ref={canvasRef} className="overlay-canvas" />

        {/* 中央揭示动画：抽中的红包先在画面中心展示，再落位到上方展示条 */}
        {revealPacket && (
          <div className="reveal-overlay">
            <div className="reveal-card">
              <span className="reveal-emoji">🧧</span>
              <span
                className="reveal-avatar"
                style={{
                  background: revealPacket.avatar
                    ? undefined
                    : AVATAR_COLORS[drawnRef.current.length % AVATAR_COLORS.length],
                }}
              >
                {revealPacket.avatar ? (
                  <img src={revealPacket.avatar} alt={revealPacket.name} />
                ) : (
                  revealPacket.name.slice(0, 1)
                )}
              </span>
              <span className="reveal-name">{revealPacket.name}</span>
              <span className="reveal-sub">Congrats! You got a red packet</span>
            </div>
          </div>
        )}

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

