//! App advice preference, independent of CLI settings and the running PTY backend's version.
use std::{fs, io::{Read, Write}, path::Path};

const FILE: &str = "desktop-effort-advice.json";
const LIMIT: u64 = 4096;

pub fn preference(directory: &Path, requested: Option<&str>) -> Result<String, String> {
    let path = directory.join(FILE);
    if let Some(mode) = requested {
        if !matches!(mode, "recommend" | "off") {return Err("앱 에포트는 추천 또는 OFF만 선택할 수 있습니다.".into());}
        fs::create_dir_all(directory).map_err(|_| "앱 추천 설정 폴더를 준비하지 못했습니다.")?;
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if !meta.is_file() {return Err("앱 추천 설정 파일을 확인하세요.".into());}
        }
        let nonce=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "시각 확인 실패")?.as_nanos();
        let temporary=directory.join(format!("{}.{}.{}.tmp",FILE,std::process::id(),nonce));
        let result=(|| -> std::io::Result<()> {
            let mut options=fs::OpenOptions::new();options.write(true).create_new(true);
            #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
            let mut file=options.open(&temporary)?;
            file.write_all(serde_json::json!({"version":1,"mode":mode}).to_string().as_bytes())?;
            file.sync_all()?;
            fs::rename(&temporary,&path)
        })();
        if result.is_err() {let _=fs::remove_file(&temporary);return Err("앱 추천 설정을 저장하지 못했습니다.".into());}
        return Ok(mode.to_owned());
    }
    let read=(|| -> Option<String> {
        let meta=fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() || meta.len()>LIMIT {return None;}
        let mut bytes=Vec::new();fs::File::open(path).ok()?.take(LIMIT+1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64>LIMIT {return None;}
        let value:serde_json::Value=serde_json::from_slice(&bytes).ok()?;
        if value.get("version")?.as_u64()? != 1 {return None;}
        let mode=value.get("mode")?.as_str()?;
        matches!(mode,"recommend"|"off").then(||mode.to_owned())
    })();
    Ok(read.unwrap_or_else(||"recommend".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn two_app_modes_never_modify_cli_settings() {
        let directory=std::env::temp_dir().join(format!("agentstoz-desktop-effort-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        assert_eq!(preference(&directory,None).unwrap(),"recommend");
        assert!(!directory.exists());
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("workroom-effort-auto.json"),b"cli-choice").unwrap();
        for mode in ["off","recommend","off"] {
            assert_eq!(preference(&directory,Some(mode)).unwrap(),mode);
            assert_eq!(preference(&directory,None).unwrap(),mode);
            assert_eq!(fs::read(directory.join("workroom-effort-auto.json")).unwrap(),b"cli-choice");
        }
        assert!(preference(&directory,Some("auto")).is_err());
        assert_eq!(preference(&directory,None).unwrap(),"off");
        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;assert_eq!(fs::metadata(directory.join(FILE)).unwrap().permissions().mode() & 0o777,0o600);}
        fs::write(directory.join(FILE),b"{\"version\":1,\"mode\":\"auto\"}").unwrap();
        assert_eq!(preference(&directory,None).unwrap(),"recommend");
        fs::remove_dir_all(directory).unwrap();
    }
}
