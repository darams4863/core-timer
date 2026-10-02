import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { availableMonitors, currentMonitor, Effect, EffectState, getCurrentWindow, primaryMonitor, type Monitor } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  CHEERS,
  DEFAULT_SCHEDULE,
  NOPE,
  formatClock,
  formatDuration,
  getPhase,
  hmLabel,
  lineFor,
  nextStreak,
  parseSchedule,
  toKst,
  type Phase,
  type Schedule,
} from "./time";

// 미리보기 페이지(브라우저)에서 시간·잠금·축하를 흉내 내기 위한 훅
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const demo = (window as any).__LOCKIN_DEMO__ as
  | {
      now?: () => Date;
      celebrate?: (title: string, sub: string) => void;
      lockScreen?: () => void;
      setSize?: (w: number, h: number) => void;
      platform?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      alert?: (opts: any) => void;
    }
  | undefined;
// '락인 시작 미리보기' 중에는 가짜 시계(오전 코어타임 시작 직후, 빠르게 흐름)를 쓴다
let previewStartedAt = 0;
const PREVIEW_MS = 9000;
function previewNow(): Date | null {
  if (!previewStartedAt) return null;
  const elapsed = Date.now() - previewStartedAt;
  if (elapsed > PREVIEW_MS) return null;
  const [h, mi] = (settings?.amStart ?? "08:30").split(":").map(Number);
  // 2026-10-05(월) 오전 코어타임 시작 + (경과 × 600배)
  return new Date(Date.UTC(2026, 9, 5, h - 9, mi) + elapsed * 600);
}
// '하루 시뮬레이션': 07:50부터 19:00까지를 약 40초에 빠르게 돌려 본다
let sim: { startedAt: number; base: number; clockIn: number | null } | null = null;
const SIM_SPEED = 1000; // 실제 1초 = 약 17분
const SIM_FROM = Date.UTC(2026, 9, 5, 7 - 9, 50); // 2026-10-05(월) 07:50 KST
const SIM_TO_MIN = 19 * 60;
function simNow(): Date | null {
  return sim ? new Date(sim.base + (Date.now() - sim.startedAt) * SIM_SPEED) : null;
}
const nowDate = () => previewNow() ?? simNow() ?? demo?.now?.() ?? new Date();

// ── 설정 ───────────────────────────────────────────────

interface Settings extends Schedule {
  hideOutside: boolean;
  showWidget: boolean; // 플로팅 위젯 표시 (끄면 메뉴 막대/트레이만)
  menuBarText: boolean; // macOS 메뉴 막대·Linux 패널에 남은 시간 글자 표시
  glass: boolean; // 배경 블러 효과
}

const DEFAULTS: Settings = {
  ...DEFAULT_SCHEDULE,
  hideOutside: false,
  showWidget: true,
  menuBarText: true,
  glass: true,
};

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 저장 실패는 무시 */
  }
}

function loadSettings(): Settings {
  try {
    const raw = safeGet("settings");
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    delete parsed.opacity; // 예전 '불투명도' 설정은 버리고 새 기본 투명도 50% 적용
    const s = { ...DEFAULTS, ...parsed } as Settings;
    if (!parseSchedule(s)) Object.assign(s, DEFAULT_SCHEDULE);
    s.glass = true; // 유리 효과는 항상 켬 (설정 항목 삭제)
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

let settings = loadSettings();

// ── DOM ────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const widget = $("widget");
const lockBtn = $<HTMLButtonElement>("lock");
const lockFill = document.getElementById("lockFill") as unknown as SVGRectElement;
const labelEl = $("label");
const pctEl = $("pct");
const clockEl = $("clock");
const msgEl = $("msg");
const fillEl = $("fill");
const sparklesEl = $("sparkles");
const subLeftEl = $("subLeft");
const subRightEl = $("subRight");
const form = $<HTMLFormElement>("settings");
const settingsError = $("settingsError");

const win = getCurrentWindow();
const WIDGET_SIZE = new LogicalSize(280, 94);
const SETTINGS_SIZE = new LogicalSize(320, 432);
const DIALOG_SIZE = new LogicalSize(300, 132);

async function resizeTo(size: LogicalSize) {
  demo?.setSize?.(size.width, size.height);
  await win.setSize(size).catch(() => {});
}

function restartAnim(el: Element, cls: string) {
  el.classList.remove(cls);
  void (el as HTMLElement).getBoundingClientRect(); // 애니메이션 재시작
  el.classList.add(cls);
}

// ── 잠깐 띄우는 문구 (오른쪽 작은 글씨 자리) ────────────────

let flashText = "";
let flashUntil = 0;
let flashRenderQueued = false;
function flash(text: string, ms = 2600) {
  flashText = text;
  flashUntil = Date.now() + ms;
  // render() 안에서 불려도 재귀하지 않도록 다음 틱에 다시 그린다
  if (!flashRenderQueued) {
    flashRenderQueued = true;
    window.setTimeout(() => {
      flashRenderQueued = false;
      render();
    }, 0);
  }
}

// ── 자물쇠 상호작용 ─────────────────────────────────────

let lockedNow = false;
let remainingNow = 0;
let taps = 0;

lockBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  taps += 1;
  if (lockedNow) {
    restartAnim(lockBtn, "nope"); // 잠긴 동안엔 덜컹, 안 열림
    const mins = Math.ceil(remainingNow / 60);
    flash(taps % 3 === 0 ? `${mins}분 뒤에 코어타임이 끝나요` : NOPE[Math.floor(Math.random() * NOPE.length)]);
  } else {
    restartAnim(lockBtn, "tap");
    flash(CHEERS[Math.floor(Math.random() * CHEERS.length)]);
  }
});

// ── 열릴 때 유리 조각이 퍼지는 효과 ──────────────────────

