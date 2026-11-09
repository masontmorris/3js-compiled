fn main() {
    // SpiderMonkey bundles V8's irregexp with a small `v8::internal` shim, so V8 and mozjs both
    // define `v8::internal::PrintF` (x2) and `v8::internal::StdoutStream::StdoutStream()`.
    // SPIKE ONLY: let the linker keep the first definition. Both are debug-print helpers, but the
    // two StdoutStream classes are not layout-compatible, so this is not shippable.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bins=/FORCE:MULTIPLE");
    }
}
