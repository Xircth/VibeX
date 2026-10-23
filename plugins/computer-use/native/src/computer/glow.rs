//! Soft rounded aura around each shared window.
//!
//! The accent is `#8ecbff`, a lighter blue than the earlier `#339cff`. The aura
//! is a product drawing: light grows outward from a rounded rectangle that
//! wraps the window. Tongues of that light travel around the edge at unrelated
//! speeds, like a ring of flame, instead of the whole ring brightening
//! together. The pattern uses whole-number laps so it meets itself on the
//! left, where the angle wraps. It is not a stroke sitting on the frame.
//! Distances are logical pixels, scaled to the window's monitor so the wrap
//! stays the same size on a 175% display as on a 100% one. The whole aura is
//! the accent blue; the bright ridge does not shift toward white.
//!
//! The overlay is a click-through layered window. It is not topmost. It sits
//! immediately under its window, so the window covers the rounded light that
//! would otherwise paint across the corners. Anything covering that window
//! covers the aura too. Pixels whose nearest point on the window lies inside
//! a covering window are left clear, which keeps the haze from outlining the
//! window that covered it.
//!
//! A drag repositions the existing bitmap from `GetWindowRect` before any
//! hit-testing. The thread also wakes on location-change events. The shader
//! runs when the window is still.

#[cfg(windows)]
mod platform {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use std::time::Instant;

