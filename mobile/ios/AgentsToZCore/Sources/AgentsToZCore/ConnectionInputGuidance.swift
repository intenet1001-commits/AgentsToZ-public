import Foundation

/// The address box and QR scanner share validators, but their next steps differ.
/// Guidance never includes the rejected input (which may contain a pairing secret).
public enum ConnectionInputGuidance {
    public static func introduction(isMacCompatible: Bool) -> String {
        isMacCompatible
            ? "이 앱은 다른 컴퓨터의 AgentsToZ에 원격으로 연결합니다. 프로그램 설치와 프로젝트 실행은 연결한 컴퓨터에서 진행합니다."
            : "컴퓨터에서 하던 일을 이 기기에서 이어가세요."
    }

    public static func failure(addressField: Bool, httpsInput: Bool, fallback: String?) -> String {
        if addressField {
            return "연결 주소를 확인해 주세요. 개인 포털은 https://로 시작하는 주소를 입력하세요. 컴퓨터에서 복사한 연결 링크나 QR 주소는 전체를 붙여 넣어 주세요."
        }
        return httpsInput
            ? "개인 포털의 HTTPS 주소 또는 컴퓨터의 인터넷 연결 QR을 확인해 주세요."
            : fallback ?? "QR을 확인해 주세요."
    }
}
