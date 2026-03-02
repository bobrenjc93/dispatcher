/// Native macOS font panel integration via NSFontPanel / NSFontManager.
///
/// Opens the system font picker and streams font selections back to the
/// frontend as Tauri events (`font-panel-changed`).
use std::ffi::{c_void, CStr, CString};
use std::sync::Mutex;

use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel, BOOL, NO};
use objc::{class, msg_send, sel, sel_impl};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::errors::PtyError;

// ---------------------------------------------------------------------------
// Thread-safe wrappers for raw ObjC pointers (only accessed on main thread)
// ---------------------------------------------------------------------------

struct SendPtr(*mut Object);
unsafe impl Send for SendPtr {}
unsafe impl Sync for SendPtr {}

// ---------------------------------------------------------------------------
// Global state — written on main thread only
// ---------------------------------------------------------------------------

static APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);
static CURRENT_FONT: Mutex<SendPtr> = Mutex::new(SendPtr(std::ptr::null_mut()));

// ---------------------------------------------------------------------------
// Event payload
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct FontSelection {
    pub family: String,
    pub size: f64,
    pub weight: String,
}

// ---------------------------------------------------------------------------
// NSFontManager weight (0–15) ↔ CSS font-weight
// ---------------------------------------------------------------------------

fn nsfm_weight_to_css(w: isize) -> &'static str {
    match w {
        0..=2 => "100",
        3 => "200",
        4 => "300",
        5 => "normal",
        6 => "500",
        7..=8 => "600",
        9 => "bold",
        10..=11 => "800",
        _ => "900",
    }
}