    use tokio::sync::watch;
    use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Dwm::DwmGetWindowAttribute;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC,
        ReleaseDC, SelectObject, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, HMONITOR,
    };
    use windows_sys::Win32::UI::HiDpi::{
        GetAwarenessFromDpiAwarenessContext, GetDpiForSystem, GetDpiForWindow,
        GetThreadDpiAwarenessContext, SetThreadDpiAwarenessContext, DPI_AWARENESS_UNAWARE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetAncestor,
        GetClassNameW, GetWindow, GetWindowLongPtrW, GetWindowRect, IsIconic, IsWindow,
        IsWindowVisible, PeekMessageW, RegisterClassW, SetWindowDisplayAffinity, SetWindowPos,
        ShowWindow, TranslateMessage, UpdateLayeredWindow, WindowFromPoint, CS_HREDRAW, CS_VREDRAW,
        GA_ROOT, GWL_EXSTYLE, GW_HWNDNEXT, GW_HWNDPREV, HWND_NOTOPMOST, HWND_TOPMOST, MSG,
        PM_REMOVE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE,
        SW_SHOWNOACTIVATE, ULW_ALPHA, WDA_EXCLUDEFROMCAPTURE, WNDCLASSW, WS_EX_LAYERED,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
    };

    use super::{should_clear_topmost, tracked_origin, visibility_samples, window_moved, RectI};

    const EVENT_OBJECT_LOCATIONCHANGE: u32 = 0x800B;
    const WINEVENT_SKIPOWNPROCESS: u32 = 0x0002;
    const QS_ALLINPUT: u32 = 0x04FF;

    #[link(name = "user32")]
    extern "system" {
        fn SetWinEventHook(
            event_min: u32,
            event_max: u32,
            module: *mut c_void,
            proc: Option<unsafe extern "system" fn(*mut c_void, u32, HWND, i32, i32, u32, u32)>,
            process: u32,
            thread: u32,
            flags: u32,
        ) -> *mut c_void;
        fn UnhookWinEvent(hook: *mut c_void) -> i32;
        fn MsgWaitForMultipleObjects(
            count: u32,
            handles: *const isize,
            wait_all: i32,
            millis: u32,
            wake_mask: u32,
        ) -> u32;
    }

    static LOCATION_CHANGED: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn on_location(
        _hook: *mut c_void,
        _event: u32,
        _hwnd: HWND,
        _object: i32,
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
        // The hook can run on this thread while it pumps, and must not touch
        // a window. A drag reads the flag after the pump and slides then.
        LOCATION_CHANGED.store(true, Ordering::Relaxed);
    }

    const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
    const DWMWA_CLOAKED: u32 = 14;
    const CLASS_NAME: &str = "VibexComputerGlow";

    #[derive(Clone)]
    pub struct GlowState {
        pub enabled: bool,
        pub windows: Vec<u64>,
        pub screen: bool,
    }

    pub struct WindowGlow {
        tx: watch::Sender<GlowState>,
    }

    struct Overlay {
        hwnd: HWND,
        mem_dc: HDC,
        dib: HBITMAP,
        previous: HGDIOBJ,
        bits: *mut u8,
        width: i32,
        height: i32,
        /// Visible frame the current bitmap was settled at.
        frame_x: i32,
        frame_y: i32,
        /// `GetWindowRect` origin at that settle. A drag's delta is measured
        /// from here and the baseline is not moved until the drag stops, so
        /// the offset stays absolute.
        win_x: i32,
        win_y: i32,
        /// `GetWindowRect` origin at the last full sample. A change past a
        /// couple of pixels is a drag, and the shader waits.
        seen_x: i32,
        seen_y: i32,
        /// `GetWindowRect` origin at the last cheap sample. This is how a
        /// drag is told apart from the moment it stops.
        sample_x: i32,
        sample_y: i32,
        sampled: bool,
        /// Bitmap pad used for the settled frame.
        pad: i32,
        /// Last `UpdateLayeredWindow` origin. A repeated sample skips the call.
        shown_x: i32,
        shown_y: i32,
        /// Shadow between the window rect and the visible frame. Reused when
        /// the compositor frame lags a drag.
        anchor: Option<ShadowInset>,
        /// A bitmap has been presented at least once.
        live: bool,
        visible: bool,
    }

    #[derive(Clone, Copy)]
    struct ShadowInset {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    struct Frame {
        key: u64,
        /// Target window. `0` is a monitor frame with nothing to follow.
        target: u64,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        /// False when the window is fully covered. The overlay stays alive
        /// and is hidden, so a brief cover does not recreate the window.
        shown: bool,
        anchor: Option<ShadowInset>,
    }

    impl WindowGlow {
        pub fn start() -> Self {
            let (tx, rx) = watch::channel(GlowState {
                enabled: false,
                windows: Vec::new(),
                screen: false,
            });
            std::thread::Builder::new()
                .name("computer-glow".to_owned())
                .spawn(move || run(rx))
                .ok();
            Self { tx }
        }

        pub fn sync(&self, enabled: bool, windows: &[u64], screen: bool) {
            let _ = self.tx.send(GlowState {
                enabled,
                windows: windows.to_vec(),
                screen,
            });
        }
    }

    fn run(mut rx: watch::Receiver<GlowState>) {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, so the aura uses the
        // same physical pixels as DWM extended frame bounds. Thread-only.
        unsafe {
            SetThreadDpiAwarenessContext(-4isize as *mut std::ffi::c_void);
        }
        let _class = register_class();
        let hook = install_location_hook();
        let mut overlays: HashMap<u64, Overlay> = HashMap::new();
        let started = Instant::now();
        let mut next_paint = Instant::now();
        let mut next_heavy = Instant::now();
        let mut last_motion: Option<Instant> = None;
        loop {
            if rx.has_changed().is_err() {
                break;
            }
            let state = rx.borrow_and_update().clone();
            pump();
            LOCATION_CHANGED.swap(false, Ordering::Relaxed);
            let (tracking, moved) = if !state.enabled {
                overlays.clear();
                (false, false)
            } else {
                // Slide from the window rect before hit-testing. A fast drag
                // used to wait on the occlusion samples below.
                let moved = fast_track(&mut overlays, &state.windows);
                let now = Instant::now();
                if moved {
                    last_motion = Some(now);
                }
                // Hit-testing waits until the drag has been still for a
                // moment. Running it between steps was what left the aura
                // a step behind.
                let dragging = last_motion
                    .map(|at| now.duration_since(at) < std::time::Duration::from_millis(48))
                    .unwrap_or(false);
                if !dragging && now >= next_heavy {
                    next_heavy = now + std::time::Duration::from_millis(100);
                    let frames = frames_of(&state, &overlays);
                    let live: std::collections::HashSet<u64> =
                        frames.iter().map(|frame| frame.key).collect();
                    overlays.retain(|key, _| live.contains(key));
                    let elapsed = started.elapsed().as_millis() as u64;
                    let paint_due = now >= next_paint;
                    if paint_due {
                        next_paint = now + std::time::Duration::from_millis(100);
                    }
                    for frame in &frames {
                        if !overlays.contains_key(&frame.key) {
                            let Some(created) = Overlay::create() else {
                                continue;
                            };
                            overlays.insert(frame.key, created);
                        }
                        if let Some(overlay) = overlays.get_mut(&frame.key) {
                            if frame.shown {
                                overlay.follow(frame, elapsed, paint_due);
                            } else {
                                overlay.hide();
                                overlay.note_hidden(frame);
                            }
                        }
                    }
                }
                (!overlays.is_empty(), moved)
            };
            // Location events wake the wait. The short timeout still polls
            // `GetWindowRect` when a move is coalesced. Idle waits stay slow.
            let wait = if !tracking {
                if state.enabled {
                    100
                } else {
                    200
                }
            } else if moved {
                1
            } else {
                4
            };
            wait_for_motion(wait);
        }
        if !hook.is_null() {
            unsafe {
                UnhookWinEvent(hook);
            }
        }
        overlays.clear();
    }

    fn install_location_hook() -> *mut c_void {
        unsafe {
            SetWinEventHook(
                EVENT_OBJECT_LOCATIONCHANGE,
                EVENT_OBJECT_LOCATIONCHANGE,
                ptr::null_mut(),
                Some(on_location),
                0,
                0,
                WINEVENT_SKIPOWNPROCESS,
            )
        }
    }

    fn wait_for_motion(timeout_ms: u32) {
        let started = Instant::now();
        unsafe {
            MsgWaitForMultipleObjects(0, ptr::null(), 0, timeout_ms, QS_ALLINPUT);
        }
        // A burst of location events would otherwise spin this thread.
        let floor = std::time::Duration::from_millis(1);
        let elapsed = started.elapsed();
        if elapsed < floor {
            std::thread::sleep(floor - elapsed);
        }
    }

    /// Reposition every live aura from the window rect alone.
    fn fast_track(overlays: &mut HashMap<u64, Overlay>, windows: &[u64]) -> bool {
        let mut moved = false;
        for id in windows {
            let Some(overlay) = overlays.get_mut(id) else {
                continue;
            };
            let hwnd = *id as usize as HWND;
            if unsafe { IsWindow(hwnd) } == 0 {
                continue;
            }
            if overlay.nudge(hwnd) {
                moved = true;
            }
        }
        moved
    }

    fn frames_of(state: &GlowState, overlays: &HashMap<u64, Overlay>) -> Vec<Frame> {
        let mut frames = Vec::new();
        for id in &state.windows {
            let hwnd = *id as usize as HWND;
            if unsafe { IsWindow(hwnd) } == 0 {
                continue;
            }
            if our_overlay(hwnd) {
                continue;
            }
            if unsafe { IsWindowVisible(hwnd) } == 0
                || unsafe { IsIconic(hwnd) } != 0
                || cloaked(hwnd)
            {
                continue;
            }
            let cached = overlays.get(id).and_then(|item| item.anchor);
            if let Some((x, y, width, height, anchor)) = anchored_frame(hwnd, cached) {
                let overlay = overlays
                    .get(id)
                    .map(|item| item.hwnd)
                    .unwrap_or(ptr::null_mut());
                let shown = window_has_visible_point(hwnd, overlay, x, y, width, height);
                frames.push(Frame {
                    key: *id,
                    target: *id,
                    x,
                    y,
                    width,
                    height,
                    shown,
                    anchor,
                });
            }
        }
        if frames.is_empty() && state.screen {
            for (index, rect) in monitor_rects().into_iter().enumerate() {
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                if width > 0 && height > 0 {
                    frames.push(Frame {
                        key: u64::MAX - index as u64,
                        target: 0,
                        x: rect.left,
                        y: rect.top,
                        width,
                        height,
                        shown: true,
                        anchor: None,
                    });
                }
            }
        }
        frames
    }

    /// Visible frame, following `GetWindowRect` when the compositor frame is
    /// still at the previous drag position. The inset of a settled pair is
    /// the shadow, and it stays valid for the next samples.
    fn anchored_frame(
        hwnd: HWND,
        cached: Option<ShadowInset>,
    ) -> Option<(i32, i32, i32, i32, Option<ShadowInset>)> {
        let win = window_rect(hwnd)?;
        let Some(dwm) = dwm_frame(hwnd) else {
            return Some((win.0, win.1, win.2, win.3, cached));
        };
        let fresh = ShadowInset {
            left: dwm.0 - win.0,
            top: dwm.1 - win.1,
            right: (win.0 + win.2) - (dwm.0 + dwm.2),
            bottom: (win.1 + win.3) - (dwm.1 + dwm.3),
        };
        if inset_is_shadow(fresh) {
            // Keep a settled shadow. A one-frame compositor lag still looks
            // like a small inset change and must not replace it.
            let anchor = match cached {
                Some(prev) if inset_close(prev, fresh) => Some(fresh),
                Some(prev) => Some(prev),
                None => Some(fresh),
            };
            return Some((dwm.0, dwm.1, dwm.2, dwm.3, anchor));
        }
        if let Some(inset) = cached {
            let width = win.2 - inset.left - inset.right;
            let height = win.3 - inset.top - inset.bottom;
            if width > 0 && height > 0 {
                return Some((
                    win.0 + inset.left,
                    win.1 + inset.top,
                    width,
                    height,
                    Some(inset),
                ));
            }
        }
        // Compositor frame disagrees with the window, and there is no settled
        // shadow yet. Keep the compositor frame and do not store the gap.
        Some((dwm.0, dwm.1, dwm.2, dwm.3, None))
    }

    fn inset_close(a: ShadowInset, b: ShadowInset) -> bool {
        (a.left - b.left).abs() <= 4
            && (a.top - b.top).abs() <= 4
            && (a.right - b.right).abs() <= 4
            && (a.bottom - b.bottom).abs() <= 4
    }

    fn inset_is_shadow(inset: ShadowInset) -> bool {
        (-8..=48).contains(&inset.left)
            && (-8..=48).contains(&inset.top)
            && (-8..=64).contains(&inset.right)
            && (-8..=64).contains(&inset.bottom)
    }

    fn dwm_frame(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let status = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&mut rect as *mut RECT).cast(),
                std::mem::size_of::<RECT>() as u32,
            )
        };
        if status >= 0 {
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            if width > 0 && height > 0 && width <= 8192 && height <= 8192 {
                return Some((rect.left, rect.top, width, height));
            }
        }
        None
    }

    fn extended_frame(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
        dwm_frame(hwnd).or_else(|| window_rect(hwnd))
    }

    fn window_rect(hwnd: HWND) -> Option<(i32, i32, i32, i32)> {
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            return None;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 || width > 8192 || height > 8192 {
            None
        } else {
            Some((rect.left, rect.top, width, height))
        }
    }

    fn cloaked(hwnd: HWND) -> bool {
        let mut cloaked = 0u32;
        let status = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                (&mut cloaked as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        };
        status >= 0 && cloaked != 0
    }

    fn ex_topmost(hwnd: HWND) -> bool {
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
        style & (WS_EX_TOPMOST as isize) != 0
    }

    fn window_has_visible_point(
        target: HWND,
        overlay: HWND,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> bool {
        let samples = visibility_samples(x, y, width, height);
        if samples.is_empty() {
            return false;
        }
        let seen = samples.iter().any(|(px, py)| {
            let hit = unsafe { WindowFromPoint(POINT { x: *px, y: *py }) };
            hit_belongs(hit, target, overlay)
        });
        if seen {
            return true;
        }
        // A DPI-unaware thread reads extended frames in physical pixels and
        // WindowFromPoint in virtualized ones, so a miss there is not cover.
        if !pointer_is_virtualized() {
            return false;
        }
        let frame = Frame {
            key: 0,
            target: target as usize as u64,
            x,
            y,
            width,
            height,
            shown: true,
            anchor: None,
        };
        let occluders = occluding_rects(target, overlay, &frame);
        super::any_sample_open(&samples, &occluders)
    }

    fn pointer_is_virtualized() -> bool {
        unsafe {
            let context = GetThreadDpiAwarenessContext();
            GetAwarenessFromDpiAwarenessContext(context) == DPI_AWARENESS_UNAWARE
        }
    }

    fn frame_scale(target: u64) -> f32 {
        let dpi = unsafe {
            if target == 0 {
                GetDpiForSystem()
            } else {
                let dpi = GetDpiForWindow(target as usize as HWND);
                if dpi == 0 {
                    GetDpiForSystem()
                } else {
                    dpi
                }
            }
        };
        super::aura_scale(dpi)
    }

    fn hit_belongs(hit: HWND, target: HWND, overlay: HWND) -> bool {
        if hit.is_null() || hit == overlay {
            return false;
        }
        if our_overlay(hit) {
            return false;
        }
        if hit == target {
            return true;
        }
        let hit_root = unsafe { GetAncestor(hit, GA_ROOT) };
        let target_root = unsafe { GetAncestor(target, GA_ROOT) };
        !hit_root.is_null() && hit_root == target_root
    }

    /// Windows above `target`, limited to those that actually cross its frame.
    fn occluding_rects(target: HWND, overlay: HWND, frame: &Frame) -> Vec<RectI> {
        let target_rect = RectI {
            x: frame.x,
            y: frame.y,
            w: frame.width,
            h: frame.height,
        };
        let mut out = Vec::new();
        let mut cursor = unsafe { GetWindow(target, GW_HWNDPREV) };
        let mut guard = 0;
        while !cursor.is_null() && guard < 192 {
            guard += 1;
            if cursor != overlay && !our_overlay(cursor) && visually_covers(cursor) {
                if let Some((x, y, w, h)) = extended_frame(cursor) {
                    let rect = RectI { x, y, w, h };
                    if super::rects_intersect(&rect, &target_rect) {
                        out.push(rect);
                    }
                }
            }
            cursor = unsafe { GetWindow(cursor, GW_HWNDPREV) };
        }
        out
    }

    fn visually_covers(hwnd: HWND) -> bool {
        if unsafe { IsWindowVisible(hwnd) } == 0 || unsafe { IsIconic(hwnd) } != 0 || cloaked(hwnd)
        {
            return false;
        }
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
        style & (WS_EX_TRANSPARENT as isize) == 0
    }

    /// `(glow is below the target, an opaque window sits between them)`.
    /// Empty and click-through windows, including the usual IME slot directly
    /// under a window, do not count as being in the way.
    fn glow_is_above(target: HWND, overlay: HWND) -> bool {
        unsafe {
            let mut cursor = GetWindow(target, GW_HWNDPREV);
            let mut guard = 0;
            while !cursor.is_null() && guard < 24 {
                guard += 1;
                if cursor == overlay {
                    return true;
                }
                cursor = GetWindow(cursor, GW_HWNDPREV);
            }
            false
        }
    }

    fn scan_below(target: HWND, overlay: HWND) -> (bool, bool) {
        unsafe {
            let frame = window_rect(target);
            let mut cursor = GetWindow(target, GW_HWNDNEXT);
            let mut guard = 0;
            while !cursor.is_null() && guard < 8 {
                guard += 1;
                if cursor == overlay {
                    return (true, false);
                }
                if blocks_stack(cursor, frame) {
                    return (false, true);
                }
                cursor = GetWindow(cursor, GW_HWNDNEXT);
            }
            (false, false)
        }
    }

    fn blocks_stack(hwnd: HWND, frame: Option<(i32, i32, i32, i32)>) -> bool {
        if !visually_covers(hwnd) || our_overlay(hwnd) {
            return false;
        }
        let Some((x, y, w, h)) = window_rect(hwnd) else {
            return false;
        };
        if w < 8 || h < 8 {
            return false;
        }
        let Some((fx, fy, fw, fh)) = frame else {
            return true;
        };
        super::rects_intersect(
            &RectI { x, y, w, h },
            &RectI {
                x: fx,
                y: fy,
                w: fw,
                h: fh,
            },
        )
    }

    fn monitor_rects() -> Vec<RECT> {
        let mut rects = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                ptr::null_mut(),
                ptr::null(),
                Some(take_monitor),
                &mut rects as *mut Vec<RECT> as isize,
            );
        }
        rects
    }

    unsafe extern "system" fn take_monitor(
        _monitor: HMONITOR,
        _dc: HDC,
        rect: *mut RECT,
        data: LPARAM,
    ) -> i32 {
        if !rect.is_null() {
            let rects = &mut *(data as *mut Vec<RECT>);
            rects.push(*rect);
        }
        1
    }

    fn our_overlay(hwnd: HWND) -> bool {
        class_name(hwnd) == CLASS_NAME
    }

    fn class_name(hwnd: HWND) -> String {
        let mut name = [0u16; 64];
        let len = unsafe { GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&name[..len as usize])
    }

    fn register_class() -> u16 {
        static ATOM: OnceLock<u16> = OnceLock::new();
        *ATOM.get_or_init(|| {
            let mut wide: Vec<u16> = CLASS_NAME.encode_utf16().collect();
            wide.push(0);
            let class = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wnd_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: ptr::null_mut(),
                hIcon: ptr::null_mut(),
                hCursor: ptr::null_mut(),
                hbrBackground: ptr::null_mut(),
                lpszMenuName: ptr::null(),
                lpszClassName: wide.as_ptr(),
            };
            let atom = unsafe { RegisterClassW(&class) };
            std::mem::forget(wide);
            atom
        })
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    fn pump() {
        unsafe {
            let mut msg = MSG {
                hwnd: ptr::null_mut(),
                message: 0,
                wParam: 0,
                lParam: 0,
                time: 0,
                pt: POINT { x: 0, y: 0 },
            };
            while PeekMessageW(&mut msg, ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    impl Overlay {
        fn create() -> Option<Self> {
            let class = register_class();
            if class == 0 {
                return None;
            }
            let mut wide: Vec<u16> = CLASS_NAME.encode_utf16().collect();
            wide.push(0);
            // No WS_EX_TOPMOST. Z-order is set just under the target window.
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                    wide.as_ptr(),
                    wide.as_ptr(),
                    WS_POPUP,
                    0,
                    0,
                    0,
                    0,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null(),
                )
            };
            if hwnd.is_null() {
                return None;
            }
            unsafe {
                SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            }
            let screen = unsafe { GetDC(ptr::null_mut()) };
            let mem_dc = unsafe { CreateCompatibleDC(screen) };
            unsafe {
                ReleaseDC(ptr::null_mut(), screen);
            }
            if mem_dc.is_null() {
                unsafe { DestroyWindow(hwnd) };
                return None;
            }
            Some(Self {
                hwnd,
                mem_dc,
                dib: ptr::null_mut(),
                previous: ptr::null_mut(),
                bits: ptr::null_mut(),
                width: 0,
                height: 0,
                frame_x: 0,
                frame_y: 0,
                win_x: 0,
                win_y: 0,
                seen_x: 0,
                seen_y: 0,
                sample_x: 0,
                sample_y: 0,
                sampled: false,
                pad: 0,
                shown_x: 0,
                shown_y: 0,
                anchor: None,
                live: false,
                visible: false,
            })
        }

        fn hide(&mut self) {
            if !self.visible {
                return;
            }
            unsafe {
                if IsWindowVisible(self.hwnd) != 0 {
                    ShowWindow(self.hwnd, SW_HIDE);
                }
            }
            self.visible = false;
        }

        /// Slide the aura with the window. A full shader paint is only done
        /// when the size changes, on the first frame, or while the window is
        /// holding still. A drag repositions the bitmap from the window rect.
        fn follow(&mut self, frame: &Frame, elapsed_ms: u64, paint_due: bool) {
            let scale = frame_scale(frame.target);
            let pad_now = super::aura_pad(scale);
            let width = frame.width + pad_now * 2;
            let height = frame.height + pad_now * 2;
            let size_changed = !self.live || self.width != width || self.height != height;
            let win = if frame.target == 0 {
                None
            } else {
                window_rect(frame.target as usize as HWND)
            };
            let moving = match win {
                Some((x, y, _, _)) if self.live => window_moved(self.seen_x, self.seen_y, x, y),
                _ => false,
            };
            let pad = if size_changed { pad_now } else { self.pad };
            let (origin_x, origin_y, place_x, place_y) = if moving {
                if let Some((x, y, _, _)) = win {
                    let (ox, oy) = tracked_origin(
                        self.frame_x,
                        self.frame_y,
                        self.win_x,
                        self.win_y,
                        x,
                        y,
                        pad,
                    );
                    (
                        ox,
                        oy,
                        self.frame_x + (x - self.win_x),
                        self.frame_y + (y - self.win_y),
                    )
                } else {
                    (frame.x - pad, frame.y - pad, frame.x, frame.y)
                }
            } else {
                (frame.x - pad, frame.y - pad, frame.x, frame.y)
            };
            let paint = super::needs_full_paint(self.live, size_changed, moving, paint_due);
            if paint {
                let placed = Frame {
                    key: frame.key,
                    target: frame.target,
                    x: place_x,
                    y: place_y,
                    width: frame.width,
                    height: frame.height,
                    shown: frame.shown,
                    anchor: frame.anchor,
                };
                let occluders = if frame.target == 0 {
                    Vec::new()
                } else {
                    occluding_rects(frame.target as usize as HWND, self.hwnd, &placed)
                };
                let (wx, wy) = match win {
                    Some((x, y, _, _)) => (x, y),
                    None => (place_x, place_y),
                };
                self.place(&placed, elapsed_ms, &occluders, wx, wy, pad);
            } else if moving || !self.visible {
                self.present(origin_x, origin_y);
                if frame.target == 0 {
                    self.restack_screen();
                } else {
                    self.restack_behind(frame.target as usize as HWND);
                }
                self.visible = true;
                if let Some((x, y, _, _)) = win {
                    self.seen_x = x;
                    self.seen_y = y;
                }
            } else if let Some((x, y, _, _)) = win {
                self.seen_x = x;
                self.seen_y = y;
            }
        }

        /// Move the settled bitmap to where the window rect is now.
        /// Returns whether the rect has left the last full sample.
        fn nudge(&mut self, target: HWND) -> bool {
            if !self.live || !self.visible {
                return false;
            }
            let Some((wx, wy, _, _)) = window_rect(target) else {
                return false;
            };
            let changed = self.sampled && (wx != self.sample_x || wy != self.sample_y);
            self.sample_x = wx;
            self.sample_y = wy;
            self.sampled = true;
            let (x, y) = tracked_origin(
                self.frame_x,
                self.frame_y,
                self.win_x,
                self.win_y,
                wx,
                wy,
                self.pad,
            );
            self.present(x, y);
            self.restack_behind(target);
            changed
        }

        fn note_hidden(&mut self, frame: &Frame) {
            if frame.target == 0 {
                return;
            }
            let Some((wx, wy, _, _)) = window_rect(frame.target as usize as HWND) else {
                return;
            };
            self.seen_x = wx;
            self.seen_y = wy;
            self.sample_x = wx;
            self.sample_y = wy;
            self.sampled = true;
            if self.live {
                self.win_x = wx;
                self.win_y = wy;
                self.frame_x = frame.x;
                self.frame_y = frame.y;
            }
        }

        fn note_frame(&mut self, frame: &Frame, win_x: i32, win_y: i32, pad: i32) {
            self.frame_x = frame.x;
            self.frame_y = frame.y;
            self.win_x = win_x;
            self.win_y = win_y;
            self.seen_x = win_x;
            self.seen_y = win_y;
            self.sample_x = win_x;
            self.sample_y = win_y;
            self.sampled = true;
            self.pad = pad;
            self.shown_x = frame.x - pad;
            self.shown_y = frame.y - pad;
            if frame.anchor.is_some() {
                self.anchor = frame.anchor;
            }
            self.live = true;
        }

        fn present(&mut self, x: i32, y: i32) {
            if self.visible && x == self.shown_x && y == self.shown_y {
                return;
            }
            self.slide(x, y);
            self.shown_x = x;
            self.shown_y = y;
        }

        fn slide(&self, x: i32, y: i32) {
            if self.mem_dc.is_null() || self.width <= 0 || self.height <= 0 {
                return;
            }
            let mut origin = POINT { x, y };
            let mut size = windows_sys::Win32::Foundation::SIZE {
                cx: self.width,
                cy: self.height,
            };
            let mut source = POINT { x: 0, y: 0 };
            let blend = windows_sys::Win32::Graphics::Gdi::BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            };
            unsafe {
                UpdateLayeredWindow(
                    self.hwnd,
                    ptr::null_mut(),
                    &mut origin,
                    &mut size,
                    self.mem_dc,
                    &mut source,
                    0 as COLORREF,
                    &blend,
                    ULW_ALPHA,
                );
            }
        }

        fn place(
            &mut self,
            frame: &Frame,
            elapsed_ms: u64,
            occluders: &[RectI],
            win_x: i32,
            win_y: i32,
            pad: i32,
        ) {
            let scale = frame_scale(frame.target);
            let width = frame.width + pad * 2;
            let height = frame.height + pad * 2;
            if width <= 0 || height <= 0 || pad < 0 {
                return;
            }
            if !self.ensure_bitmap(width, height) {
                return;
            }
            let len = (width as usize) * (height as usize) * 4;
            let pixels = unsafe { std::slice::from_raw_parts_mut(self.bits, len) };
            super::paint_aura(
                pixels,
                width,
                height,
                pad,
                frame.x,
                frame.y,
                frame.width,
                frame.height,
                elapsed_ms,
                occluders,
                scale,
            );
            // The bitmap changed, so this updates even when the origin did not.
            self.slide(frame.x - pad, frame.y - pad);
            self.note_frame(frame, win_x, win_y, pad);
            if frame.target == 0 {
                self.restack_screen();
            } else {
                self.restack_behind(frame.target as usize as HWND);
            }
            self.visible = true;
        }

        fn restack_screen(&self) {
            unsafe {
                if ex_topmost(self.hwnd) {
                    SetWindowPos(
                        self.hwnd,
                        HWND_NOTOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
                if IsWindowVisible(self.hwnd) == 0 {
                    ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
                }
            }
        }

        /// Put the aura immediately under the shared window. The window then
        /// covers the rounded light at its corners. Inserting after a topmost
        /// window keeps the aura in that band, just beneath the window.
        fn restack_behind(&self, target: HWND) {
            unsafe {
                if IsWindow(target) == 0 {
                    return;
                }
                let target_top = ex_topmost(target);
                let overlay_top = ex_topmost(self.hwnd);
                let (found_below, opaque_between) = scan_below(target, self.hwnd);
                let hidden = IsWindowVisible(self.hwnd) == 0;
                // A layered reposition can leave the aura above the window.
                // That has to be corrected even when the downward scan misses it.
                if !glow_is_above(target, self.hwnd)
                    && super::aura_is_behind(target_top == overlay_top, found_below, opaque_between)
                    && !hidden
                {
                    return;
                }
                if should_clear_topmost(target_top, overlay_top) {
                    SetWindowPos(
                        self.hwnd,
                        HWND_NOTOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                } else if target_top && !overlay_top {
                    // Inserting after a topmost window does not reliably move
                    // an existing layered window into that band.
                    SetWindowPos(
                        self.hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
                SetWindowPos(
                    self.hwnd,
                    target,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }

        fn ensure_bitmap(&mut self, width: i32, height: i32) -> bool {
            if !self.dib.is_null() && self.width == width && self.height == height {
                return !self.bits.is_null();
            }
            if !self.dib.is_null() {
                unsafe {
                    SelectObject(self.mem_dc, self.previous);
                    DeleteObject(self.dib);
                }
                self.dib = ptr::null_mut();
                self.bits = ptr::null_mut();
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [windows_sys::Win32::Graphics::Gdi::RGBQUAD {
                    rgbBlue: 0,
                    rgbGreen: 0,
                    rgbRed: 0,
                    rgbReserved: 0,
                }],
            };
            let mut bits: *mut c_void = ptr::null_mut();
            let dib = unsafe {
                CreateDIBSection(
                    self.mem_dc,
                    &info,
                    DIB_RGB_COLORS,
                    &mut bits,
                    ptr::null_mut(),
                    0,
                )
            };
            if dib.is_null() || bits.is_null() {
                return false;
            }
            self.previous = unsafe { SelectObject(self.mem_dc, dib) };
            self.dib = dib;
            self.bits = bits.cast();
            self.width = width;
            self.height = height;
            true
        }
    }

    impl Drop for Overlay {
        fn drop(&mut self) {
            unsafe {
                if !self.dib.is_null() {
                    SelectObject(self.mem_dc, self.previous);
                    DeleteObject(self.dib);
                }
                if !self.mem_dc.is_null() {
                    DeleteDC(self.mem_dc);
                }
                if !self.hwnd.is_null() {
                    DestroyWindow(self.hwnd);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub struct WindowGlow;

    impl WindowGlow {
        pub fn start() -> Self {
            Self
        }

        pub fn sync(&self, _enabled: bool, _windows: &[u64], _screen: bool) {}
    }
}

pub use platform::WindowGlow;

/// `#8ecbff`. Lighter than the previous `#339cff`, and still blue at every thickness.
const ACCENT_R: u8 = 0x8e;
const ACCENT_G: u8 = 0xcb;
const ACCENT_B: u8 = 0xff;

/// Room around the window so the outward haze is not clipped.
/// Logical pixels. A little under the previous 45px pad, so the longest tongue
/// ends sooner.
const BAND_PAD: i32 = 38;

/// Rounded wrap. Larger than a window's own corner so the aura reads as a
/// round rectangle enclosing the frame, including at square corners.
const CORNER_RADIUS: f32 = 22.0;

/// How far outside the frame the brightest light sits. Scaled with the pad
/// from the previous 4.8.
const BLOOM_SHIFT: f32 = 4.1;

/// Soft ridge that keeps the rounded rectangle readable without a hard stroke.
/// Scaled with the pad from the previous 8.
const RIDGE_SIGMA: f32 = 6.8;

/// Outer haze at a tongue's normal reach. Scaled with the pad from the
/// previous 12.8. A tongue's reach scales this up and down.
const HAZE_SIGMA: f32 = 10.8;

/// How far light is allowed to spill back into the window. Scaled with the pad
/// from the previous 6.4.
const INNER_CUTOFF: f32 = 5.4;

/// Soft fade into the pad so the longest tongue does not end in a hard clip.
const FADE_BAND: f32 = 8.4;

const PEAK_ALPHA: f32 = 186.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RectI {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// The aura is under the window when it is in the same topmost band, it was
/// found below the window, and no opaque window sits between them.
fn aura_is_behind(same_band: bool, found_below: bool, opaque_between: bool) -> bool {
    same_band && found_below && !opaque_between
}

/// A topmost overlay cannot sit under an ordinary window until it leaves that band.
fn should_clear_topmost(target_topmost: bool, overlay_topmost: bool) -> bool {
    overlay_topmost && !target_topmost
}

/// Bitmap origin while a drag runs ahead of the last settled frame.
/// The baseline window origin is not updated here, so the delta stays absolute.
fn tracked_origin(
    frame_x: i32,
    frame_y: i32,
    base_x: i32,
    base_y: i32,
    win_x: i32,
    win_y: i32,
    pad: i32,
) -> (i32, i32) {
    (
        frame_x + (win_x - base_x) - pad,
        frame_y + (win_y - base_y) - pad,
    )
}

/// A one-pixel compositor disagreement is not a drag. The flame keeps painting.
fn window_moved(last_x: i32, last_y: i32, x: i32, y: i32) -> bool {
    (x - last_x).abs() > 2 || (y - last_y).abs() > 2
}

fn rects_intersect(a: &RectI, b: &RectI) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

fn point_in_rect(x: i32, y: i32, rect: &RectI) -> bool {
    x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h
}

/// True when at least one sample is outside every covering window.
fn any_sample_open(samples: &[(i32, i32)], occluders: &[RectI]) -> bool {
    samples
        .iter()
        .any(|(x, y)| !occluders.iter().any(|rect| point_in_rect(*x, *y, rect)))
}

/// Monitor DPI as a multiplier on the aura's logical pixels. 96 DPI is 1.
/// Below that the drawing stays at the designed size.
fn aura_scale(dpi: u32) -> f32 {
    if dpi <= 96 {
        1.0
    } else {
        (dpi as f32 / 96.0).clamp(1.0, 3.0)
    }
}

/// Paint the shader, or only slide a bitmap that already matches.
/// A move skips the paint so tracking does not wait on the shader.
fn needs_full_paint(live: bool, size_changed: bool, moved: bool, paint_due: bool) -> bool {
    !live || size_changed || (paint_due && !moved)
}

fn aura_pad(scale: f32) -> i32 {
    let scale = if scale.is_finite() {
        scale.clamp(1.0, 3.0)
    } else {
        1.0
    };
    ((BAND_PAD as f32) * scale).round() as i32
}

/// The glow pixel belongs to the window edge closest to it. When that point
/// lies in a window that covers the target, the pixel stays clear.
fn edge_is_covered(px: f32, py: f32, frame: RectI, occluders: &[RectI]) -> bool {
    if occluders.is_empty() || frame.w <= 0 || frame.h <= 0 {
        return false;
    }
    let cx = px.clamp(frame.x as f32, (frame.x + frame.w) as f32);
    let cy = py.clamp(frame.y as f32, (frame.y + frame.h) as f32);
    occluders.iter().any(|item| {
        cx >= item.x as f32
            && cx <= (item.x + item.w) as f32
            && cy >= item.y as f32
            && cy <= (item.y + item.h) as f32
    })
}

fn visibility_samples(x: i32, y: i32, w: i32, h: i32) -> Vec<(i32, i32)> {
    if w < 8 || h < 8 {
        return Vec::new();
    }
    let inset_x = (w / 8).clamp(4, 48);
    let inset_y = (h / 8).clamp(4, 48);
    let left = x + inset_x;
    let top = y + inset_y;
    let right = x + w - inset_x;
    let bottom = y + h - inset_y;
    let cx = x + w / 2;
    let cy = y + h / 2;
    vec![
        (cx, cy),
        (left, top),
        (right, top),
        (left, bottom),
        (right, bottom),
        (cx, top),
        (cx, bottom),
        (left, cy),
        (right, cy),
    ]
}

/// Intensity and outward reach of one point on the ring.
///
/// `angle` comes from `atan2` and jumps from π to −π on the left-center ray.
/// Only whole-number laps survive that jump: `sin(k·π − ωt)` equals
/// `sin(k·(−π) − ωt)` for every integer `k` and every time. A fractional lap
/// leaves a cut exactly there. The time speeds stay unrelated, so the tongues
/// keep wandering instead of becoming one rotating highlight.
fn flame_shape(angle: f32, elapsed_ms: u64) -> (f32, f32) {
    let t = elapsed_ms as f32 * 0.001;
    let n1 = (angle * 2.0 - t * 2.6).sin();
    let n2 = (angle * 3.0 + t * 4.1).sin();
    let n3 = (angle * 5.0 - t * 1.7).sin();
    let n4 = (angle * 7.0 + t * 6.3).sin();
    let mix = 0.46 * n1 + 0.27 * n2 + 0.17 * n3 + 0.10 * n4;
    // Peak the lobes so the light gathers into tongues instead of a smooth wave.
    let shaped = mix.signum() * mix.abs().powf(1.35);
    let intensity = (0.46 + 0.54 * shaped).clamp(0.20, 1.0);
    let reach = (1.0 + 0.22 * n1 + 0.10 * n2).clamp(0.72, 1.16);
    (intensity, reach)
}

fn rounded_rect_distance(px: f32, py: f32, x: f32, y: f32, w: f32, h: f32, radius: f32) -> f32 {
    let radius = radius.max(0.0).min(w * 0.5).min(h * 0.5);
    let cx = x + w * 0.5;
    let cy = y + h * 0.5;
    let qx = (px - cx).abs() - (w * 0.5 - radius);
    let qy = (py - cy).abs() - (h * 0.5 - radius);
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    let inside = qx.max(qy).min(0.0);
    outside + inside - radius
}

fn aura_bgra(dist: f32, angle: f32, elapsed_ms: u64) -> [u8; 4] {
    let (intensity, reach) = flame_shape(angle, elapsed_ms);
    let bloom = BLOOM_SHIFT * reach;
    let haze_sigma = HAZE_SIGMA * reach;
    let shifted = dist - bloom;
    let pad_limit = BAND_PAD as f32 - 2.0;
    if shifted > haze_sigma * 2.8 || dist < -INNER_CUTOFF || dist >= pad_limit {
        return [0, 0, 0, 0];
    }
    let ridge = (-0.5 * (shifted / RIDGE_SIGMA).powi(2)).exp();
    let haze = (-0.5 * (shifted / haze_sigma).powi(2)).exp();
    let mut body = haze * 0.85 + ridge * (0.35 + 0.65 * intensity);
    if dist < 0.0 {
        let u = (-dist / INNER_CUTOFF).clamp(0.0, 1.0);
        body *= (1.0 - u).powi(2);
    }
    if dist > pad_limit - FADE_BAND {
        body *= (1.0 - (dist - (pad_limit - FADE_BAND)) / FADE_BAND).clamp(0.0, 1.0);
    }
    // Tongues are brighter and reach farther. The dim parts stay lit, so the
    // ring does not blink out between them.
    let cover = (body * intensity).clamp(0.0, 1.0);
    if cover < 0.004 {
        return [0, 0, 0, 0];
    }
    // Same blue at every thickness. Lifting red toward white reads as purple.
    let alpha = (cover * PEAK_ALPHA).clamp(0.0, PEAK_ALPHA);
    let scale = alpha / 255.0;
    [
        (ACCENT_B as f32 * scale).round() as u8,
        (ACCENT_G as f32 * scale).round() as u8,
        (ACCENT_R as f32 * scale).round() as u8,
        alpha.round() as u8,
    ]
}

fn paint_aura(
    bits: &mut [u8],
    width: i32,
    height: i32,
    pad: i32,
    frame_x: i32,
    frame_y: i32,
    frame_w: i32,
    frame_h: i32,
    elapsed_ms: u64,
    occluders: &[RectI],
    scale: f32,
) {
    if width <= 0 || height <= 0 {
        return;
    }
    let scale = if scale.is_finite() {
        scale.clamp(1.0, 3.0)
    } else {
        1.0
    };
    let width_u = width as usize;
    let height_u = height as usize;
    let len = width_u * height_u * 4;
    if bits.len() < len {
        return;
    }
    bits[..len].fill(0);
    let frame = RectI {
        x: frame_x,
        y: frame_y,
        w: frame_w,
        h: frame_h,
    };
    let radius = (CORNER_RADIUS * scale)
        .min(frame_w as f32 * 0.5)
        .min(frame_h as f32 * 0.5);
    let inset = ((CORNER_RADIUS + INNER_CUTOFF) * scale).ceil() as i32 + 2;
    let skip_x0 = pad + inset;
    let skip_y0 = pad + inset;
    let skip_x1 = pad + frame_w - inset;
    let skip_y1 = pad + frame_h - inset;
    let origin_x = frame_x - pad;
    let origin_y = frame_y - pad;
    let cx = frame_x as f32 + frame_w as f32 * 0.5;
    let cy = frame_y as f32 + frame_h as f32 * 0.5;
    for y in 0..height_u {
        let row_skips = skip_y1 > skip_y0 && y as i32 >= skip_y0 && (y as i32) < skip_y1;
        for x in 0..width_u {
            if row_skips && skip_x1 > skip_x0 && x as i32 >= skip_x0 && (x as i32) < skip_x1 {
                continue;
            }
            let sx = origin_x as f32 + x as f32 + 0.5;
            let sy = origin_y as f32 + y as f32 + 0.5;
            if edge_is_covered(sx, sy, frame, occluders) {
                continue;
            }
            let dist = rounded_rect_distance(
                sx,
                sy,
                frame_x as f32,
                frame_y as f32,
                frame_w as f32,
                frame_h as f32,
                radius,
            ) / scale;
            let angle = (sy - cy).atan2(sx - cx);
            let pixel = aura_bgra(dist, angle, elapsed_ms);
            if pixel[3] == 0 {
                continue;
            }
            let offset = (y * width_u + x) * 4;
            bits[offset..offset + 4].copy_from_slice(&pixel);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        any_sample_open, aura_bgra, aura_is_behind, aura_pad, aura_scale, edge_is_covered,
        needs_full_paint, paint_aura, rounded_rect_distance, should_clear_topmost, tracked_origin,
        visibility_samples, window_moved, RectI, BAND_PAD, BLOOM_SHIFT, CORNER_RADIUS, HAZE_SIGMA,
        INNER_CUTOFF,
    };

    #[test]
    fn flame_joins_on_the_left_center() {
        let pi = std::f32::consts::PI;
        for ms in [0_u64, 180, 640, 1500, 4100, 8800] {
            let (hi_i, hi_r) = super::flame_shape(pi, ms);
            let (lo_i, lo_r) = super::flame_shape(-pi, ms);
            assert!(
                (hi_i - lo_i).abs() < 1e-3,
                "intensity seam at {ms}ms: {hi_i} vs {lo_i}"
            );
            assert!(
                (hi_r - lo_r).abs() < 1e-3,
                "reach seam at {ms}ms: {hi_r} vs {lo_r}"
            );
            for dist in [0.0, BLOOM_SHIFT, BLOOM_SHIFT + 8.0] {
                let above = aura_bgra(dist, pi - 0.001, ms)[3] as i16;
                let below = aura_bgra(dist, -pi + 0.001, ms)[3] as i16;
                assert!(
                    (above - below).abs() <= 3,
                    "alpha seam dist {dist} t {ms}: {above} vs {below}"
                );
            }
        }
    }

    #[test]
    fn flame_flickers_around_the_ring() {
        let angles = [0.0_f32, 0.8, 1.7, 2.5, 3.4, 4.6];
        let early: Vec<u8> = angles
            .into_iter()
            .map(|angle| aura_bgra(BLOOM_SHIFT, angle, 480)[3])
            .collect();
        let later: Vec<u8> = angles
            .into_iter()
            .map(|angle| aura_bgra(BLOOM_SHIFT, angle, 960)[3])
            .collect();
        let min = *early.iter().min().unwrap();
        let max = *early.iter().max().unwrap();
        assert!(min > 0, "the ring should stay lit, {early:?}");
        assert!(
            max - min > 20,
            "tongues should differ around the ring, {early:?}"
        );
        assert_ne!(early, later, "the flame should keep moving");
        let outer: Vec<u8> = angles
            .into_iter()
            .map(|angle| aura_bgra(BLOOM_SHIFT + 18.0, angle, 480)[3])
            .collect();
        let outer_min = *outer.iter().min().unwrap();
        let outer_max = *outer.iter().max().unwrap();
        assert!(
            outer_max > outer_min + 8,
            "some tongues should reach farther, {outer:?}"
        );
    }

    #[test]
    fn ridge_stays_the_accent_blue() {
        let pixel = aura_bgra(BLOOM_SHIFT, 0.0, 0);
        let alpha = pixel[3].max(1) as f32;
        let blue = pixel[0] as f32 * 255.0 / alpha;
        let green = pixel[1] as f32 * 255.0 / alpha;
        let red = pixel[2] as f32 * 255.0 / alpha;
        assert!(
            blue > 240.0 && green > 190.0 && green > red + 40.0 && red > 120.0 && red < 170.0,
            "highlight should stay a light blue, got r={red} g={green} b={blue}"
        );
    }

    #[test]
    fn band_stops_well_inside_the_old_reach() {
        assert_eq!(BAND_PAD, 38, "pad is a little under the previous 45");
        assert_eq!(aura_bgra(45.0, 0.0, 0)[3], 0);
    }

    #[test]
    fn a_fast_move_slides_instead_of_repainting() {
        assert!(needs_full_paint(false, false, false, false));
        assert!(needs_full_paint(true, true, true, false));
        assert!(!needs_full_paint(true, false, true, true));
        assert!(needs_full_paint(true, false, false, true));
        assert!(!needs_full_paint(true, false, false, false));
    }

    #[test]
    fn aura_grows_outward_from_a_soft_ridge() {
        let on_ridge = aura_bgra(BLOOM_SHIFT, 0.0, 0)[3];
        let on_frame = aura_bgra(0.0, 0.0, 0)[3];
        let deep_inside = aura_bgra(-INNER_CUTOFF, 0.0, 0)[3];
        let far = aura_bgra(BLOOM_SHIFT + 80.0, 0.0, 0)[3];
        assert!(on_ridge > on_frame, "ridge {on_ridge} frame {on_frame}");
        assert!(on_frame > 0, "{on_frame}");
        assert_eq!(deep_inside, 0);
        assert!(on_ridge > far, "ridge {on_ridge} far {far}");
        let haze = aura_bgra(BLOOM_SHIFT + 16.0, 0.0, 0)[3];
        assert!(
            haze > 8,
            "the outer light should still be visible, got {haze}"
        );
        assert!(
            (haze as f32) < (on_ridge as f32) * 0.75,
            "falloff should be soft, ridge {on_ridge} haze {haze}"
        );
    }

    #[test]
    fn a_fast_drag_keeps_the_settled_delta() {
        let (x, y) = tracked_origin(100, 80, 110, 90, 500, 240, BAND_PAD);
        assert_eq!((x, y), (100 + 390 - BAND_PAD, 80 + 150 - BAND_PAD));
        assert!(!window_moved(10, 20, 12, 21));
        assert!(window_moved(10, 20, 14, 20));
        assert!(window_moved(10, 20, 10, 24));
    }

    #[test]
    fn wrap_is_a_rounded_rectangle() {
        let edge = rounded_rect_distance(100.0, 0.0, 0.0, 0.0, 200.0, 100.0, CORNER_RADIUS);
        assert!(
            edge.abs() < 0.2,
            "mid-edge should lie on the wrap, got {edge}"
        );
        let sharp_corner = rounded_rect_distance(0.0, 0.0, 0.0, 0.0, 200.0, 100.0, CORNER_RADIUS);
        assert!(
            sharp_corner > 4.0,
            "the square corner sits outside the rounded wrap, got {sharp_corner}"
        );
        let center = rounded_rect_distance(100.0, 50.0, 0.0, 0.0, 200.0, 100.0, CORNER_RADIUS);
        assert!(center < -20.0, "center is inside, got {center}");
    }

    #[test]
    fn pad_holds_the_grown_haze() {
        let at_pad = aura_bgra(BAND_PAD as f32 - 1.0, 0.0, 0)[3];
        assert_eq!(at_pad, 0, "haze must fade inside the bitmap pad");
        let grown = aura_bgra(BLOOM_SHIFT + HAZE_SIGMA * 0.75, 1.2, 0)[3];
        assert!(grown > 0, "a tongue should still light the outer haze");
    }

    #[test]
    fn covered_edge_drops_its_haze() {
        let frame = RectI {
            x: 0,
            y: 0,
            w: 200,
            h: 120,
        };
        let left = RectI {
            x: 0,
            y: 0,
            w: 80,
            h: 120,
        };
        assert!(edge_is_covered(-12.0, 60.0, frame, &[left]));
        assert!(!edge_is_covered(220.0, 60.0, frame, &[left]));
        assert!(!edge_is_covered(140.0, -10.0, frame, &[left]));
    }

    #[test]
    fn ordinary_windows_keep_the_aura_behind_them() {
        assert!(aura_is_behind(true, true, false));
        assert!(!aura_is_behind(true, false, false));
        assert!(!aura_is_behind(true, true, true));
        assert!(!aura_is_behind(false, true, false));
        assert!(should_clear_topmost(false, true));
        assert!(!should_clear_topmost(false, false));
        assert!(!should_clear_topmost(true, true));
    }

    #[test]
    fn topmost_target_keeps_the_aura_in_that_band() {
        assert!(aura_is_behind(true, true, false));
        assert!(!should_clear_topmost(true, true));
        assert!(!should_clear_topmost(true, false));
    }

    #[test]
    fn dpi_scale_keeps_the_logical_pad_and_grows_on_a_dense_screen() {
        assert_eq!(aura_scale(96), 1.0);
        assert_eq!(aura_scale(0), 1.0);
        assert!((aura_scale(168) - 1.75).abs() < 0.001);
        assert_eq!(aura_pad(1.0), BAND_PAD);
        assert_eq!(aura_pad(1.75), ((BAND_PAD as f32) * 1.75).round() as i32);
        assert!(aura_pad(1.75) > aura_pad(1.0));
        assert_eq!(aura_pad(4.0), BAND_PAD * 3);
    }

    #[test]
    fn a_covered_sample_hides_the_aura_and_an_open_one_shows_it() {
        let samples = [(10, 10), (80, 10)];
        let cover = RectI {
            x: 0,
            y: 0,
            w: 100,
            h: 40,
        };
        assert!(!any_sample_open(&samples, &[cover]));
        assert!(any_sample_open(&[(10, 10), (140, 10)], &[cover]));
        assert!(any_sample_open(&samples, &[]));
    }

    #[test]
    fn higher_dpi_moves_the_bright_ridge_outward() {
        let scale = 2.0_f32;
        let pad = aura_pad(scale);
        let frame_w = 200i32;
        let frame_h = 120i32;
        let width = frame_w + pad * 2;
        let height = frame_h + pad * 2;
        let mut bits = vec![0u8; (width * height * 4) as usize];
        paint_aura(
            &mut bits,
            width,
            height,
            pad,
            0,
            0,
            frame_w,
            frame_h,
            0,
            &[],
            scale,
        );
        let y = (pad + frame_h / 2) as usize;
        let right = (pad + frame_w) as usize;
        let mut best_x = right;
        let mut best_a = 0u8;
        for x in right..width as usize {
            let alpha = bits[(y * width as usize + x) * 4 + 3];
            if alpha > best_a {
                best_a = alpha;
                best_x = x;
            }
        }
        let ridge = pad as f32 + frame_w as f32 + BLOOM_SHIFT * scale;
        assert!(
            (best_x as f32 - ridge).abs() < 6.0,
            "bright pixel {best_x} should sit near the scaled ridge {ridge}"
        );
        assert!(
            best_a > 40,
            "the ridge should still be visible, alpha {best_a}"
        );
    }

    #[test]
    fn visibility_samples_stay_inside_the_window() {
        let samples = visibility_samples(10, 20, 200, 100);
        assert!(samples.len() >= 9);
        for (x, y) in samples {
            assert!(x > 10 && x < 210, "{x}");
            assert!(y > 20 && y < 120, "{y}");
        }
        assert!(visibility_samples(0, 0, 4, 4).is_empty());
    }

    #[test]
    fn preview_aura_pngs() {
        if std::env::var("GLOW_PREVIEW").is_err() {
            return;
        }
        write_preview("glow-preview-wrap.png", 0, &[]);
        write_preview("glow-preview-flow.png", 900, &[]);
        write_preview(
            "glow-preview-covered.png",
            0,
            &[RectI {
                x: 80,
                y: 40,
                w: 150,
                h: 200,
            }],
        );
    }

    fn write_preview(name: &str, elapsed: u64, occluders: &[RectI]) {
        let frame_w = 280i32;
        let frame_h = 180i32;
        let frame_x = 40i32;
        let frame_y = 30i32;
        let pad = BAND_PAD;
        let width = frame_w + pad * 2;
        let height = frame_h + pad * 2;
        let mut bits = vec![0u8; (width * height * 4) as usize];
        super::paint_aura(
            &mut bits, width, height, pad, frame_x, frame_y, frame_w, frame_h, elapsed, occluders,
            1.0,
        );
        let mut rgba = Vec::with_capacity(bits.len());
        for y in 0..height {
            for x in 0..width {
                let sx = (frame_x - pad) as f32 + x as f32 + 0.5;
                let sy = (frame_y - pad) as f32 + y as f32 + 0.5;
                let inside = rounded_rect_distance(
                    sx,
                    sy,
                    frame_x as f32,
                    frame_y as f32,
                    frame_w as f32,
                    frame_h as f32,
                    8.0,
                ) < 0.0;
                let (bg_r, bg_g, bg_b) = if inside {
                    (28.0, 32.0, 40.0)
                } else {
                    (14.0, 16.0, 20.0)
                };
                let i = ((y * width + x) * 4) as usize;
                let a = bits[i + 3] as f32 / 255.0;
                let out_b = bits[i] as f32 + bg_b * (1.0 - a);
                let out_g = bits[i + 1] as f32 + bg_g * (1.0 - a);
                let out_r = bits[i + 2] as f32 + bg_r * (1.0 - a);
                rgba.push(out_r.round().clamp(0.0, 255.0) as u8);
                rgba.push(out_g.round().clamp(0.0, 255.0) as u8);
                rgba.push(out_b.round().clamp(0.0, 255.0) as u8);
                rgba.push(255);
            }
        }
        let image = image::RgbaImage::from_raw(width as u32, height as u32, rgba).unwrap();
        let path = std::env::temp_dir().join(name);
        image.save(&path).unwrap();
        eprintln!("preview {}", path.display());
    }
}
