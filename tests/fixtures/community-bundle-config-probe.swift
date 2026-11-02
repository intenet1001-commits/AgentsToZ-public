import Foundation

@main struct PublicConfigProbe {
    static func main() throws {
        let key = ScreenCommunityBundleConfiguration.infoKey
        if CommandLine.arguments.count == 2 {
            let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
            let result = rows.map { row -> [Bool] in
                let info: [String: Any] = [key: row["config"] as Any]
                return [ScreenCommunityBundleConfiguration.parse(info: info) != nil, CommunityControlBundleConfiguration.parse(info: info) != nil]
            }
            print(String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self))
        } else {
            let info = Bundle.main.infoDictionary ?? [:]
            print([ScreenCommunityBundleConfiguration.parse(info: info) != nil, CommunityControlBundleConfiguration.parse(info: info) != nil])
        }
    }
}
