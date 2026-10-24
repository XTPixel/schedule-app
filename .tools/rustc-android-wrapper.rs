//! Tauri sets the NDK .cmd linker after collecting the user's environment.
//! Override it for workspace Android crates, preserving UTF-16 argument passing.
use std::{env, process::{Command, exit}};
fn main() {
    let mut input=env::args_os().skip(1);
    let rustc=input.next().expect("rustc path");
    let args:Vec<_>=input.collect();
    let target=args.windows(2).find(|a|a[0]=="--target").map(|a|a[1].to_string_lossy().to_string());
    let mut command=Command::new(rustc);command.args(&args);
    if let Some(target)=target {
        let triple=match target.as_str(){"x86_64-linux-android"=>Some("x86_64-linux-android24"),"aarch64-linux-android"=>Some("aarch64-linux-android24"),_=>None};
        if let Some(triple)=triple {
            let clang=env::var("MOMENT_NDK_CLANG").expect("MOMENT_NDK_CLANG");
            command.arg(format!("-Clinker={clang}")).arg(format!("-Clink-arg=--target={triple}"));
        }
    }
    match command.status(){Ok(status)=>exit(status.code().unwrap_or(1)),Err(error)=>{eprintln!("rustc wrapper: {error}");exit(1)}}
}
