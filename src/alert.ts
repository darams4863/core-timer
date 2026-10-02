// 공통 알림 카드 창: 위젯이 있는 모니터의 상단 가운데에 뜬다.
// 버튼을 누르면 "alert-result" 이벤트로 메인 위젯에 알려 주고 스스로 닫힌다.
import { emit } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface AlertButton {
  label: string;
  kind?: "primary" | "danger";
}
interface AlertSpec {
  id: string;
  icon: string; // SVG 내용
  iconAnim?: "lock" | "unlock";
  title: string;
  text: string;
  buttons: AlertButton[];
  warn?: boolean;
  autoCloseMs?: number;
}

const spec: AlertSpec = JSON.parse(new URLSearchParams(location.search).get("spec") ?? "{}");
const win = getCurrentWindow();
const card = document.getElementById("card")!;

document.getElementById("icon")!.innerHTML = `<svg viewBox="0 0 48 48" width="36" height="36" aria-hidden="true">${spec.icon}</svg>`;
if (spec.iconAnim) document.body.classList.add(`anim-${spec.iconAnim}`);
document.getElementById("title")!.textContent = spec.title;
document.getElementById("text")!.textContent = spec.text;
document.body.classList.toggle("warn", !!spec.warn);

let done = false;
async function finish(index: number) {
  if (done) return;
  done = true;
  await emit("alert-result", { id: spec.id, index }).catch(() => {});
  card.classList.add("out");
  window.setTimeout(() => void win.destroy().catch(() => window.close()), 380);
}

const box = document.getElementById("buttons")!;
spec.buttons.forEach((b, i) => {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = b.label;
  if (b.kind) el.className = b.kind;
  el.addEventListener("click", () => void finish(i));
  box.appendChild(el);
});

// 카드 크기에 창을 맞춘 뒤 보여 준다 (그림자 여백 포함).
// 숨겨진 창에서는 requestAnimationFrame이 돌지 않으므로 setTimeout을 쓴다.
window.setTimeout(async () => {
  const h = 94; // 위젯과 같은 크기
  await win.setSize(new LogicalSize(280, h)).catch(() => {});
  await win.show().catch(() => {});
  if (spec.buttons.length) await win.setFocus().catch(() => {});
}, 30);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") void finish(-1);
});
if (spec.autoCloseMs) window.setTimeout(() => void finish(-1), spec.autoCloseMs);
