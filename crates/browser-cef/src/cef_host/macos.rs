use std::sync::{
    OnceLock,
    atomic::{AtomicBool, Ordering},
};

use cef::application_mac::CefAppProtocol;
use objc2::{
    ProtocolType, ffi, msg_send,
    runtime::{AnyObject, Bool, Imp, Sel},
    sel,
};
use objc2_app_kit::{NSApp, NSEvent};
use objc2_foundation::MainThreadMarker;

static HANDLING_SEND_EVENT: AtomicBool = AtomicBool::new(false);
static INSTALLATION: OnceLock<Result<(), String>> = OnceLock::new();

pub fn install_cef_application_protocols() -> Result<(), String> {
    INSTALLATION.get_or_init(install).clone()
}

fn install() -> Result<(), String> {
    let main_thread = MainThreadMarker::new()
        .ok_or_else(|| "CEF application integration must run on the main thread".to_string())?;
    let application = NSApp(main_thread);
    let class = application.class();
    let class_ptr = std::ptr::from_ref(class).cast_mut();

    unsafe {
        add_method(
            class_ptr,
            sel!(isHandlingSendEvent),
            std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel) -> Bool, Imp>(
                is_handling_send_event,
            ),
            c"c@:",
        )?;
        add_method(
            class_ptr,
            sel!(setHandlingSendEvent:),
            std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel, Bool), Imp>(
                set_handling_send_event,
            ),
            c"v@:c",
        )?;
        add_method(
            class_ptr,
            sel!(cefSendEvent:),
            std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel, &NSEvent), Imp>(
                cef_send_event,
            ),
            c"v@:@",
        )?;

        let original = ffi::class_getInstanceMethod(class, sel!(sendEvent:)).cast_mut();
        let replacement = ffi::class_getInstanceMethod(class, sel!(cefSendEvent:)).cast_mut();
        if original.is_null() || replacement.is_null() {
            return Err("failed to resolve NSApplication sendEvent methods".to_string());
        }
        ffi::method_exchangeImplementations(original, replacement);

        let protocol = <dyn CefAppProtocol>::protocol()
            .ok_or_else(|| "CEF application protocol is unavailable".to_string())?;
        if !ffi::class_addProtocol(class_ptr, protocol).as_bool()
            && !ffi::class_conformsToProtocol(class, protocol).as_bool()
        {
            return Err("failed to attach CefAppProtocol to the Tauri application".to_string());
        }
    }
    Ok(())
}

unsafe fn add_method(
    class: *mut objc2::runtime::AnyClass,
    selector: Sel,
    implementation: Imp,
    encoding: &std::ffi::CStr,
) -> Result<(), String> {
    if unsafe { ffi::class_addMethod(class, selector, implementation, encoding.as_ptr()) }.as_bool()
    {
        Ok(())
    } else {
        Err(format!("failed to add Objective-C method {selector}"))
    }
}

unsafe extern "C-unwind" fn is_handling_send_event(
    _application: &AnyObject,
    _selector: Sel,
) -> Bool {
    Bool::new(HANDLING_SEND_EVENT.load(Ordering::Acquire))
}

unsafe extern "C-unwind" fn set_handling_send_event(
    _application: &AnyObject,
    _selector: Sel,
    handling: Bool,
) {
    HANDLING_SEND_EVENT.store(handling.as_bool(), Ordering::Release);
}

unsafe extern "C-unwind" fn cef_send_event(
    application: &AnyObject,
    _selector: Sel,
    event: &NSEvent,
) {
    let was_handling = HANDLING_SEND_EVENT.swap(true, Ordering::AcqRel);
    unsafe {
        let _: () = msg_send![application, cefSendEvent: event];
    }
    HANDLING_SEND_EVENT.store(was_handling, Ordering::Release);
}