function sparkle(count = 26) {
  const colors = ["#a5b4fc", "#7cc4ff", "#c4a7ff", "#ffffff", "#f9a8d4"];
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const dist = 30 + Math.random() * 120;
    p.className = i % 3 === 0 ? "diamond" : "";
    p.style.setProperty("--x", `${Math.cos(angle) * dist * 1.6}px`);
    p.style.setProperty("--y", `${Math.sin(angle) * dist * 0.5}px`);
    p.style.setProperty("--s", `${3 + Math.random() * 5}px`);
    p.style.setProperty("--d", `${0.9 + Math.random() * 0.8}s`);
    p.style.setProperty("--c", colors[i % colors.length]);
    sparklesEl.appendChild(p);
    window.setTimeout(() => p.remove(), 2000);
  }
}

// ── 연속 기록 ───────────────────────────────────────────

function loadStreak(): { lastDate: string | null; count: number } {
  try {
    return JSON.parse(safeGet("streak") ?? "") ?? { lastDate: null, count: 0 };
  } catch {
    return { lastDate: null, count: 0 };
  }
}
let streak = loadStreak();

// ── 트레이 / 메뉴 막대 ──────────────────────────────────

function trayInfo(p: Phase, warn: boolean) {
  switch (p.kind) {
    case "lock":
      return {
        kind: p.which,
        progress: p.progress,
        title: formatClock(p.remainingSec),
        tooltip: `${p.which === "am" ? "오전" : "오후"} 코어타임 · ${formatClock(p.remainingSec)} 남음 (${Math.floor(p.progress * 100)}%)`,
      };
    case "before":
      return {
        kind: warn ? "warn" : "idle",
        progress: 0,
        title: warn ? `${Math.ceil(p.minutesUntil)}분 후 코어타임` : "",
        tooltip: `오전 코어타임까지 ${formatDuration(p.minutesUntil)}`,
      };
    case "break":
      return {
        kind: warn ? "warn" : "idle",
        progress: 0,
        title: warn ? `${Math.ceil(p.minutesUntil)}분 후 코어타임` : "",
        tooltip: `오후 코어타임까지 ${formatDuration(p.minutesUntil)}`,
      };
    case "done":
      return { kind: "done", progress: 1, title: "", tooltip: "오늘 코어타임이 끝났어요 · 수고하셨어요" };
    case "weekend":
      return { kind: "idle", progress: 0, title: "", tooltip: "주말 · 코어타임 없음" };
  }
}

let lastTrayKey = "";
const IS_WINDOWS = demo?.platform ? demo.platform === "windows" : /Windows/i.test(navigator.userAgent);
function updateTray(p: Phase, warn: boolean) {
  const t = trayInfo(p, warn);
  const title = settings.menuBarText ? t.title : "";
  const key = `${t.kind}|${Math.round(t.progress * 120)}|${title}|${t.tooltip}|${p.kind === "lock" ? Math.ceil(p.remainingSec / 60) : ""}`;
  if (key === lastTrayKey) return;
  lastTrayKey = key;
  // Windows 트레이는 아이콘 옆에 글자를 못 붙여서, 아이콘 안에 남은 시간을 숫자로 그린다 (49 → 49분, 2h → 2시간)
  let badge = "";
  if (IS_WINDOWS && p.kind === "lock") {
    const mins = Math.ceil(p.remainingSec / 60);
    badge = mins >= 100 ? `${Math.ceil(mins / 60)}h` : String(mins);
  }
  invoke("update_tray", { kind: t.kind, progress: t.progress, title, tooltip: t.tooltip, badge }).catch(() => {});
}

// 불투명도 = 유리판(배경)의 진하기. 글자·자물쇠는 항상 선명하게 둔다.
const TRANSPARENCY = 50; // 유리판 진하기 (고정)
function applyTint(transparency: number, glass: boolean) {
  const t = 1 - Math.min(1, Math.max(0, transparency / 90)); // 0 = 가장 투명, 1 = 가장 진함
  // 유리(블러) 켜짐: 아주 투명하게 / 꺼짐·Linux(OS 블러 없음): 글자가 읽히게 조금 더 진하게
  const nativeBlur = glass && !/Linux/i.test(navigator.userAgent);
  const k = nativeBlur ? 0.1 + t * 0.9 : 0.8 + t * 1.6;
  const set = (name: string, rgb: string, a: number) =>
    widget.style.setProperty(name, `rgba(${rgb}, ${Math.min(0.95, a * k).toFixed(3)})`);
  set("--glass", "255, 255, 255", 0.2);
  set("--lav1", "196, 167, 255", 0.34);
  set("--lav2", "150, 190, 255", 0.24);
  widget.classList.toggle("no-glass", !glass);
}

// ── 출근 시각 & 퇴근 가능 시각 ─────────────────────────────
// 시차출퇴근제: 출근 08:30~09:30 자율, 소정근로 9시간(휴게 1시간 포함) 충족 후 퇴근.
// 코어타임은 모두 같고, 출근 시각은 사람마다 다르다.

const WORK_MIN = 9 * 60;
const EARLIEST_IN = 8 * 60 + 30;

function loadClockIn(): { date: string; minutes: number } | null {
  try {
    return JSON.parse(safeGet("clockIn") ?? "null");
  } catch {
    return null;
  }
}
let clockIn = loadClockIn();

function clockInToday(dateKey: string): number | null {
  if (sim) {
    // 시뮬레이션: 실제 오늘 출근 기록이 있으면 그걸, 없으면 09:12 출근으로 가정
    const real = toKst(new Date()).dateKey;
    if (clockIn && clockIn.date === real) return clockIn.minutes;
    return sim.clockIn;
  }
  return clockIn && clockIn.date === dateKey ? clockIn.minutes : null;
}
function setClockIn(dateKey: string, minutes: number | null) {
  clockIn = minutes === null ? null : { date: dateKey, minutes: Math.round(minutes) };
  safeSet("clockIn", JSON.stringify(clockIn));
}
/** 퇴근 가능 시각(분). 08:30 이전 출근은 08:30부터 계산 */
function leaveAtFor(clockInMin: number | null): number | null {
  return clockInMin === null ? null : Math.max(clockInMin, EARLIEST_IN) + WORK_MIN;
}

/**
 * 코어타임은 출근 시각과 상관없이 모두 같은 고정 시간(설정값)이다.
 * 단, 퇴근 가능 시각(출근 + 9시간)이 오후 코어타임 안이면 그때 퇴근할 수 있으므로
 * 오후 코어타임도 그 시각에 함께 끝난 것으로 본다.
 */
