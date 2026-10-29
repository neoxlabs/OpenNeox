/* ═══════════════════════════════════════════════════════════════════════════
 * 动作层 (b3)
 *
 * 优先级跟 mac 一致: **UIA pattern 优先, SendInput 兜底**。
 * pattern 做的事不抢焦点、不动光标 (Invoke / SetValue / Select / Focus);
 * SendInput 那些必须目标在前台且会动光标 —— 这是 Windows 的输入模型, 见 input.rs 文件头。
 * ═══════════════════════════════════════════════════════════════════════════ */

use crate::input;
use crate::protocol::{fail, ok, Request};
use crate::uia;
use crate::winapp;
use crate::{ms_since, pick_element, resolve_target, El, State, WinApp};
use serde_json::{json, Value};
use windows::Win32::Foundation::RECT;
use windows::Win32::UI::Accessibility::IUIAutomationElement;

fn el_rect(st: &State, el: &El) -> Option<RECT> {
    match el {
        El::Uia(e) => st.uia.as_ref().and_then(|u| u.live_rect(e)),
        El::Jab(h) => st.jab.as_ref().and_then(|j| j.live_rect(*h)),
    }
}

fn el_alive(st: &State, el: &El) -> bool {
    match el {
        El::Uia(e) => st.uia.as_ref().map(|u| u.live_rect(e).is_some()).unwrap_or(false),
        El::Jab(h) => st.jab.as_ref().map(|j| j.is_alive(*h)).unwrap_or(false),
    }
}

fn el_value(st: &State, el: &El) -> Option<String> {
    match el {
        El::Uia(e) => st.uia.as_ref().and_then(|u| u.live_value(e)),
        El::Jab(h) => st.jab.as_ref().and_then(|j| j.read(*h)),
    }
}