fn css_weight_to_nsfm(w: &str) -> isize {
    match w {
        "100" => 2,
        "200" => 3,
        "300" => 4,
        "normal" | "400" => 5,
        "500" => 6,
        "600" => 7,
        "bold" | "700" => 9,
        "800" => 10,
        "900" => 12,
        _ => 5,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

unsafe fn ns_string(s: &str) -> *mut Object {
    let c = CString::new(s).unwrap_or_default();
    msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
}

unsafe fn nsstring_to_string(ns: *mut Object) -> String {
    if ns.is_null() {
        return String::new();
    }
    let cstr: *const std::os::raw::c_char = msg_send![ns, UTF8String];
    if cstr.is_null() {
        return String::new();
    }
    CStr::from_ptr(cstr).to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Delegate class — receives changeFont: from NSFontManager
// ---------------------------------------------------------------------------

static mut DELEGATE_CLASS: *const Class = std::ptr::null();
static REGISTER_ONCE: std::sync::Once = std::sync::Once::new();

fn get_delegate_class() -> &'static Class {
    REGISTER_ONCE.call_once(|| {
        let superclass = class!(NSObject);
        let mut decl = ClassDecl::new("DispatcherFontDelegate", superclass).unwrap();

        extern "C" fn change_font(_this: &Object, _sel: Sel, sender: *mut Object) {
            unsafe {
                if sender.is_null() {
                    return;
                }

                let current_ptr = CURRENT_FONT.lock().unwrap().0;
                if current_ptr.is_null() {
                    return;
                }

                // Ask NSFontManager to convert the current font to the new selection
                let new_font: *mut Object = msg_send![sender, convertFont: current_ptr];
                if new_font.is_null() {
                    return;
                }

                // Retain new, release old
                let _: *mut Object = msg_send![new_font, retain];
                let _: () = msg_send![current_ptr, release];
                CURRENT_FONT.lock().unwrap().0 = new_font;

                // Extract family
                let family_ns: *mut Object = msg_send![new_font, familyName];
                let family = nsstring_to_string(family_ns);

                // Extract size
                let size: f64 = msg_send![new_font, pointSize];

                // Extract weight via NSFontManager
                let fm: *mut Object = msg_send![class!(NSFontManager), sharedFontManager];
                let weight: isize = msg_send![fm, weightOfFont: new_font];
                let weight_css = nsfm_weight_to_css(weight).to_string();

                let selection = FontSelection {
                    family,
                    size,
                    weight: weight_css,
                };

                if let Ok(guard) = APP_HANDLE.lock() {
                    if let Some(ref handle) = *guard {
                        let _ = handle.emit("font-panel-changed", selection);
                    }
                }
            }
        }

        // Mark as valid for changeFont: action messages
        extern "C" fn responds_to_selector(
            _this: &Object,
            _sel: Sel,
            sel_arg: Sel,
        ) -> BOOL {
            if sel_arg == sel!(changeFont:) {
                return objc::runtime::YES;
            }
            unsafe { msg_send![super(_this, class!(NSObject)), respondsToSelector: sel_arg] }
        }

        unsafe {
            decl.add_method(
                sel!(changeFont:),
                change_font as extern "C" fn(&Object, Sel, *mut Object),
            );
            decl.add_method(
                sel!(respondsToSelector:),
                responds_to_selector as extern "C" fn(&Object, Sel, Sel) -> BOOL,
            );
        }

        let cls = decl.register();
        unsafe {
            DELEGATE_CLASS = cls;
        }
    });
    unsafe { &*DELEGATE_CLASS }
}

// ---------------------------------------------------------------------------
// GCD main-thread dispatch
// ---------------------------------------------------------------------------

extern "C" {
    // dispatch_get_main_queue() is a macro wrapping this global.
    static _dispatch_main_q: u8;
    fn dispatch_async_f(
        queue: *const u8,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
}

fn run_on_main<F: FnOnce() + Send + 'static>(f: F) {
    extern "C" fn trampoline<F: FnOnce()>(ctx: *mut c_void) {
        let f = unsafe { Box::from_raw(ctx as *mut F) };
        f();
    }

    let raw = Box::into_raw(Box::new(f)) as *mut c_void;
    unsafe {
        dispatch_async_f(&_dispatch_main_q, raw, trampoline::<F>);
    }
}

// ---------------------------------------------------------------------------
// Public API — called from Tauri commands
// ---------------------------------------------------------------------------

/// Open the native macOS font panel, pre-selecting the given font.
pub fn show(app: AppHandle, family: &str, size: f64, weight: &str) -> Result<(), PtyError> {
    *APP_HANDLE.lock().unwrap() = Some(app);

    let family = family.to_string();
    let weight = weight.to_string();

    run_on_main(move || unsafe {
        let fm: *mut Object = msg_send![class!(NSFontManager), sharedFontManager];

        // Create NSFont from family + size
        let family_ns = ns_string(&family);
        let mut font: *mut Object = msg_send![class!(NSFont), fontWithName: family_ns size: size];

        if font.is_null() {
            // Fallback: try system monospaced font
            let regular_weight: f64 = 0.0;
            font = msg_send![
                class!(NSFont),
                monospacedSystemFontOfSize: size
                weight: regular_weight
            ];
        }

        if font.is_null() {
            font = msg_send![class!(NSFont), systemFontOfSize: size];
        }

        // Adjust weight to match the requested CSS weight
        let target_nsfm = css_weight_to_nsfm(&weight);
        let current_nsfm: isize = msg_send![fm, weightOfFont: font];
        if current_nsfm < target_nsfm {
            for _ in 0..(target_nsfm - current_nsfm) {
                let heavier: *mut Object =
                    msg_send![fm, convertWeight: true ofFont: font];
                if heavier.is_null() || heavier == font {
                    break;
                }
                font = heavier;
            }
        }

        // Retain and store
        let _: *mut Object = msg_send![font, retain];
        let old = CURRENT_FONT.lock().unwrap().0;
        if !old.is_null() {
            let _: () = msg_send![old, release];
        }
        CURRENT_FONT.lock().unwrap().0 = font;

        // Create delegate and set it as the font manager's target
        let cls = get_delegate_class();
        let delegate: *mut Object = msg_send![cls, new];
        let _: () = msg_send![fm, setTarget: delegate];

        // Configure and show the font panel
        let panel: *mut Object = msg_send![class!(NSFontPanel), sharedFontPanel];
        let _: () = msg_send![panel, setPanelFont: font isMultiple: NO];
        let _: () = msg_send![panel, orderFront: std::ptr::null::<Object>()];
    });

    Ok(())
}

/// Hide the native font panel and clean up.
pub fn hide() -> Result<(), PtyError> {
    run_on_main(|| unsafe {
        let panel: *mut Object = msg_send![class!(NSFontPanel), sharedFontPanel];
        let _: () = msg_send![panel, orderOut: std::ptr::null::<Object>()];

        // Clear target
        let fm: *mut Object = msg_send![class!(NSFontManager), sharedFontManager];
        let null: *mut Object = std::ptr::null_mut();
        let _: () = msg_send![fm, setTarget: null];
    });

    // Clear stored app handle
    *APP_HANDLE.lock().unwrap() = None;

    Ok(())
}
