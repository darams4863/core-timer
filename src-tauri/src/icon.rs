//! 트레이/메뉴 막대용 자물쇠 아이콘을 코드로 그린다.
//! - 락인 중: 자물쇠가 잠기고, 몸통이 아래부터 진행률만큼 차오른다.
//! - 락인 아닐 때: 고리가 열린 자물쇠.

pub const SIZE: u32 = 32;
const SS: u32 = 4; // 안티앨리어싱용 서브샘플

#[derive(Clone, Copy)]
struct Rgba(u8, u8, u8, u8);

fn palette(kind: &str) -> (Rgba, Rgba, bool) {
    // (채움색, 고리·테두리색, 잠김 여부)
    match kind {
        "am" => (Rgba(109, 124, 255, 255), Rgba(124, 196, 255, 255), true),
        "pm" => (Rgba(139, 109, 255, 255), Rgba(196, 167, 255, 255), true),
        "warn" => (Rgba(245, 158, 11, 255), Rgba(245, 158, 11, 255), false),
        "done" => (Rgba(255, 143, 191, 255), Rgba(255, 197, 158, 255), false),
        _ => (Rgba(150, 162, 200, 255), Rgba(150, 162, 200, 255), false),
    }
}

fn in_round_rect(x: f32, y: f32, x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> bool {
    if x < x0 || x > x1 || y < y0 || y > y1 {
        return false;
    }
    let cx = x.clamp(x0 + r, x1 - r);
    let cy = y.clamp(y0 + r, y1 - r);
    (x - cx).powi(2) + (y - cy).powi(2) <= r * r
}

/// 고리(ㄷ자를 뒤집은 모양). open이면 위로 들리고 왼쪽 다리가 빠진다.
fn in_shackle(x: f32, y: f32, open: bool) -> bool {
    let lift = if open { 5.0 } else { 0.0 };
    let cx = 16.0;
    let cy = 12.0 - lift;
    let (ro, ri) = (7.2, 4.0);
    // 위쪽 반원
    if y <= cy {
        let d2 = (x - cx).powi(2) + (y - cy).powi(2);
        return d2 <= ro * ro && d2 >= ri * ri;
    }
    // 다리
    let legs_bottom = 15.5;
    if y > legs_bottom {
        return false;
    }
    let left = x >= cx - ro && x <= cx - ri;
    let right = x >= cx + ri && x <= cx + ro;
    if open {
        right || (left && y <= cy + 2.0)
    } else {
        left || right
    }
}

pub fn render(kind: &str, progress: f64) -> Vec<u8> {
    let (fill, line, locked) = palette(kind);
    let open = !locked;
    let p = progress.clamp(0.0, 1.0) as f32;
    let (bx0, by0, bx1, by1, br) = (6.0, 14.0, 26.0, 30.0, 3.5);
    let level = by1 - (by1 - by0) * if locked || kind == "done" { p } else { 0.0 };

    let mut buf = vec![0u8; (SIZE * SIZE * 4) as usize];
    for py in 0..SIZE {
        for px in 0..SIZE {
            let (mut r, mut g, mut b, mut a) = (0f32, 0f32, 0f32, 0f32);
            for sy in 0..SS {
                for sx in 0..SS {
                    let x = px as f32 + (sx as f32 + 0.5) / SS as f32;
                    let y = py as f32 + (sy as f32 + 0.5) / SS as f32;
                    let c: Option<Rgba> = if in_round_rect(x, y, bx0, by0, bx1, by1, br) {
                        let inner = in_round_rect(x, y, bx0 + 1.6, by0 + 1.6, bx1 - 1.6, by1 - 1.6, br - 1.4);
                        // 열쇠 구멍
                        let key = (x - 16.0).powi(2) + (y - 20.5).powi(2) <= 2.1f32.powi(2)
                            || (x >= 15.2 && x <= 16.8 && y >= 20.5 && y <= 25.0);
                        if !inner {
                            Some(line)
                        } else if key {
                            Some(Rgba(30, 40, 52, 255))
                        } else if y >= level {
                            Some(fill)
                        } else {
                            Some(Rgba(235, 240, 255, 150))
                        }
                    } else if in_shackle(x, y, open) {
                        Some(line)
                    } else {
                        None
                    };
                    if let Some(Rgba(cr, cg, cb, ca)) = c {
                        let af = ca as f32 / 255.0;
                        r += cr as f32 * af;
                        g += cg as f32 * af;
                        b += cb as f32 * af;
                        a += af;
                    }
                }
            }
            let n = (SS * SS) as f32;
            let i = ((py * SIZE + px) * 4) as usize;
            if a > 0.0 {
                buf[i] = (r / a).round() as u8;
                buf[i + 1] = (g / a).round() as u8;
                buf[i + 2] = (b / a).round() as u8;
                buf[i + 3] = ((a / n) * 255.0).round() as u8;
            }
        }
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_expected_size() {
        for kind in ["am", "pm", "warn", "done", "idle"] {
            assert_eq!(render(kind, 0.5).len(), (SIZE * SIZE * 4) as usize);
        }
    }

    #[test]
    fn locked_and_open_differ() {
        assert_ne!(render("am", 0.5), render("idle", 0.5));
        assert_ne!(render("am", 0.1), render("am", 0.9));
    }
}

// ── Windows 트레이용: 남은 시간을 아이콘 안에 숫자로 ────────────────
// Windows 작업 표시줄 트레이는 아이콘 옆에 글자를 붙일 수 없어서 아이콘 자체에 그린다.

const FONT: [(char, [u8; 5]); 11] = [
    ('0', [0b111, 0b101, 0b101, 0b101, 0b111]),
    ('1', [0b010, 0b110, 0b010, 0b010, 0b111]),
    ('2', [0b111, 0b001, 0b111, 0b100, 0b111]),
    ('3', [0b111, 0b001, 0b111, 0b001, 0b111]),
    ('4', [0b101, 0b101, 0b111, 0b001, 0b001]),
    ('5', [0b111, 0b100, 0b111, 0b001, 0b111]),
    ('6', [0b111, 0b100, 0b111, 0b101, 0b111]),
    ('7', [0b111, 0b001, 0b010, 0b010, 0b010]),
    ('8', [0b111, 0b101, 0b111, 0b101, 0b111]),
    ('9', [0b111, 0b101, 0b111, 0b001, 0b111]),
    ('h', [0b100, 0b100, 0b111, 0b101, 0b101]),
];

pub fn render_text(kind: &str, text: &str) -> Vec<u8> {
    let (fill, _, _) = palette(kind);
    let glyphs: Vec<[u8; 5]> = text
        .chars()
        .take(2)
        .filter_map(|c| FONT.iter().find(|(k, _)| *k == c).map(|(_, g)| *g))
        .collect();
    let scale = 4u32;
    let gap = 2u32;
    let n = glyphs.len() as u32;
    let text_w = if n == 0 { 0 } else { n * 3 * scale + (n - 1) * gap };
    let x0 = (SIZE.saturating_sub(text_w)) / 2;
    let y0 = (SIZE - 5 * scale) / 2;

    let mut buf = vec![0u8; (SIZE * SIZE * 4) as usize];
    for py in 0..SIZE {
        for px in 0..SIZE {
            let i = ((py * SIZE + px) * 4) as usize;
            // 둥근 사각 배경 (안티앨리어싱)
            let mut cover = 0f32;
            for sy in 0..SS {
                for sx in 0..SS {
                    let x = px as f32 + (sx as f32 + 0.5) / SS as f32;
                    let y = py as f32 + (sy as f32 + 0.5) / SS as f32;
                    if in_round_rect(x, y, 0.5, 0.5, SIZE as f32 - 0.5, SIZE as f32 - 0.5, 7.0) {
                        cover += 1.0;
                    }
                }
            }
            let a = cover / (SS * SS) as f32;
            if a <= 0.0 {
                continue;
            }
            let mut c = fill;
            // 글자 픽셀이면 흰색
            if px >= x0 && py >= y0 && py < y0 + 5 * scale {
                let rel = px - x0;
                let cell = 3 * scale + gap;
                let gi = (rel / cell) as usize;
                let cx = rel % cell;
                if gi < glyphs.len() && cx < 3 * scale {
                    let col = cx / scale;
                    let row = ((py - y0) / scale) as usize;
                    if glyphs[gi][row] & (0b100 >> col) != 0 {
                        c = Rgba(255, 255, 255, 255);
                    }
                }
            }
            buf[i] = c.0;
            buf[i + 1] = c.1;
            buf[i + 2] = c.2;
            buf[i + 3] = (a * 255.0).round() as u8;
        }
    }
    buf
}

#[cfg(test)]
mod text_tests {
    use super::*;
    #[test]
    fn draws_digits() {
        let a = render_text("am", "49");
        let b = render_text("am", "12");
        assert_eq!(a.len(), (SIZE * SIZE * 4) as usize);
        assert_ne!(a, b);
    }
}