function effectiveSchedule(dateKey: string): Schedule {
  const leave = leaveAtFor(clockInToday(dateKey));
  const s = parseSchedule(settings);
  if (leave === null || !s) return settings;
  if (leave > s.pmStart && leave < s.pmEnd) return { ...settings, pmEnd: hmLabel(leave) };
  return settings;
}
function phaseAt(date: Date): Phase {
  const k = toKst(date);
  return getPhase(k, effectiveSchedule(k.dateKey));
}

// 그날 처음 "출근하셨나요?" 묻기
let askedDate = safeGet("askedDate") ?? "";
let snoozeUntil = 0;
function maybeAskClockIn(now: ReturnType<typeof toKst>) {
  if (previewStartedAt || sim || dialogOpen || settingsOpen) return;
  if (now.weekday < 1 || now.weekday > 5) return;
  if (clockInToday(now.dateKey) !== null || askedDate === now.dateKey) return;
  if (now.minutes < EARLIEST_IN || now.minutes > 14 * 60) return; // 08:30부터 물어봄
  if (Date.now() < snoozeUntil) return;
  snoozeUntil = Date.now() + 30 * 60 * 1000; // 그냥 닫아도 30분 뒤에 다시 물어봄
  const at = Math.floor(now.minutes);
  const leave = leaveAtFor(at)!;
  void showDialog({
    icon: "clock",
    title: `${hmLabel(at)}에 출근하셨나요?`,
    text: `${hmLabel(leave)}부터 퇴근할 수 있어요`,
    buttons: [
      {
        label: "오늘은 안 함",
        onClick: () => {
          askedDate = toKst(nowDate()).dateKey;
          safeSet("askedDate", askedDate);
        },
      },
      {
        label: "출근했어요",
        kind: "primary",
        onClick: () => {
          const k = toKst(nowDate());
          setClockIn(k.dateKey, Math.floor(k.minutes));
          askedDate = k.dateKey;
          safeSet("askedDate", askedDate);
          flash(`퇴근 가능 ${hmLabel(leaveAtFor(clockInToday(k.dateKey))!)}`, 5000);
          render();
        },
      },
    ],
  });
}

let leaveNotified = safeGet("leaveNotified") ?? "";
/** 락인 시작 미리보기 동안에는 ⌃⌘Q도 미리보기로 가로챈다 (실제로 잠그지 않음) */
let shortcutTestUntil = 0;

// ── 렌더 ────────────────────────────────────────────────

let lastPhaseKey = "";
let forceShow = false;
let settingsOpen = false;
let visible: boolean | null = null;

function setVisible(v: boolean) {
  if (v === visible) return;
  visible = v;
  (v ? win.show() : win.hide()).catch(() => {});
}

