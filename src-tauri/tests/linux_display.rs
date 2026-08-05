use std::ffi::OsStr;

use vibex::linux_display::cef_gdk_backend;

#[test]
fn xwayland_display_selects_the_x11_gdk_backend() {
    assert_eq!(cef_gdk_backend(Some(OsStr::new(":0"))), Some("x11"));
}

#[test]
fn missing_or_empty_xwayland_display_keeps_the_native_backend() {
    assert_eq!(cef_gdk_backend(None), None);
    assert_eq!(cef_gdk_backend(Some(OsStr::new(""))), None);
}