/// 等目标元素真的拿到键盘焦点 —— 最多等 ms 毫秒, 期间反复请求聚焦。
///
/// 为什么要"确认"而不是"请求完就当成功": 键盘输入只认当前焦点元素, 而 UIA 的
/// SetFocus 是**请求**不是保证 (窗口没激活、控件不可聚焦、别的进程正抢焦点时都会失败)。
/// 失败了还照发键, 就是静默丢字 —— 回执说成功, 界面没变。
fn wait_keyboard_focus(st: &State, el: &El, ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
    match el {
        El::Uia(e) => loop {
            if unsafe { e.CurrentHasKeyboardFocus() }
                .map(|b| b.as_bool())
                .unwrap_or(false)
            {
                return true;
            }
            let _ = unsafe { e.SetFocus() };
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        },
        El::Jab(h) => {
            let Some(jab) = st.jab.as_ref() else { return false };
            loop {
                if jab.has_focus(*h) {
                    return true;
                }
                let _ = jab.focus(*h);
                if std::time::Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

/// 元素表属主那个应用 (动作类请求不带 app 时用它当目标)。
fn table_app(st: &State) -> Option<WinApp> {
    let table = st.table.as_ref()?;
    let mut app = winapp::find_app(None, Some(table.pid as i32))?;
    let h = windows::Win32::Foundation::HWND(table.hwnd as *mut core::ffi::c_void);
    if !h.0.is_null() && unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(h)).as_bool() } {
        app.hwnd = h;
        app.title = winapp::window_text(h);
    }
    Some(app)
}

/// 把元素表属主的窗口抢到前台, **并把会话交回给调用方** —— 调用方必须把它绑到
/// 一个具名变量上 (`let fg = ensure_front(st);`), 让它活过随后那次输入。
/// 绑成 `let _ =` 会立刻 Drop, 前台归属当场还回去, 输入又丢 (踩过)。
/// 整段 computer_run 占用着时, 守卫不会摘掉脚本级附着。
fn ensure_front(st: &State) -> Option<winapp::FrontGuard> {
    let app = table_app(st)?;
    Some(winapp::FrontGuard::acquire(app.hwnd))
}

fn display_name(row: &uia::Row) -> String {
    if !row.label.is_empty() {
        return row.label.clone();
    }
    match &row.role_desc {
        Some(d) if !d.is_empty() => d.clone(),
        _ => row.role.clone(),
    }
}

/// `op=act` —— press / focus / setValue。
///
/// press 不支持时**必须**回 `unsupported_action`: 上层 (computerRun 的
/// pressOrClick) 正是靠这个 code 决定要不要退回坐标点击。回成泛泛的失败,
/// 点不动的元素就永远点不动了。
pub fn op_act(st: &mut State, req: &Request) -> Value {
    let t0 = std::time::Instant::now();
    let (el, row) = match pick_element(st, req) {
        Ok(x) => x,
        Err(v) => return v,
    };
    if !el_alive(st, el) {
        return fail(
            req.id,
            "stale_handle",
            &format!("编号 {} 的元素已经不在了", req.target.unwrap_or(-1)),
            Some("界面变过之后旧编号会失效: 重新 computer_snapshot 拿新编号"),
        );
    }
    let action = req.action.clone().unwrap_or_default();
    let name = display_name(row);

    match action.as_str() {
        "press" => match el {
            El::Uia(e) => {
                let u = st.uia.as_ref().unwrap();
                let invoked = u.invoke(e);
                let selected = if invoked { false } else { u.select_item(e) };
                let role = row.role.to_ascii_lowercase();
                let buttonish = role.contains("button") || role == "hyperlink";
                /* WPS/资源管理器对话框: Invoke 常回报成功但按钮不动 (另存为、是(Y)).
                 * 按钮一律再点一次真鼠标; 菜单项 Invoke 往往是真的, 不再点以免点穿. */
                if invoked && !buttonish {
                    return ok(req.id, json!({ "ms": ms_since(t0), "via": "invoke" }));
                }
                let rect = el_rect(st, el).or_else(|| {
                    if row.w > 0 && row.h > 0 {
                        Some(windows::Win32::Foundation::RECT {
                            left: row.x,
                            top: row.y,
                            right: row.x + row.w,
                            bottom: row.y + row.h,
                        })
                    } else {
                        None
                    }
                });
                if let Some(r) = rect {
                    let _fg = ensure_front(st);
                    let c = input::center_of(r);
                    emit_pointer(&req.app, "press", &name, Some(c.x), Some(c.y));
                    input::click_at(c.x, c.y, false);
                    let via = if invoked {
                        "invoke+click"
                    } else if selected {
                        "select+click"
                    } else {
                        "click-fallback"
                    };
                    return ok(req.id, json!({ "ms": ms_since(t0), "via": via }));
                }
                if invoked {
                    return ok(req.id, json!({ "ms": ms_since(t0), "via": "invoke" }));
                }
                if selected {
                    return ok(req.id, json!({ "ms": ms_since(t0), "via": "select" }));
                }
                fail(
                    req.id,
                    "unsupported_action",
                    &format!("「{name}」不支持 press / select"),
                    Some("退回坐标点击: 用 click (元素中心), 或 click_at 按比例点"),
                )
            }
            El::Jab(h) => {
                if st.jab.as_ref().map(|j| j.press(*h)).unwrap_or(false) {
                    if let Some(r) = el_rect(st, el) {
                        let c = input::center_of(r);
                        emit_pointer(&req.app, "press", &name, Some(c.x), Some(c.y));
                    }
                    return ok(req.id, json!({ "ms": ms_since(t0), "via": "jab-action" }));
                }
                /* Swing 菜单项经常有 AccessibleAction 但 doAccessibleActions 回报失败,
                 * 设置(T)… 就是这样。live_rect 也可能已经没了, 用 dump 时记下的格子。 */
                let rect = el_rect(st, el).or_else(|| {
                    if row.w > 0 && row.h > 0 {
                        Some(windows::Win32::Foundation::RECT {
                            left: row.x,
                            top: row.y,
                            right: row.x + row.w,
                            bottom: row.y + row.h,
                        })
                    } else {
                        None
                    }
                });
                if let Some(r) = rect {
                    let _fg = ensure_front(st);
                    let c = input::center_of(r);
                    emit_pointer(&req.app, "press", &name, Some(c.x), Some(c.y));
                    input::click_at(c.x, c.y, false);
                    return ok(req.id, json!({ "ms": ms_since(t0), "via": "jab-click-fallback" }));
                }
                fail(
                    req.id,
                    "unsupported_action",
                    &format!("「{name}」JAB 没有 click/press 动作"),
                    Some("退回坐标点击: 用 click (元素中心), 或 click_at 按比例点"),
                )
            }
        },
        "focus" => {
            let ok_focus = match el {
                El::Uia(e) => unsafe { e.SetFocus() }.is_ok(),
                El::Jab(h) => st.jab.as_ref().map(|j| j.focus(*h)).unwrap_or(false),
            };
            if ok_focus {
                ok(req.id, json!({ "ms": ms_since(t0) }))
            } else {
                fail(
                    req.id,
                    "focus_failed",
                    &format!("「{name}」聚焦失败"),
                    Some("有些元素不接受程序聚焦; 可以改用 setValue 直接写值"),
                )
            }
        },
        "setValue" => {
            let text = match req.text.clone() {
                Some(t) => t,
                None => {
                    return fail(
                        req.id,
                        "missing_text",
                        "setValue 需要 text",
                        None,
                    )
                }
            };
            let written = match el {
                El::Uia(e) => st.uia.as_ref().map(|u| u.set_value(e, &text)).unwrap_or(false),
                El::Jab(h) => st.jab.as_ref().map(|j| j.set_value(*h, &text)).unwrap_or(false),
            };
            if written {
                if let Some(r) = el_rect(st, el) {
                    let c = input::center_of(r);
                    emit_pointer(&req.app, "set_value", &name, Some(c.x), Some(c.y));
                }
                let via = match el {
                    El::Uia(_) => "valuePattern",
                    El::Jab(_) => "jab-setText",
                };
                ok(req.id, json!({ "ms": ms_since(t0), "via": via }))
            } else if let Some(r) = el_rect(st, el) {
                /* Chromium 输入框常常没有 ValuePattern, 回失败会让整段脚本卡死.
                 * 点中心再键入, 跟 type 同一条前台占用. */
                let fg = ensure_front(st);
                let c = input::center_of(r);
                emit_pointer(&req.app, "type", &name, Some(c.x), Some(c.y));
                input::click_at(c.x, c.y, false);
                std::thread::sleep(std::time::Duration::from_millis(80));
                let _ = fg.as_ref().map(|f| f.assert_now());
                let (key_events, retries) = input::type_unicode(&text);
                ok(
                    req.id,
                    json!({
                        "ms": ms_since(t0),
                        "via": "type",
                        "keyEvents": key_events,
                        "retries": retries,
                        "fgOk": fg.as_ref().map(|f| f.ok).unwrap_or(false),
                    }),
                )
            } else {
                fail(
                    req.id,
                    "unsupported_action",
                    &format!("「{name}」不支持 setValue"),
                    Some("这个元素不能写值; 先 click 再用 type 模拟键入"),
                )
            }
        }
        other => fail(
            req.id,
            "unknown_action",
            &format!("Windows 桥不认识的 action: {other}"),
            Some("支持: press / focus / setValue"),
        ),
    }
}

/// 把"指针刚落在哪"实时发出去 —— 宿主的叠加层靠它画虚拟光标与涟漪。
///
/// 坐标是**物理屏幕像素**, 而且是在真正点击的那一行算出来的 (不是让宿主自己反推)。
/// 事件没有 `id`, 老宿主会自然忽略 (它们按 id 找 pending), 所以是纯加法。
/// 发失败也不影响动作本身: 叠加层是"给人看"的, 不该因为它拖累真正的操作。
fn emit_pointer(app: &Option<String>, action: &str, label: &str, x: Option<i32>, y: Option<i32>) {
    let mut v = json!({ "phase": "act", "action": action });
    if let Some(a) = app {
        v["app"] = json!(a);
    }
    if !label.is_empty() {
        v["label"] = json!(label);
    }
    if let (Some(x), Some(y)) = (x, y) {
        v["x"] = json!(x);
        v["y"] = json!(y);
    }
    crate::protocol::emit(&crate::protocol::event("pointer", v));
}

/// `op=click` —— 元素中心的坐标点击 (mac 的 AX 动作不支持时的兜底).
pub fn op_click(st: &mut State, req: &Request) -> Value {
    let t0 = std::time::Instant::now();
    let (el, row) = match pick_element(st, req) {
        Ok(x) => x,
        Err(v) => return v,
    };
    let rect = match el_rect(st, el) {
        Some(r) => r,
        None => {
            return fail(
                req.id,
                "stale_handle",
                &format!("编号 {} 的元素已经不在了", req.target.unwrap_or(-1)),
                Some("重新 computer_snapshot 拿新编号"),
            )
        }
    };
    /* 具名绑定: 前台会话要活到这次点击/按键发完 (绑成 `let _ =` 会立刻还回前台) */
    let _fg = ensure_front(st);
    let c = input::center_of(rect);
    emit_pointer(&req.app, "click", &row.label, Some(c.x), Some(c.y));
    input::click_at(c.x, c.y, false);
    ok(
        req.id,
        json!({ "ms": ms_since(t0), "via": "click_at", "x": c.x, "y": c.y, "label": row.label }),
    )
}

/// `op=click_at` / `op=hover` —— 按窗口内**相对比例**落点 (0~1)。
///
/// 自绘界面 (读不到元素) 的兜底: 看截图估个比例就行, 不用报绝对坐标 ——
/// 窗口被拖过之后绝对坐标就是错的, 比例不会。跟 mac 的 opClickAt 同一套语义。
/// hover 只移动光标: 功能区/图库常靠停住才展开, 点下去反而会关上。
pub fn op_click_at(req: &Request) -> Value {
    op_point_at(req, PointKind::Click)
}

pub fn op_hover(req: &Request) -> Value {
    op_point_at(req, PointKind::Hover)
}

pub fn op_double_click(st: &mut State, req: &Request) -> Value {
    if req.target.is_some() {
        let t0 = std::time::Instant::now();
        let (el, row) = match pick_element(st, req) {
            Ok(x) => x,
            Err(v) => return v,
        };
        let rect = match el_rect(st, el) {
            Some(r) => r,
            None => {
                return fail(
                    req.id,
                    "stale_handle",
                    &format!("编号 {} 的元素已经不在了", req.target.unwrap_or(-1)),
                    Some("重新 computer_snapshot 拿新编号"),
                )
            }
        };
        let _fg = ensure_front(st);
        let c = input::center_of(rect);
        emit_pointer(&req.app, "double_click", &row.label, Some(c.x), Some(c.y));
        input::double_click_at(c.x, c.y);
        return ok(
            req.id,
            json!({ "ms": ms_since(t0), "via": "double_click", "x": c.x, "y": c.y, "label": row.label }),
        );
    }
    op_point_at(req, PointKind::Double)
}

pub fn op_drag(req: &Request) -> Value {
    let (dx, dy) = match ratio_pair(req.dx, req.dy) {
        Some(p) => p,
        None => {
            return fail(
                req.id,
                "bad_ratio",
                "drag 需要 dx / dy 作为起点 (窗口内 0~1)",
                Some("左上角是 0,0; 右下角是 1,1。终点用 dx2 / dy2。"),
            )
        }
    };
    let (dx2, dy2) = match ratio_pair(req.dx2, req.dy2) {
        Some(p) => p,
        None => {
            return fail(
                req.id,
                "bad_ratio",
                "drag 需要 dx2 / dy2 作为终点 (窗口内 0~1)",
                Some("从 (dx,dy) 拖到 (dx2,dy2)。"),
            )
        }
    };
    let target = match resolve_target(req) {
        Ok(t) => winapp::with_dialog(t),
        Err(v) => return v,
    };
    if target.hwnd.0.is_null() {
        return fail(
            req.id,
            "no_window_geometry",
            &format!("{} 读不出窗口位置, 没法换算坐标", target.name),
            None,
        );
    }
    let fg = winapp::FrontGuard::acquire(target.hwnd);
    let r = winapp::window_rect(target.hwnd);
    let x1 = r.left + ((r.right - r.left) as f64 * dx) as i32;
    let y1 = r.top + ((r.bottom - r.top) as f64 * dy) as i32;
    let x2 = r.left + ((r.right - r.left) as f64 * dx2) as i32;
    let y2 = r.top + ((r.bottom - r.top) as f64 * dy2) as i32;
    if !winapp::point_reaches_window(target.hwnd, x1, y1) {
        winapp::raise_window(target.hwnd);
        std::thread::sleep(std::time::Duration::from_millis(80));
        let _ = fg.assert_now();
    }
    if let Some(cover) = winapp::covering_title(target.hwnd, x1, y1) {
        return fail(
            req.id,
            "window_covered",
            &format!("「{}」被「{cover}」挡住, 拖不到", target.title),
            Some("先把挡住的窗口最小化或挪开, 再 snapshot 确认当前是目标窗"),
        );
    }
    emit_pointer(
        &req.app,
        "drag",
        &format!("{:.0}%/{:.0}% → {:.0}%/{:.0}%", dx * 100.0, dy * 100.0, dx2 * 100.0, dy2 * 100.0),
        Some(x2),
        Some(y2),
    );
    input::drag_to(x1, y1, x2, y2);
    ok(req.id, json!({ "x": x1, "y": y1, "x2": x2, "y2": y2, "via": "drag", "fgOk": fg.ok }))
}

enum PointKind {
    Click,
    Hover,
    Double,
    Scroll,
    Menu,
}

fn ratio_pair(a: Option<f64>, b: Option<f64>) -> Option<(f64, f64)> {
    match (a, b) {
        (Some(x), Some(y)) if (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y) => Some((x, y)),
        _ => None,
    }
}

struct RatioHit {
    x: i32,
    y: i32,
    dx: f64,
    dy: f64,
    fg: winapp::FrontGuard,
}

fn ratio_hit(req: &Request, op: &str) -> Result<RatioHit, Value> {
    let (dx, dy) = match ratio_pair(req.dx, req.dy) {
        Some(p) => p,
        None => {
            return Err(fail(
                req.id,
                "bad_ratio",
                &format!("{op} 需要 dx / dy 作为窗口内的相对位置 (0~1)"),
                Some("左上角是 0,0; 右下角是 1,1。看截图估个比例就行, 别报绝对坐标。"),
            ))
        }
    };
    let target = match resolve_target(req) {
        Ok(t) => winapp::with_dialog(t),
        Err(v) => return Err(v),
    };
    if target.hwnd.0.is_null() {
        return Err(fail(
            req.id,
            "no_window_geometry",
            &format!("{} 读不出窗口位置, 没法换算坐标", target.name),
            None,
        ));
    }
    /* 脚本占用期间 FrontGuard 复用附着, 不会一步一 Drop 把 WPS 主页放回来. */
    let fg = winapp::FrontGuard::acquire(target.hwnd);
    let r = winapp::window_rect(target.hwnd);
    let x = r.left + ((r.right - r.left) as f64 * dx) as i32;
    let y = r.top + ((r.bottom - r.top) as f64 * dy) as i32;
    if !winapp::point_reaches_window(target.hwnd, x, y) {
        winapp::raise_window(target.hwnd);
        std::thread::sleep(std::time::Duration::from_millis(80));
        let _ = fg.assert_now();
    }
    if let Some(cover) = winapp::covering_title(target.hwnd, x, y) {
        return Err(fail(
            req.id,
            "window_covered",
            &format!("「{}」被「{cover}」挡住, 点不到", target.title),
            Some("先把挡住的窗口最小化或挪开, 再 snapshot 确认当前是目标窗"),
        ));
    }
    Ok(RatioHit { x, y, dx, dy, fg })
}

fn op_point_at(req: &Request, kind: PointKind) -> Value {
    let op = match kind {
        PointKind::Click => "click_at",
        PointKind::Hover => "hover",
        PointKind::Double => "double_click",
        PointKind::Scroll => "scroll",
        PointKind::Menu => "show_menu",
    };
    let hit = match ratio_hit(req, op) {
        Ok(h) => h,
        Err(v) => return v,
    };
    let RatioHit { x, y, dx, dy, fg } = hit;
    emit_pointer(&req.app, op, &format!("{:.0}% / {:.0}%", dx * 100.0, dy * 100.0), Some(x), Some(y));
    let via = match kind {
        PointKind::Click => {
            input::click_at(x, y, false);
            "ratio"
        }
        PointKind::Hover => {
            input::hover_at(x, y);
            "hover"
        }
        PointKind::Double => {
            input::double_click_at(x, y);
            "double"
        }
        PointKind::Scroll => {
            /* 3 格; 要滚更远就连发几步. dy 在 0~1 时是落点不是滚动量. */
            input::scroll_at(x, y, -3.0);
            "scroll"
        }
        PointKind::Menu => {
            input::click_at(x, y, true);
            "rightclick"
        }
    };
    ok(req.id, json!({ "x": x, "y": y, "via": via, "fgOk": fg.ok }))
}

/// `op=type` —— 真键入 (会走键盘事件, 能触发快捷键/自动补全)。
///
/// 要往输入框里塞文字**优先用 setValue**: 快一个量级, 而且不抢前台。
pub fn op_type(st: &mut State, req: &Request) -> Value {
    let text = match req.text.clone() {
        Some(t) => t,
        None => return fail(req.id, "missing_text", "type 需要 text", None),
    };
    let t0 = std::time::Instant::now();
    /* 自绘输入框没有元素编号: 先按截图比例点下去拿焦点, 同一段前台会话里立刻打字.
     * 拆成 click_at + type 两步会在两步之间 Drop ForegroundSession, 字落到别的窗. */
    if req.target.is_none() && ratio_pair(req.dx, req.dy).is_some() {
        let hit = match ratio_hit(req, "type") {
            Ok(h) => h,
            Err(v) => return v,
        };
        emit_pointer(
            &req.app,
            "type",
            &format!("{:.0}% / {:.0}%", hit.dx * 100.0, hit.dy * 100.0),
            Some(hit.x),
            Some(hit.y),
        );
        input::click_at(hit.x, hit.y, false);
        std::thread::sleep(std::time::Duration::from_millis(80));
        let chars = text.chars().count();
        let fg_before = hit.fg.assert_now();
        let (key_events, retries) = input::type_unicode(&text);
        return ok(
            req.id,
            json!({
                "ms": ms_since(t0),
                "chars": chars,
                "keyEvents": key_events,
                "retries": retries,
                "x": hit.x,
                "y": hit.y,
                "via": "ratio",
                "fgOk": hit.fg.ok,
                "fgBeforeSend": fg_before,
            }),
        );
    }
    /* fg 是前台会话 —— 必须活到这一串输入发完为止 (见 ensure_front) */
    let fg = ensure_front(st);
    let fg_ok = fg.as_ref().map(|f| f.ok).unwrap_or(false);
    /* 前台切换是**异步**的 (WM_ACTIVATE 是投递的): GetForegroundWindow 立刻返回新窗口,
     * 但它真正开始收键盘还在几十毫秒之后。这一步不多等, 前几个字符就丢了。 */
    std::thread::sleep(std::time::Duration::from_millis(220));
    /* 有 target 就先聚焦到那个元素上再打字 —— 否则字会落到"当前焦点"上, 那是个猜。
     * 而且**要确认真的拿到焦点**, 不然键入静默丢字, 回执却在说成功。 */
    if req.target.is_some() {
        if let Ok((el, row)) = pick_element(st, req) {
            if !wait_keyboard_focus(st, el, 800) {
                return fail(
                    req.id,
                    "focus_not_taken",
                    &format!("「{}」拿不到键盘焦点, 这时候键入会丢字", display_name(row)),
                    Some("先 click 这个元素把焦点放上去, 或者改用 setValue 直接写值 (更快也不抢前台)"),
                );
            }
            /* 叠加层要画"字正往哪儿打" —— 有 target 就把它的位置一起发出去 */
            if let Some(r) = el_rect(st, el) {
                let c = input::center_of(r);
                emit_pointer(&req.app, "type", &row.label, Some(c.x), Some(c.y));
            }
        }
    }
    let chars = text.chars().count();
    /* 发之前**再确认一次**前台还在自己手上: 抢来之后那几十毫秒里它可能被还回去
     * (实测过), 那时键就发到别处 —— 回执还真说成功。 */
    let fg_before = fg.as_ref().map(|f| f.assert_now()).unwrap_or(false);
    let (key_events, retries) = input::type_unicode(&text);

    /* 等文字**真的落进界面**再回执。
     *
     * 注入的输入是异步的: 事件进了目标的输入队列, 应用要过几十到几百毫秒才处理完。
     * 立刻去读会看到"只进去前几个字"的假象 —— 实测 9 个字只看到 3 个, 而其余 6 个
     * 其实就在队列里, 之后自己进去了 (所以每次跑冒烟, 界面上的字都会再往前长一点)。
     * 不认这件事的话, 回执和界面就会各说各的, 上层的变化断言也跟着判错。 */
    let settled = settle_typed(st, req, &text);
    ok(
        req.id,
        json!({
            "ms": ms_since(t0),
            "chars": chars,
            /* 真正插进输入队列的键盘事件数 (每个字符 2 个事件)。少于 chars*2
             * 说明有批次被系统挡了 —— 重发过 retries 次。回执里带出来,
             * 便于分辨"没发出去"和"发出去了但界面没收"。 */
            "keyEvents": key_events,
            "retries": retries,
            "settled": settled,
            "fgOk": fg_ok,
            "fgBeforeSend": fg_before,
        }),
    )
}

/// 等键入的文字出现在目标元素的值里 (最多 ~1s)。
/// 元素没有 ValuePattern (读不出值) 时退化成固定等待 —— 这种情况只能是"尽力", 如实标 null。
fn settle_typed(st: &State, req: &Request, text: &str) -> Option<bool> {
    let el_copy = match req.target {
        Some(_) => match pick_element(st, req) {
            Ok((El::Uia(el), _)) => Some(SettleEl::Uia(el.clone())),
            Ok((El::Jab(h), _)) => Some(SettleEl::Jab(*h)),
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_millis(150));
                return None;
            }
        },
        None => {
            std::thread::sleep(std::time::Duration::from_millis(150));
            return None;
        }
    };
    let Some(el_copy) = el_copy else { return None };
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1000);
    loop {
        let live = match &el_copy {
            SettleEl::Uia(el) => st.uia.as_ref().and_then(|u| u.live_value(el)),
            SettleEl::Jab(h) => st.jab.as_ref().and_then(|j| j.read(*h)),
        };
        match live {
            Some(v) if v.contains(text) => return Some(true),
            None => return None,
            Some(_) => {}
        }
        if std::time::Instant::now() >= deadline {
            return Some(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

enum SettleEl {
    Uia(IUIAutomationElement),
    Jab(crate::jab::Handle),
}

/// `op=key` —— 单个按键 + 修饰键。
pub fn op_key(st: &mut State, req: &Request) -> Value {
    let key = match req.key.clone() {
        Some(k) => k,
        None => return fail(req.id, "missing_key", "key 操作需要 key", None),
    };
    let extra = req.modifiers.clone().unwrap_or_default();
    let (vk, mods, needs_shift) = match input::parse_key_spec(&key, &extra) {
        Some(v) => v,
        None => {
            return fail(
                req.id,
                "unknown_key",
                &format!("不认识的按键: {key}"),
                Some("支持: return/enter, tab, escape, insert, space, backspace, delete, up/down/left/right, home, end, pageup/pagedown, f1~f24, 单个字符, 或写在 key 里的和弦 (alt+insert / ctrl+alt+shift+s)"),
            )
        }
    };
    let t0 = std::time::Instant::now();
    /* 具名绑定: 前台会话要活到这次点击/按键发完 (绑成 `let _ =` 会立刻还回前台) */
    let _fg = ensure_front(st);
    emit_pointer(
        &req.app,
        "key",
        &if key.contains('+') || mods.is_empty() {
            key.clone()
        } else {
            format!("{}+{key}", mods.join("+"))
        },
        None,
        None,
    );
    if !input::press_key(vk, &mods, needs_shift) {
        return fail(
            req.id,
            "unknown_modifier",
            "不认识的修饰键",
            Some("支持: ctrl / alt / shift / cmd(win)"),
        );
    }
    ok(req.id, json!({ "ms": ms_since(t0) }))
}

/// `op=read` —— 读元素的值 (输入框内容 / 文本)。
pub fn op_read(st: &mut State, req: &Request) -> Value {
    let (el, row) = match pick_element(st, req) {
        Ok(x) => x,
        Err(v) => return v,
    };
    let live = el_value(st, el).filter(|s| !s.is_empty());
    let value = live
        .or_else(|| row.value.clone().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| row.label.clone());
    ok(req.id, json!({ "value": value }))
}

/// `op=scroll` —— 滚轮。dy 负数是往下滚 (跟 mac 一致)。
/// dx/dy 都在 0~1 时按窗口比例落点 (跟 click_at 一样), 自绘画布才能滚到内容区。
pub fn op_scroll(st: &mut State, req: &Request) -> Value {
    if req.target.is_none() && ratio_pair(req.dx, req.dy).is_some() {
        return op_point_at(req, PointKind::Scroll);
    }
    let point = if req.target.is_some() {
        pick_element(st, req)
            .ok()
            .and_then(|(el, _)| el_rect(st, el))
            .map(input::center_of)
    } else {
        None
    };
    let point = match point {
        Some(p) => p,
        None => match table_app(st) {
            Some(a) if !a.hwnd.0.is_null() => input::center_of(winapp::window_rect(a.hwnd)),
            _ => return fail(req.id, "no_table", "没有目标窗口可以滚动", Some("先 computer_snapshot 一次")),
        },
    };
    /* 具名绑定: 前台会话要活到这次点击/按键发完 (绑成 `let _ =` 会立刻还回前台) */
    let _fg = ensure_front(st);
    input::scroll_at(point.x, point.y, req.dy.unwrap_or(-300.0));
    ok(req.id, json!({ "x": point.x, "y": point.y }))
}

/// `op=show_menu` —— 上下文菜单。Windows 没有 AXShowMenu 的对应物, 走真右键,
/// 回执里 via 说明走了哪条 (跟 mac 的 via 字段同一个用途)。
/// dx/dy 都在 0~1 时按窗口比例落点, 自绘画布也能出右键菜单。
pub fn op_show_menu(st: &mut State, req: &Request) -> Value {
    if req.target.is_none() && ratio_pair(req.dx, req.dy).is_some() {
        return op_point_at(req, PointKind::Menu);
    }
    let (el, _row) = match pick_element(st, req) {
        Ok(x) => x,
        Err(v) => return v,
    };
    let rect = match el_rect(st, el) {
        Some(r) => r,
        None => return fail(req.id, "stale_handle", "元素已经不在了", None),
    };
    /* 具名绑定: 前台会话要活到这次点击/按键发完 (绑成 `let _ =` 会立刻还回前台) */
    let _fg = ensure_front(st);
    let c = input::center_of(rect);
    input::click_at(c.x, c.y, true);
    ok(req.id, json!({ "via": "rightclick", "x": c.x, "y": c.y }))
}