function render() {
  const now = toKst(nowDate());
  const sched = previewStartedAt ? settings : effectiveSchedule(now.dateKey);
  const phase = getPhase(now, sched);
  const key = phase.kind === "lock" ? `lock-${phase.which}` : phase.kind;
  const s = parseSchedule(sched)!;
  const leave = previewStartedAt ? null : leaveAtFor(clockInToday(now.dateKey));

  // 상태가 바뀌는 순간
  const prevKey = lastPhaseKey;
  lastPhaseKey = key;
  if (prevKey && key !== prevKey) {
    forceShow = false;
    if (prevKey.startsWith("lock")) {
      restartAnim(lockBtn, "pop");
      sparkle();
      flash(prevKey === "lock-am" ? "오전 코어타임이 끝났어요" : "오후 코어타임이 끝났어요", 6000);
      const canLeave = leave !== null && now.minutes >= leave;
      if (prevKey === "lock-pm" && canLeave) {
        leaveNotified = now.dateKey;
        safeSet("leaveNotified", leaveNotified);
        void celebrate("퇴근하셔도 좋아요", CELEBRATE_SUB_PM);
      } else {
        void celebrate(
          prevKey === "lock-am" ? CELEBRATE_TITLE : "오후 코어타임이 끝났어요",
          prevKey === "lock-am" ? CELEBRATE_SUB : CELEBRATE_SUB_PM,
        );
      }
    }
    if (key.startsWith("lock") && phase.kind === "lock") {
      restartAnim(widget, "lock-start");
      flash("코어타임이 시작됐어요", 3500);
      void announceLock(phase.end);
    }
  }

  // 퇴근 가능 시각이 코어타임 밖이면 따로 알려 준다
  if (!sim && leave !== null && now.minutes >= leave && leaveNotified !== now.dateKey && phase.kind !== "lock") {
    leaveNotified = now.dateKey;
    safeSet("leaveNotified", leaveNotified);
    if (now.minutes - leave < 30) void celebrate("퇴근하셔도 좋아요", CELEBRATE_SUB_PM);
  }
  maybeAskClockIn(now);

  // 시뮬레이션 진행: 09:12에 출근 처리, 19:00에 종료
  if (sim) {
    if (sim.clockIn === null && now.minutes >= 9 * 60 + 12) {
      sim.clockIn = 9 * 60 + 12;
      flash("09:12 출근 (미리보기)", 2500);
    }
    if (now.minutes >= SIM_TO_MIN) stopSim();
  }

  // 오후 락인 완료 기록 (평일 퇴근 시간 이후 앱이 켜져 있으면 집계)
  if (!sim && phase.kind === "done" && streak.lastDate !== now.dateKey) {
    streak = nextStreak(streak, now.dateKey);
    safeSet("streak", JSON.stringify(streak));
  }

  const warn = (phase.kind === "before" || phase.kind === "break") && phase.minutesUntil <= 10;
  lockedNow = phase.kind === "lock";
  remainingNow = phase.kind === "lock" ? phase.remainingSec : 0;

  widget.classList.toggle("locked", lockedNow);
  widget.classList.toggle("unlocked", !lockedNow);
  widget.classList.toggle("pm", phase.kind === "lock" && phase.which === "pm");
  widget.classList.toggle("idle", phase.kind !== "lock" && phase.kind !== "done");
  widget.classList.toggle("done", phase.kind === "done");
  widget.classList.toggle("warn", warn);
  applyTint(TRANSPARENCY, settings.glass);

  // 보조 정보: 출근 시각을 넣었으면 퇴근까지 남은 시간 (작게)
  const leaveInfo =
    leave === null ? null : now.minutes < leave ? `퇴근까지 ${hmLabel(Math.ceil(leave - now.minutes))}` : `퇴근 가능`;

  let progress = 0;
  let label = "";
  let clock = "";
  let pct = "";
  let msg = "";
  switch (phase.kind) {
    case "lock": {
      progress = phase.progress;
      label = `${phase.which === "am" ? "오전" : "오후"} 코어타임 · ${hmLabel(phase.start)}–${hmLabel(phase.end)}`;
      clock = `${formatClock(phase.remainingSec)}<small>남음</small>`;
      pct = `${Math.floor(progress * 100)}%`;
      msg = lineFor(phase.which, progress, Math.floor(now.minutes));
      break;
    }
    case "before":
      label = warn ? "곧 오전 코어타임이에요" : "출근 전 · 오전 코어타임까지";
      clock = `${formatDuration(phase.minutesUntil)}<small>후 시작</small>`;
      msg = warn ? "커피 마지막 찬스!" : hmLabel(s.amStart);
      break;
    case "break":
      label = warn ? "곧 오후 코어타임이에요" : "오후 코어타임까지";
      clock = `${formatDuration(phase.minutesUntil)}<small>후 시작</small>`;
      msg = warn ? "커피 마지막 찬스!" : hmLabel(s.pmStart);
      break;
    case "done":
      progress = 1;
      label = leave !== null ? `퇴근 가능 · ${hmLabel(leave)}부터` : "오늘 코어타임 완료";
      clock = leave !== null && now.minutes < leave ? `${formatDuration(leave - now.minutes)}<small>후 퇴근</small>` : `수고하셨어요`;
      msg = streak.count >= 2 ? `${streak.count}일 연속 지켰어요` : "편히 퇴근하세요";
      break;
    case "weekend":
      label = "주말";
      clock = `코어타임 없음`;
      msg = "편안한 주말 보내세요";
      break;
  }

  if (Date.now() < flashUntil) msg = flashText;
  msgEl.classList.toggle("flash", Date.now() < flashUntil);

  labelEl.textContent = label;
  pctEl.textContent = pct;
  clockEl.innerHTML = clock;
  msgEl.textContent = msg;
  // 보조 줄: 출근 / 퇴근까지 (출근 시각은 매일 새로)
  const ci = previewStartedAt ? null : clockInToday(now.dateKey);
  subLeftEl.textContent = ci === null ? "＋ 출근 시각" : `${hmLabel(ci)} 출근 → ${hmLabel(leave!)}`;
  subLeftEl.title = ci === null ? "오늘 출근 시각을 넣으면 퇴근 가능 시각을 알려 드려요" : "눌러서 출근 시각 수정";
  subLeftEl.classList.toggle("empty", ci === null);
  subRightEl.textContent = leaveInfo ?? "";
  fillEl.style.width = `${(progress * 100).toFixed(2)}%`;
  // 자물쇠 속 액체: 진행률만큼 아래에서 차오름 (몸통 y=20~42)
  lockFill.setAttribute("y", (42 - 22 * progress).toFixed(2));

  updateTray(phase, warn);

  const shouldShow =
    settingsOpen || dialogOpen || forceShow || (settings.showWidget && !(settings.hideOutside && phase.kind !== "lock"));
  setVisible(shouldShow);
}

// ── 락인 종료 축하: 화면 위쪽에 컨페티 한 번 + 글래스 카드 ──────────

const CELEBRATE_TITLE = "오전 코어타임이 끝났어요";
const CELEBRATE_SUB = "이제 편하게 업무 보세요";
const CELEBRATE_SUB_PM = "오늘도 수고 많으셨어요";

function announceLock(end: number) {
  return celebrate("코어타임이 시작됐어요", `${hmLabel(end)}까지 자리를 지켜 주세요`, "lock");
}

async function celebrate(title = CELEBRATE_TITLE, sub = CELEBRATE_SUB, mode: "celebrate" | "lock" = "celebrate") {
  if (demo?.celebrate) {
    demo.celebrate(title, sub);
    if (!demo.alert) return;
  }
  // 카드는 다른 알림과 같은 공통 카드로 (위젯 모니터 상단 가운데)
  void showDialog({
    icon: "lock",
    iconAnim: mode === "lock" ? "lock" : "unlock",
    title,
    text: sub,
    buttons: [],
    autoCloseMs: 3000,
  });
  if (demo) return;
  try {
    // 위젯이 있는 모니터 전체를 덮는 투명·클릭 통과 창
    const m = (await currentMonitor()) ?? (await primaryMonitor());
    if (!m) return;
    const sf = m.scaleFactor;
    // 효과가 위젯(=알림 카드) 한가운데에서 퍼지도록, 모니터 기준 위젯 중심 좌표를 넘긴다
    const wp = await win.outerPosition().catch(() => null);
    const cx = wp ? (wp.x - m.position.x) / sf + 140 : m.size.width / sf / 2;
    const cy = wp ? (wp.y - m.position.y) / sf + 47 : 80;
    const q = new URLSearchParams({ title, sub, mode, card: "0", cx: String(Math.round(cx)), cy: String(Math.round(cy)) }).toString();
    const w = new WebviewWindow(`confetti-${Date.now()}`, {
      url: `confetti.html?${q}`,
      x: m.position.x / sf,
      y: m.position.y / sf,
      width: m.size.width / sf,
      height: m.size.height / sf,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focus: false,
      shadow: false,
      resizable: false,
      visibleOnAllWorkspaces: true,
    });
    w.once("tauri://created", () => void w.setIgnoreCursorEvents(true).catch(() => {}));
  } catch {
    /* 축하 창을 못 띄워도 위젯 안 효과는 이미 나왔음 */
  }
}

// ── 말풍선 알림 ─────────────────────────────────────────

const dialogEl = $("dialog");
const dIcon = $("dIcon");
const dTitle = $("dTitle");
const dText = $("dText");
const dButtons = $("dButtons");
let dialogOpen = false;
let dialogTimer: number | undefined;

