// 시간 계산 로직 (UI와 분리된 순수 함수 — 테스트 대상)
// 한국은 서머타임이 없으므로 UTC+9 고정으로 계산한다.

export type Hm = string; // "HH:MM"

export interface Schedule {
  amStart: Hm;
  amEnd: Hm;
  pmStart: Hm;
  pmEnd: Hm;
}

export const DEFAULT_SCHEDULE: Schedule = {
  amStart: "08:30",
  amEnd: "10:30",
  pmStart: "16:30",
  pmEnd: "18:30",
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface KstNow {
  /** 0=일 ... 6=토 */
  weekday: number;
  /** 자정부터 지난 분(초 단위 소수 포함) */
  minutes: number;
  /** YYYY-MM-DD (KST) */
  dateKey: string;
}

export function toKst(date: Date): KstNow {
  const s = new Date(date.getTime() + KST_OFFSET_MS);
  const minutes =
    s.getUTCHours() * 60 +
    s.getUTCMinutes() +
    s.getUTCSeconds() / 60 +
    s.getUTCMilliseconds() / 60000;
  const dateKey = s.toISOString().slice(0, 10);
  return { weekday: s.getUTCDay(), minutes, dateKey };
}

export function isWeekday(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

export function parseHm(hm: Hm): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export interface ParsedSchedule {
  amStart: number;
  amEnd: number;
  pmStart: number;
  pmEnd: number;
}

/** 순서가 올바른 스케줄만 통과시킨다. 아니면 null */
export function parseSchedule(s: Schedule): ParsedSchedule | null {
  const p = {
    amStart: parseHm(s.amStart),
    amEnd: parseHm(s.amEnd),
    pmStart: parseHm(s.pmStart),
    pmEnd: parseHm(s.pmEnd),
  };
  if (Object.values(p).some((v) => v === null)) return null;
  const q = p as ParsedSchedule;
  if (!(q.amStart < q.amEnd && q.amEnd <= q.pmStart && q.pmStart < q.pmEnd)) return null;
  return q;
}

export type Which = "am" | "pm";

export type Phase =
  | { kind: "weekend" }
  | { kind: "before"; minutesUntil: number }
  | {
      kind: "lock";
      which: Which;
      progress: number; // 0..1
      remainingSec: number;
      start: number;
      end: number;
    }
  | { kind: "break"; minutesUntil: number }
  | { kind: "done" };

export function getPhase(now: KstNow, schedule: Schedule): Phase {
  if (!isWeekday(now.weekday)) return { kind: "weekend" };
  const s = parseSchedule(schedule) ?? (parseSchedule(DEFAULT_SCHEDULE) as ParsedSchedule);
  const t = now.minutes;

  const lock = (which: Which, start: number, end: number): Phase => ({
    kind: "lock",
    which,
    start,
    end,
    progress: Math.min(1, Math.max(0, (t - start) / (end - start))),
    remainingSec: Math.max(0, Math.ceil((end - t) * 60)),
  });

  if (t < s.amStart) return { kind: "before", minutesUntil: s.amStart - t };
  if (t < s.amEnd) return lock("am", s.amStart, s.amEnd);
  if (t < s.pmStart) return { kind: "break", minutesUntil: s.pmStart - t };
  if (t < s.pmEnd) return lock("pm", s.pmStart, s.pmEnd);
  return { kind: "done" };
}

export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.ceil(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

export function hmLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 직전 평일 날짜 키 (연속 기록 계산용) */
export function previousWeekdayKey(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (!isWeekday(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

/** 오후 락인 완주 시 연속 기록 갱신 */
export function nextStreak(
  prev: { lastDate: string | null; count: number },
  todayKey: string,
): { lastDate: string; count: number } {
  if (prev.lastDate === todayKey) return { lastDate: todayKey, count: prev.count };
  if (prev.lastDate && prev.lastDate === previousWeekdayKey(todayKey)) {
    return { lastDate: todayKey, count: prev.count + 1 };
  }
  return { lastDate: todayKey, count: 1 };
}

// ── 진행률에 따라 바뀌는 한마디 ──────────────────────────

const AM_LINES: [number, string[]][] = [
  [0.0, ["집중하기 좋은 시간이에요", "오늘 첫 업무를 시작해 보세요"]],
  [0.25, ["차분히 이어가 보세요", "흐름이 좋아요"]],
  [0.5, ["절반이 지났어요", "잘 이어가고 있어요"]],
  [0.75, ["막판 스퍼트!", "조금만 더 이어가 볼까요"]],
  [0.92, ["곧 오전 코어타임이 끝나요"]],
];

const PM_LINES: [number, string[]][] = [
  [0.0, ["오후 코어타임이에요", "하루를 정리해 보세요"]],
  [0.25, ["차분히 마무리해 보세요", "남은 일을 확인해 보세요"]],
  [0.5, ["절반이 지났어요", "잘 마무리하고 있어요"]],
  [0.75, ["막판 스퍼트!", "내일 할 일도 적어 두세요"]],
  [0.92, ["곧 코어타임이 끝나요"]],
];

/** 코어타임 중 자물쇠를 누르면 */
export const NOPE = ["코어타임이 끝나면 열려요", "지금은 자리를 지켜 주세요"];

/** 코어타임이 아닐 때 자물쇠를 누르면 */
export const CHEERS = ["오늘도 수고 많으세요", "잠시 물 한 잔 어떠세요", "어깨를 한번 펴 보세요", "잠깐 눈을 쉬어 주세요"];

/** 같은 구간 안에서는 몇 분마다 문구가 바뀌도록 seed(분 단위)를 받는다 */
export function lineFor(which: Which, progress: number, seed: number): string {
  const table = which === "am" ? AM_LINES : PM_LINES;
  let lines = table[0][1];
  for (const [threshold, l] of table) if (progress >= threshold) lines = l;
  const idx = Math.abs(Math.floor(seed / 7)) % lines.length; // 7분마다 교체
  return lines[idx];
}

export type Mood = "sleepy" | "calm" | "happy" | "excited";

export function moodFor(progress: number): Mood {
  if (progress < 0.2) return "sleepy";
  if (progress < 0.6) return "calm";
  if (progress < 0.9) return "happy";
  return "excited";
}
