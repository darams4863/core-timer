// 락인 종료 축하: 화면 위쪽에서 컨페티가 한 번 터지고, 글래스 카드가 떴다 사라진다.
// 투명·클릭 통과 창에서 실행되며, 끝나면 창을 스스로 닫는다.

const params = new URLSearchParams(location.search);
const title = params.get("title");
const sub = params.get("sub");
if (title) document.getElementById("title")!.textContent = title;
if (sub) document.getElementById("sub")!.textContent = sub;

const mode = params.get("mode") === "lock" ? "lock" : "celebrate";
// 카드는 공통 알림 창이 보여 주므로 여기선 숨긴다 (card=0)
const showCard = params.get("card") !== "0";
// 효과 중심 (위젯 위치). 없으면 화면 위쪽 가운데
const originX = params.has("cx") ? Number(params.get("cx")) : null;
const originY = params.has("cy") ? Number(params.get("cy")) : null;
if (!showCard) document.getElementById("card")!.style.display = "none";
document.body.classList.add(`mode-${mode}`);
const DURATION = mode === "lock" ? 3200 : 3600;
const COLORS = ["#a5b4fc", "#7cc4ff", "#c4a7ff", "#f9a8d4", "#fde68a", "#99f6e4", "#ffffff"];

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let W = 0;
let H = 0;
const dpr = Math.min(2, window.devicePixelRatio || 1);
function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener("resize", resize);

type Shape = "rect" | "strip" | "circle" | "bokeh";
interface P {
  x: number; y: number; vx: number; vy: number;
  rot: number; vr: number; flip: number; vf: number;
  size: number; color: string; shape: Shape; alpha: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const parts: P[] = [];

function spawn(x: number, y: number, angle: number, spread: number, speed: number, n: number) {
  for (let i = 0; i < n; i++) {
    const a = angle + rand(-spread, spread);
    const v = rand(speed * 0.45, speed);
    const r = Math.random();
    const shape: Shape = r < 0.45 ? "rect" : r < 0.7 ? "strip" : r < 0.92 ? "circle" : "bokeh";
    parts.push({
      x, y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      rot: rand(0, Math.PI * 2),
      vr: rand(-0.25, 0.25),
      flip: rand(0, Math.PI * 2),
      vf: rand(0.08, 0.22),
      size: shape === "bokeh" ? rand(14, 34) : rand(6, 12),
      color: pick(COLORS),
      shape,
      alpha: shape === "bokeh" ? rand(0.25, 0.45) : rand(0.85, 1),
    });
  }
}

// 위쪽 가운데에서 '펑' + 양쪽 위 모서리에서 대각선 발사 + 위에서 흩날림
const scale = Math.max(0.6, Math.min(1.6, W / 1400));
let rainLeft = 0;
if (mode === "celebrate") {
  spawn(originX ?? W / 2, originY ?? H * 0.12, Math.PI / 2, Math.PI, 15 * scale, 170);
  spawn(0, H * 0.02, Math.PI * 0.2, 0.35, 22 * scale, 90);
  spawn(W, H * 0.02, Math.PI * 0.8, 0.35, 22 * scale, 90);
  rainLeft = 40;
}

// 락인 시작: 카드 뒤로 퍼지는 유리 물결
function ripples(elapsed: number) {
  const rect = document.getElementById("card")!.getBoundingClientRect();
  // 카드를 숨겼으면 공통 알림 카드 자리(상단 가운데)를 기준으로
  const card = showCard
    ? rect
    : { left: (originX ?? W / 2) - 140, top: (originY ?? 80) - 47, width: 280, height: 94 };
  const cx = card.left + card.width / 2;
  const cy = card.top + card.height / 2;
  for (let k = 0; k < 3; k++) {
    const t = (elapsed - 1000 - k * 260) / 1400; // 고리가 닫히는 순간부터
    if (t <= 0 || t >= 1) continue;
    const r = card.width * 0.45 + t * card.width * 0.9;
    ctx.save();
    ctx.globalAlpha = (1 - t) * 0.5;
    ctx.strokeStyle = k % 2 ? "#c4a7ff" : "#7cc4ff";
    ctx.lineWidth = 2.5 * (1 - t) + 0.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.38, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

const start = performance.now();
let last = start;

function frame(t: number) {
  const dt = Math.min(2.5, (t - last) / 16.67);
  last = t;
  const elapsed = t - start;

  if (rainLeft > 0 && elapsed > 250) {
    for (let i = 0; i < 3 && rainLeft > 0; i++, rainLeft--) {
      spawn(rand(0, W), -20, Math.PI / 2, 0.3, 3, 1);
    }
  }

  ctx.clearRect(0, 0, W, H);
  if (mode === "lock") ripples(elapsed);
  const fadeAll = elapsed > DURATION - 700 ? Math.max(0, (DURATION - elapsed) / 700) : 1;

  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.vy += 0.32 * dt * (p.shape === "bokeh" ? 0.35 : 1); // 중력
    p.vx *= Math.pow(0.985, dt); // 공기 저항
    p.vy *= Math.pow(0.985, dt);
    p.x += (p.vx + Math.sin(p.flip) * 0.8) * dt; // 팔랑팔랑
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.flip += p.vf * dt;
    if (p.y > H + 60) {
      parts.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = p.alpha * fadeAll;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    const squash = Math.abs(Math.cos(p.flip)); // 뒤집히는 느낌
    switch (p.shape) {
      case "rect":
        ctx.scale(1, 0.25 + squash * 0.75);
        roundRect(-p.size / 2, -p.size * 0.35, p.size, p.size * 0.7, 2);
        break;
      case "strip":
        ctx.scale(1, 0.3 + squash * 0.7);
        roundRect(-p.size * 0.8, -p.size * 0.18, p.size * 1.6, p.size * 0.36, 2);
        break;
      case "circle":
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size * 0.42, p.size * 0.42 * (0.35 + squash * 0.65), 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "bokeh": {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size);
        g.addColorStop(0, p.color);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, p.size, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
    ctx.restore();
  }

  if (elapsed < DURATION) requestAnimationFrame(frame);
  else finish();
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

async function finish() {
  const demo = (window as any).__LOCKIN_DEMO__;
  if (demo) return demo.confettiDone?.();
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().destroy();
  } catch {
    window.close();
  }
}

// 클릭이 뒤의 앱으로 통과되도록
(async () => {
  if ((window as any).__LOCKIN_DEMO__) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setIgnoreCursorEvents(true);
  } catch {
    /* 무시 */
  }
})();

requestAnimationFrame(frame);
