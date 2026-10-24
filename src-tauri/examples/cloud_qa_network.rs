//! Opt-in connectivity probe; all signed reads use the authorized QA prefix.
use std::{env,fs,path::PathBuf};
fn main() {
    if env::var("MOMENT_ALLOW_CLOUD_QA").as_deref()!=Ok("1") { std::process::exit(2); }
    let file=PathBuf::from(env::var("APPDATA").unwrap()).join("com.personal.schedule/sync.json");
    let profile:serde_json::Value=serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
    assert_eq!(profile["bucket"],"moment-app");
    let mut url=url::Url::parse(profile["downloadDomain"].as_str().unwrap()).unwrap();
    url.set_path("/");url.set_query(None);url.set_fragment(None);
    let mut request=ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(15)).build().get(url.as_str());
    let signed=env::var("MOMENT_QA_SIGNED_PROBE").as_deref()==Ok("1");
    if signed {
        use hmac::{Hmac,Mac}; use sha2::{Sha256,Digest};
        let mac=|key:&[u8],text:&str| {let mut m=Hmac::<Sha256>::new_from_slice(key).unwrap();m.update(text.as_bytes());m.finalize().into_bytes().to_vec()};
        let prefix="moment-qa/20261024-beta2-d43f80a3";
        let sequence=env::var("MOMENT_QA_PROBE_SEQUENCE").unwrap_or_else(|_|"1".into()).parse::<u64>().unwrap();assert!((1..=1024).contains(&sequence));
        url.set_path(&format!("/{prefix}/coordination/{sequence:020}.json"));
        let device=profile["credentialId"].as_str().or_else(||profile["deviceId"].as_str()).unwrap();
        let read=|kind:&str|keyring::Entry::new("com.personal.schedule.qiniu-sync",&format!("{device}:{kind}")).unwrap().get_password().expect("Authorized vault entry unavailable");
        let ak=read("access-key");let sk=read("secret-key");let host=url.host_str().unwrap();
        let region=host.split(".s3.").nth(1).unwrap().split('.').next().unwrap();let now=chrono::Utc::now();
        let date=now.format("%Y%m%d").to_string();let amz=now.format("%Y%m%dT%H%M%SZ").to_string();let empty=hex::encode(Sha256::digest(b""));
        let headers=format!("host:{host}\nx-amz-content-sha256:{empty}\nx-amz-date:{amz}\n");let names="host;x-amz-content-sha256;x-amz-date";
        let canonical=format!("GET\n{}\n\n{headers}\n{names}\n{empty}",url.path());let scope=format!("{date}/{region}/s3/aws4_request");
        let text=format!("AWS4-HMAC-SHA256\n{amz}\n{scope}\n{}",hex::encode(Sha256::digest(canonical.as_bytes())));
        let key=mac(&mac(&mac(&mac(format!("AWS4{sk}").as_bytes(),&date),region),"s3"),"aws4_request");
        let auth=format!("AWS4-HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={names}, Signature={}",hex::encode(mac(&key,&text)));
        request=ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(15)).build().get(url.as_str()).set("Host",host).set("x-amz-content-sha256",&empty).set("x-amz-date",&amz).set("Authorization",&auth);
    }
    let result=request.call();
    match result {
        Ok(response)=>println!("Rust HTTP probe reached server (signed={signed}): {}",response.status()),
        Err(ureq::Error::Status(status,_))=>println!("Rust HTTP probe reached server (signed={signed}): {status}"),
        Err(ureq::Error::Transport(error))=>{
            println!("Rust HTTP probe transport kind (signed={signed}): {:?}",error.kind());
            // Only the unsigned case may print nested errors, never auth data.
            if !signed {use std::error::Error;let mut source=error.source();while let Some(cause)=source {println!("Unsigned probe cause: {cause}");source=cause.source();}}
            std::process::exit(1);
        }
    }
}