// 말풍선 아이콘: 축하 카드와 같은 유리 자물쇠 스타일의 SVG
const GRAD = `<defs><linearGradient id="dg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7cc4ff"/><stop offset="1" stop-color="#8b6dff"/></linearGradient></defs>`;
const LOCK_BODY = `<rect x="9" y="20" width="30" height="22" rx="7" fill="rgba(255,255,255,0.88)" stroke="#fff" stroke-width="1.2"/><circle cx="24" cy="29.5" r="2.6" fill="#8b6dff"/><path d="M22.7 30.5h2.6l.8 5.2h-4.2z" fill="#8b6dff"/>`;
const ICONS = {
  lock: `${GRAD}<g class="shackle"><path d="M16 21v-5.5a8 8 0 0 1 16 0V21" fill="none" stroke="url(#dg)" stroke-width="4.4" stroke-linecap="round"/></g>${LOCK_BODY}`,
  open: `${GRAD}<g transform="rotate(-16 32 21) translate(0 -5)"><path d="M16 21v-5.5a8 8 0 0 1 16 0V21" fill="none" stroke="url(#dg)" stroke-width="4.4" stroke-linecap="round"/></g>${LOCK_BODY}`,
  clock: `${GRAD}<circle cx="24" cy="25" r="15" fill="rgba(255,255,255,0.88)" stroke="url(#dg)" stroke-width="3.6"/><path d="M24 17v8.5l5.5 3.5" fill="none" stroke="#8b6dff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  away: `${GRAD}<rect x="7" y="10" width="34" height="23" rx="5" fill="rgba(255,255,255,0.88)" stroke="url(#dg)" stroke-width="3.2"/><path d="M18 40h12M24 33v7" stroke="url(#dg)" stroke-width="3.2" stroke-linecap="round"/><circle cx="19" cy="21.5" r="2.2" fill="#8b6dff"/><circle cx="29" cy="21.5" r="2.2" fill="#8b6dff"/>`,
  bye: `${GRAD}<circle cx="24" cy="24" r="15" fill="rgba(255,255,255,0.88)" stroke="url(#dg)" stroke-width="3.6"/><path d="M24 15v9" stroke="#8b6dff" stroke-width="3.4" stroke-linecap="round"/>`,
} as const;
type IconName = keyof typeof ICONS;

interface DialogButton {
  label: string;
  kind?: "primary" | "danger";
  onClick?: () => void;
}

let returnToSettings = false;

interface DialogOpts {
  icon: IconName;
  iconAnim?: "lock" | "unlock";
  title: string;
  text: string;
  buttons: DialogButton[];
  warn?: boolean;
  autoCloseMs?: number;
}

// 모든 알림은 같은 크기의 글래스 카드로, 위젯이 있는 모니터의 상단 가운데에 띄운다
const alertButtons = new Map<string, DialogButton[]>();
let currentAlert: WebviewWindow | null = null;
const ALERT_W = 280;

async function openAlert(opts: DialogOpts) {
  const id = `alert-${Date.now()}`;
  alertButtons.set(id, opts.buttons);
  const prev = currentAlert;
  currentAlert = null;
  if (prev) void prev.destroy().catch(() => {});
  const m = (await currentMonitor()) ?? (await primaryMonitor());
  if (!m) return;
  const sf = m.scaleFactor;
  const spec = {
    id,
    icon: ICONS[opts.icon],
    iconAnim: opts.iconAnim,
    title: opts.title,
    text: opts.text,
    buttons: opts.buttons.map((b) => ({ label: b.label, kind: b.kind })),
    warn: opts.warn,
    autoCloseMs: opts.autoCloseMs,
  };
  if (opts.buttons.length) dialogOpen = true;
  // 위젯과 정확히 같은 자리에 겹쳐서 띄운다
  const wp = await win.outerPosition().catch(() => null);
  const wsf = await win.scaleFactor().catch(() => sf);
  const ax = wp ? wp.x / wsf : m.position.x / sf + (m.size.width / sf - ALERT_W) / 2;
  const ay = wp ? wp.y / wsf : m.position.y / sf + 30;
  currentAlert = new WebviewWindow(id, {
    url: `alert.html?spec=${encodeURIComponent(JSON.stringify(spec))}`,
    x: ax,
    y: ay,
    width: ALERT_W,
    height: 94,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focus: opts.buttons.length > 0,
    shadow: false,
    resizable: false,
    visibleOnAllWorkspaces: true,
    visible: false,
  });
}

void listen<{ id: string; index: number }>("alert-result", (e) => {
  const buttons = alertButtons.get(e.payload.id);
  alertButtons.delete(e.payload.id);
  if (currentAlert?.label === e.payload.id) currentAlert = null;
  if (buttons?.length) dialogOpen = false;
  if (buttons && e.payload.index >= 0) buttons[e.payload.index]?.onClick?.();
  render();
});

async function showDialog(opts: DialogOpts) {
  if (demo?.alert) {
    dialogOpen = opts.buttons.length > 0;
    return demo.alert({
      ...opts,
      iconSvg: ICONS[opts.icon],
      buttons: opts.buttons.map((b) => ({
        ...b,
        onClick: () => {
          dialogOpen = false;
          b.onClick?.();
          render();
        },
      })),
      onClose: () => {
        dialogOpen = false;
        render();
      },
    });
  }
  if (!demo) return openAlert(opts);
  if (settingsOpen) {
    // 설정은 닫지 않고 잠깐 가려 둔다 (말풍선을 닫으면 그대로 돌아옴)
    returnToSettings = true;
    settingsOpen = false;
    form.hidden = true;
  }
  dialogOpen = true;
  dIcon.innerHTML = `<svg viewBox="0 0 48 48" width="30" height="30" aria-hidden="true">${ICONS[opts.icon]}</svg>`;
  dTitle.textContent = opts.title;
  dText.textContent = opts.text;
  dButtons.replaceChildren(
    ...opts.buttons.map((b) => {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = b.label;
      if (b.kind) el.className = b.kind;
      el.addEventListener("click", () => {
        closeDialog();
        b.onClick?.();
      });
      return el;
    }),
  );
  widget.classList.toggle("dialog-warn", !!opts.warn);
  dialogEl.hidden = false;
  restartAnim(dialogEl, "dialog");
  widget.classList.add("overlay-open");
  setVisible(true);
  await resizeTo(DIALOG_SIZE);
  await ensureOnScreen().catch(() => {});
  window.clearTimeout(dialogTimer);
  if (opts.autoCloseMs) dialogTimer = window.setTimeout(() => closeDialog(), opts.autoCloseMs);
}

function closeDialog(resize = true) {
  if (!dialogOpen) return;
  dialogOpen = false;
  window.clearTimeout(dialogTimer);
  dialogEl.hidden = true;
  widget.classList.remove("dialog-warn");
  if (returnToSettings) {
    returnToSettings = false;
    settingsOpen = true;
    form.hidden = false;
    void resizeTo(SETTINGS_SIZE);
    return;
  }
  if (!settingsOpen) widget.classList.remove("overlay-open");
  if (resize && !settingsOpen) void resizeTo(WIDGET_SIZE).then(render);
}

// ── 화면 잠금: 앱 버튼으로 잠글 때는 확인부터 ─────────────────

async function doLock() {
  if (demo?.lockScreen) return demo.lockScreen();
  try {
    await invoke("lock_screen");
  } catch {
    flash("화면을 잠그지 못했어요");
  }
}

function requestLock(preview = false) {
  const phase = phaseAt(nowDate());
  const go = () => (preview ? flash("미리보기라 실제로 잠그지는 않았어요", 3500) : void doLock());
  if (phase.kind === "lock" || preview) {
    const mins = phase.kind === "lock" ? phase.remainingSec / 60 : 42;
    void showDialog({
      icon: "lock",
      title: "지금은 코어타임이에요",
      text: `${formatDuration(mins)} 남았어요. 정말 잠글까요?`,
      buttons: [{ label: "취소", kind: "primary" }, { label: "잠그기", kind: "danger", onClick: go }],
    });
  } else if ((phase.kind === "before" || phase.kind === "break") && phase.minutesUntil <= 10) {
    void showDialog({
      icon: "clock",
      title: `코어타임 ${Math.ceil(phase.minutesUntil)}분 전이에요`,
      text: "시작 전에 돌아와 주세요",
      warn: true,
      buttons: [{ label: "취소" }, { label: "잠그기", kind: "primary", onClick: go }],
    });
  } else {
    go();
  }
}

$("lockScreen").addEventListener("click", (e) => {
  e.stopPropagation();
  requestLock();
});

// ── 화면 잠금 감지 (Win+L, ⌃⌘Q 등으로 잠근 경우) → 돌아오면 알려 주기 ──

let lockedAt: { time: number; phase: Phase } | null = null;

function handleScreenLock(locked: boolean) {
  const nowMs = nowDate().getTime();
  if (locked) {
    const p = phaseAt(new Date(nowMs));
    lockedAt = { time: nowMs, phase: p };
    // 잠금 화면에도 보이는 시스템 알림 (macOS: 알림 설정에서 '잠금 화면에 표시' 허용 시)
    const testing = Date.now() < shortcutTestUntil;
    if (p.kind === "lock" || testing) {
      const until = p.kind === "lock" ? `${hmLabel(p.end)}까지` : "(미리보기)";
      invoke("notify", { title: "지금은 코어타임이에요", body: `${until} · 자리 비움은 근태 위반으로 집계될 수 있어요` }).catch(() => {});
    } else if ((p.kind === "before" || p.kind === "break") && p.minutesUntil <= 10) {
      invoke("notify", { title: "곧 코어타임이 시작돼요", body: `${Math.ceil(p.minutesUntil)}분 뒤 시작 · 늦지 않게 돌아와 주세요` }).catch(() => {});
    }
    return;
  }
  if (!lockedAt) return;
  const { time, phase: before } = lockedAt;
  lockedAt = null;
  const awayMin = Math.round((nowMs - time) / 60000);
  const after = phaseAt(new Date(nowMs));
  const wasWarn = (before.kind === "before" || before.kind === "break") && before.minutesUntil <= 10;

  if (before.kind === "lock") {
    void showDialog({
      icon: "away",
      title: `코어타임 중 ${Math.max(1, awayMin)}분 자리 비움`,
      text: "업무 외 자리 비움은 주의해 주세요",
      warn: true,
      buttons: [{ label: "확인", kind: "primary" }],
    });
  } else if (wasWarn && after.kind === "lock") {
    const late = Math.max(1, Math.round((after.progress * (after.end - after.start))));
    void showDialog({
      icon: "clock",
      title: `코어타임 시작 ${late}분 뒤 복귀`,
      text: "다음엔 조금 일찍 돌아와 주세요",
      warn: true,
      buttons: [{ label: "확인", kind: "primary" }],
    });
  } else if (wasWarn) {
    flash("코어타임 전에 돌아오셨어요", 4000);
  }
}

void listen<{ locked: boolean }>("screen-lock", (e) => handleScreenLock(e.payload.locked));
void listen("request-lock", () => requestLock());
// ⌃⌘Q를 가로챘을 때 → 확인 말풍선 (잠그기를 누르면 실제로 잠금)


// 종료 요청: 코어타임 중이면 거절
void listen("request-quit", () => {
  const phase = phaseAt(nowDate());
  if (phase.kind === "lock") {
    const mins = Math.ceil(phase.remainingSec / 60);
    void showDialog({
      icon: "lock",
      title: "코어타임 중엔 종료할 수 없어요",
      text: `${formatDuration(mins)} 뒤에 종료할 수 있어요`,
      buttons: [{ label: "확인", kind: "primary" }],
    });
    return;
  }
  void showDialog({
    icon: "bye",
    title: "코어타이머를 종료할까요?",
    text: "다시 켤 때까지 알림이 오지 않아요",
    buttons: [{ label: "취소" }, { label: "종료", kind: "danger", onClick: () => void invoke("quit_app").catch(() => {}) }],
  });
});
void listen("preview-celebrate", () => void celebrate());

$("previewCelebrate").addEventListener("click", () => {
  restartAnim(lockBtn, "pop");
  sparkle();
  void celebrate();
});
$("previewLock").addEventListener("click", () => requestLock(true));

// 락인 시작 미리보기: 위젯이 잠긴 상태로 9초 동안 빠르게 흘러가는 모습 + 시작 알림
async function previewLockStart() {
  shortcutTestUntil = Date.now() + PREVIEW_MS;
  render();
  if (settingsOpen) {
    // 설정은 그대로 두고 화면 위 시작 알림만 보여 준다
    void announceLock(parseSchedule(settings)!.amEnd);
    return;
  }
  closeDialog();
  lastPhaseKey = ""; // 미리보기 진입은 상태 전환으로 치지 않음
  previewStartedAt = Date.now();
  forceShow = true;
  render();
  restartAnim(widget, "lock-start");
  flash("코어타임이 시작됐어요 (미리보기)", 3500);
  const s = parseSchedule(settings)!;
  void announceLock(s.amEnd);
  window.setTimeout(() => {
    previewStartedAt = 0;
    lastPhaseKey = ""; // 미리보기 종료도 상태 전환으로 치지 않음
    forceShow = false;
    render();
  }, PREVIEW_MS + 50);
}
$("previewStart").addEventListener("click", () => void previewLockStart());

async function startSim() {
  if (settingsOpen) await closeSettings();
  closeDialog();
  lastPhaseKey = "";
  sim = { startedAt: Date.now(), base: SIM_FROM, clockIn: null };
  forceShow = true;
  flash("하루 빠르게 미리보기 (약 40초)", 2500);
  render();
}
function stopSim() {
  if (!sim) return;
  sim = null;
  lastPhaseKey = "";
  forceShow = false;
  flash("미리보기가 끝났어요", 2500);
  window.setTimeout(render, 0);
}
$("simDay").addEventListener("click", () => void startSim());
void listen("simulate-day", () => void startSim());
void listen("preview-lock-start", () => void previewLockStart());

// 미리보기 페이지용
if (demo)
  Object.assign(demo, {
    handleScreenLock,
    render,
    openSettings,
    requestLock,
    previewLockStart: () => void previewLockStart(),
    previewEnd: () => {
      restartAnim(lockBtn, "pop");
      sparkle();
      void celebrate();
    },
    startSim: () => void startSim(),
    resetPhase: () => {
      lastPhaseKey = "";
      render();
    },
  });

// ── 드래그 이동 ─────────────────────────────────────────

widget.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const t = e.target as HTMLElement;
  if (t.closest(".no-drag, input, button, label, select")) return;
  // Windows 아크릴 효과는 드래그 중에 버벅일 수 있어서, 옮기는 동안만 잠깐 끄고 놓으면 다시 켠다
  if (IS_WINDOWS && settings.glass) {
    draggingGlassOff = true;
    void win.clearEffects().catch(() => {});
  }
  win.startDragging().catch(() => {});
});
let draggingGlassOff = false;

widget.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  void openSettings();
});

// ── 위치 기억 & 멀티 모니터 ──────────────────────────────

function insideMonitor(x: number, y: number, m: Monitor) {
  const mx = m.position.x;
  const my = m.position.y;
  return x >= mx - 40 && x < mx + m.size.width - 60 && y >= my - 20 && y < my + m.size.height - 40;
}

async function placeOn(m: Monitor | null) {
  if (!m) return;
  const size = await win.outerSize();
  const x = m.position.x + Math.round((m.size.width - size.width) / 2);
  const y = m.position.y + Math.round(48 * m.scaleFactor);
  await win.setPosition(new PhysicalPosition(x, y));
}

async function ensureOnScreen() {
  const monitors = await availableMonitors();
  if (!monitors || monitors.length === 0) return;
  const pos = await win.outerPosition();
  if (!monitors.some((m) => insideMonitor(pos.x, pos.y, m))) {
    // 모니터를 분리해서 화면 밖으로 나가면 주 모니터로 복귀
    await placeOn((await primaryMonitor()) ?? monitors[0]);
  }
}

async function restorePosition() {
  try {
    const raw = safeGet("pos");
    const saved = raw ? (JSON.parse(raw) as { x: number; y: number }) : null;
    const monitors = (await availableMonitors()) ?? [];
    if (saved && monitors.some((m) => insideMonitor(saved.x, saved.y, m))) {
      await win.setPosition(new PhysicalPosition(saved.x, saved.y));
    } else {
      await placeOn((await primaryMonitor()) ?? monitors[0] ?? null);
    }
  } catch {
    /* 위치 API를 지원하지 않는 환경(Wayland 등) */
  }
}

let saveTimer: number | undefined;
win
  .onMoved(({ payload }) => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      safeSet("pos", JSON.stringify({ x: payload.x, y: payload.y }));
      if (draggingGlassOff) {
        draggingGlassOff = false;
        void applyGlass();
      }
    }, 400);
  })
  .catch(() => {});

// ── 글래스 효과 (macOS 비브런시 / Windows 아크릴, Linux는 반투명으로 대체) ──

async function applyGlass() {
  try {
    if (settings.glass) {
      // state: Active — 위젯은 포커스를 받지 않으므로, 안 그러면 회색(비활성) 재질로 보인다
      await win.setTheme("light").catch(() => {}); // 밝은 유리 재질 (어두운 모드에서도 회색이 아니게)
      await win.setEffects({ effects: [Effect.Sidebar, Effect.Acrylic], state: EffectState.Active, radius: 18 });
    } else {
      await win.clearEffects();
    }
  } catch {
    /* 지원하지 않는 OS */
  }
}

// ── 설정 패널 ───────────────────────────────────────────

type FormFields = Record<string, HTMLInputElement>;

function fillForm(s: Settings) {
  const f = form.elements as unknown as FormFields;
  f.amStart.value = s.amStart;
  f.amEnd.value = s.amEnd;
  f.pmStart.value = s.pmStart;
  f.pmEnd.value = s.pmEnd;
  f.hideOutside.checked = s.hideOutside;
  const today = toKst(nowDate());
  const ci = clockInToday(today.dateKey);
  f.clockIn.value = ci === null ? "" : hmLabel(ci);
  updateLeaveHint();
  invoke<boolean>("get_autostart")
    .then((on) => (f.autostart.checked = on))
    .catch(() => {});
}

async function openSettings() {
  if (settingsOpen) return;
  settingsOpen = true;
  fillForm(settings);
  settingsError.hidden = true;
  form.hidden = false;
  closeDialog(false);
  widget.classList.add("overlay-open");
  setVisible(true);
  await resizeTo(SETTINGS_SIZE);
  await ensureOnScreen().catch(() => {});
  await win.setFocus().catch(() => {});
}

async function closeSettings() {
  settingsOpen = false;
  form.hidden = true;
  widget.classList.remove("overlay-open");
  await resizeTo(WIDGET_SIZE);
  render();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = form.elements as unknown as FormFields;
  const next: Settings = {
    ...settings,
    amStart: f.amStart.value,
    amEnd: f.amEnd.value,
    pmStart: f.pmStart.value,
    pmEnd: f.pmEnd.value,
    hideOutside: f.hideOutside.checked,
  };
  if (!parseSchedule(next)) {
    settingsError.hidden = false;
    return;
  }
  invoke("set_autostart", { enabled: f.autostart.checked }).catch(() => {});
  {
    const today = toKst(nowDate());
    const v = f.clockIn.value ? parseHmInput(f.clockIn.value) : null;
    setClockIn(today.dateKey, v);
    if (v !== null) {
      askedDate = today.dateKey;
      safeSet("askedDate", askedDate);
    }
  }
  const glassChanged = next.glass !== settings.glass;
  settings = next;
  safeSet("settings", JSON.stringify(settings));
  lastTrayKey = "";
  if (glassChanged) void applyGlass();
  void closeSettings();
});
$("cancelSettings").addEventListener("click", () => {
  void applyGlass(); // 미리보기 되돌리기
  void closeSettings();
});
$("resetDefaults").addEventListener("click", () => fillForm({ ...settings, ...DEFAULT_SCHEDULE }));

function parseHmInput(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function updateLeaveHint() {
  const f = form.elements as unknown as FormFields;
  const v = f.clockIn.value ? parseHmInput(f.clockIn.value) : null;
  $("leaveHint").textContent = v === null ? "퇴근 가능 --:--" : `퇴근 가능 ${hmLabel(leaveAtFor(v)!)}`;
}
(form.elements.namedItem("clockIn") as HTMLInputElement).addEventListener("input", updateLeaveHint);
$("clockInNow").addEventListener("click", () => {
  const f = form.elements as unknown as FormFields;
  f.clockIn.value = hmLabel(Math.floor(toKst(nowDate()).minutes));
  updateLeaveHint();
});

// 설정 화면에서 바로 미리 보이게
function previewTint() {
  const f = form.elements as unknown as FormFields;
  applyTint(TRANSPARENCY, f.glass.checked);
  if (f.glass.checked !== settings.glass) {
    void (f.glass.checked
      ? win.setEffects({ effects: [Effect.Sidebar, Effect.Acrylic], state: EffectState.Active, radius: 18 })
      : win.clearEffects()
    ).catch(() => {});
  }
}

// ── 트레이/메뉴 막대 이벤트 ─────────────────────────────

function saveAndRender() {
  safeSet("settings", JSON.stringify(settings));
  lastTrayKey = "";
  render();
}

void listen("open-settings", () => void openSettings());
subLeftEl.addEventListener("click", async (e) => {
  e.stopPropagation();
  await openSettings();
  (form.elements.namedItem("clockIn") as HTMLInputElement).focus();
});
void listen("set-clock-in", async () => {
  await openSettings();
  (form.elements.namedItem("clockIn") as HTMLInputElement).focus();
});
void listen("toggle-widget", () => {
  settings.showWidget = !settings.showWidget;
  forceShow = false;
  saveAndRender();
  invoke("set_widget_checked", { checked: settings.showWidget }).catch(() => {});
});
void listen("toggle-menubar-text", () => {
  settings.menuBarText = !settings.menuBarText;
  saveAndRender();
  invoke("set_menubar_checked", { checked: settings.menuBarText }).catch(() => {});
});

// ── 첫 실행 안내: 위젯이 좌우로 살짝 흔들리며 빛나고 '끌어서 옮길 수 있어요' 표시 ──

async function introOnce() {
  if (safeGet("introDone")) return;
  safeSet("introDone", "1");
  await new Promise((r) => window.setTimeout(r, 700));
  restartAnim(widget, "intro");
  flash("끌어서 원하는 곳으로 옮길 수 있어요", 7000);
  try {
    // 실제 창을 좌우로 흔들어 '여기 있어요' 느낌
    const base = await win.outerPosition();
    const sf = await win.scaleFactor();
    const offsets = [0, -10, 10, -8, 8, -5, 5, -2, 2, 0];
    for (const dx of offsets) {
      await win.setPosition(new PhysicalPosition(base.x + Math.round(dx * sf), base.y));
      await new Promise((r) => window.setTimeout(r, 55));
    }
    await new Promise((r) => window.setTimeout(r, 450));
    for (const dx of offsets) {
      await win.setPosition(new PhysicalPosition(base.x + Math.round(dx * sf), base.y));
      await new Promise((r) => window.setTimeout(r, 55));
    }
  } catch {
    /* 위치 API를 지원하지 않는 환경 */
  }
}

// ── 시작 ────────────────────────────────────────────────

async function start() {
  await resizeTo(WIDGET_SIZE);
  await restorePosition();
  await applyGlass();
  invoke("set_widget_checked", { checked: settings.showWidget }).catch(() => {});
  invoke("set_menubar_checked", { checked: settings.menuBarText }).catch(() => {});
  render();
  void introOnce();
  // 매 초 갱신 (현재 시각 기준으로 다시 계산하므로 절전 해제 후에도 정확)
  window.setInterval(render, 1000);
  // 모니터 연결이 바뀌어도 화면 밖으로 사라지지 않게 주기적으로 확인
  window.setInterval(() => void ensureOnScreen().catch(() => {}), 15000);
}

void start();
