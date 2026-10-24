//! Opt-in local QA bridge. Secrets only travel to an ephemeral authenticated
//! loopback receiver; they are never printed or saved to a plaintext file.
use std::{env, fs, path::PathBuf};
fn main() {
    if let Err(error)=run() { eprintln!("Cloud QA bootstrap failed: {error}"); std::process::exit(1); }
}
fn run() -> Result<(),String> {
    if env::var("MOMENT_ALLOW_CLOUD_QA").as_deref()!=Ok("1") { return Err("explicit QA opt-in required".into()); }
    let endpoint=env::var("MOMENT_QA_BOOTSTRAP").map_err(|_|"missing loopback receiver")?;
    let parsed=url::Url::parse(&endpoint).map_err(|_|"invalid loopback receiver")?;
    if parsed.scheme()!="http" || parsed.host_str()!=Some("127.0.0.1") || parsed.path()!="/bootstrap" { return Err("receiver must be local".into()); }
    let token=env::var("MOMENT_QA_TOKEN").map_err(|_|"missing receiver token")?;
    let path=PathBuf::from(env::var("APPDATA").map_err(|_|"missing APPDATA")?).join("com.personal.schedule/sync.json");
    let profile:serde_json::Value=serde_json::from_slice(&fs::read(path).map_err(|_|"existing application profile unavailable")?).map_err(|_|"existing profile is invalid")?;
    if profile["bucket"].as_str()!=Some("moment-app") { return Err("saved profile does not refer to the authorized bucket".into()); }
    let device=profile["credentialId"].as_str().or_else(||profile["deviceId"].as_str()).ok_or("profile has no credential reference")?;
    let read=|kind:&str|->Result<String,String>{
        keyring::Entry::new("com.personal.schedule.qiniu-sync",&format!("{device}:{kind}")).map_err(|_|"credential entry unavailable")?
            .get_password().map_err(|_|format!("saved {kind} unavailable"))
    };
    let input=serde_json::json!({"bucket":profile["bucket"],"downloadDomain":profile["downloadDomain"],"accessKey":read("access-key")?,"secretKey":read("secret-key")?,"passphrase":read("passphrase")?});
    let encoded=serde_json::to_string(&input).map_err(|_|"cannot encode bootstrap")?;
    let response=ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(45)).build()
        .post(&endpoint).set("Authorization",&format!("Bearer {token}")).set("Content-Type","application/json").send_string(&encoded).map_err(|_|"local receiver rejected bootstrap")?;
    if response.status()!=200 { return Err("local receiver did not confirm configuration".into()); }
    println!("Configured isolated QA clients without exporting secrets.");
    Ok(())
}
