import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE,
  formatClock,
  formatDuration,
  getPhase,
  lineFor,
  nextStreak,
  parseSchedule,
  previousWeekdayKey,
  toKst,
} from "./time";

// 2026-10-02(금) KST 시각을 UTC Date로 만들기
const kst = (iso: string) => new Date(`${iso}+09:00`);

describe("toKst", () => {
  it("UTC 자정 직전도 한국 날짜로 변환한다", () => {
    const n = toKst(new Date("2026-10-01T23:30:00Z")); // KST 10/2 08:30
    expect(n.dateKey).toBe("2026-10-02");
    expect(n.weekday).toBe(5);
    expect(n.minutes).toBeCloseTo(8 * 60 + 30);
  });
});

describe("getPhase (기본 스케줄)", () => {
  const at = (iso: string) => getPhase(toKst(kst(iso)), DEFAULT_SCHEDULE);

  it("주말에는 락인 없음", () => {
    expect(at("2026-10-03T09:00:00").kind).toBe("weekend");
    expect(at("2026-10-04T17:00:00").kind).toBe("weekend");
  });

  it("출근 전", () => {
    const p = at("2026-10-02T08:20:00");
    expect(p).toMatchObject({ kind: "before" });
    if (p.kind === "before") expect(p.minutesUntil).toBeCloseTo(10);
  });

  it("오전 락인 진행률과 남은 시간", () => {
    const p = at("2026-10-02T09:30:00");
    expect(p).toMatchObject({ kind: "lock", which: "am" });
    if (p.kind === "lock") {
      expect(p.progress).toBeCloseTo(0.5);
      expect(p.remainingSec).toBe(3600);
    }
  });

  it("경계: 10:30 정각은 자유 시간", () => {
    expect(at("2026-10-02T10:30:00").kind).toBe("break");
    expect(at("2026-10-02T10:29:59").kind).toBe("lock");
  });

  it("오후 락인과 완료", () => {
    expect(at("2026-10-02T16:30:00")).toMatchObject({ kind: "lock", which: "pm" });
    expect(at("2026-10-02T18:30:00").kind).toBe("done");
  });
});

describe("스케줄 검증", () => {
  it("순서가 잘못되면 null", () => {
    expect(parseSchedule({ ...DEFAULT_SCHEDULE, amEnd: "08:00" })).toBeNull();
    expect(parseSchedule({ ...DEFAULT_SCHEDULE, pmStart: "25:00" })).toBeNull();
  });
  it("잘못된 스케줄이면 기본값으로 계산", () => {
    const p = getPhase(toKst(kst("2026-10-02T09:00:00")), { ...DEFAULT_SCHEDULE, amEnd: "07:00" });
    expect(p).toMatchObject({ kind: "lock", which: "am" });
  });
  it("사용자 지정 시간", () => {
    const p = getPhase(toKst(kst("2026-10-02T11:00:00")), { amStart: "09:30", amEnd: "11:30", pmStart: "16:30", pmEnd: "18:30" });
    expect(p).toMatchObject({ kind: "lock", which: "am" });
  });
});

describe("표시 형식", () => {
  it("formatClock", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(59)).toBe("00:59");
    expect(formatClock(-3)).toBe("00:00");
  });
  it("formatDuration", () => {
    expect(formatDuration(5.2)).toBe("6분");
    expect(formatDuration(120)).toBe("2시간");
    expect(formatDuration(125)).toBe("2시간 5분");
  });
  it("lineFor는 항상 문구를 돌려준다", () => {
    for (const p of [0, 0.3, 0.6, 0.8, 0.99]) expect(lineFor("am", p, 42).length).toBeGreaterThan(0);
  });
});

describe("연속 기록", () => {
  it("월요일의 직전 평일은 금요일", () => {
    expect(previousWeekdayKey("2026-10-05")).toBe("2026-10-02");
  });
  it("연속이면 +1, 끊기면 1", () => {
    expect(nextStreak({ lastDate: "2026-10-02", count: 3 }, "2026-10-05").count).toBe(4);
    expect(nextStreak({ lastDate: "2026-09-30", count: 3 }, "2026-10-05").count).toBe(1);
    expect(nextStreak({ lastDate: "2026-10-05", count: 4 }, "2026-10-05").count).toBe(4);
  });
});
