import Foundation
import Observation
import Security

/// Everything the app needs to reach the PC. The app key lives in the
/// Keychain; the rest is not secret and lives in UserDefaults.
@Observable
final class AppSettings {
    var serverAddress: String { didSet { defaults.set(serverAddress, forKey: Keys.server) } }
    var wakeHost: String { didSet { defaults.set(wakeHost, forKey: Keys.wakeHost) } }
    var wakePort: Int { didSet { defaults.set(wakePort, forKey: Keys.wakePort) } }
    var macAddress: String { didSet { defaults.set(macAddress, forKey: Keys.mac) } }
    var appKey: String { didSet { Keychain.save(appKey, account: Keys.appKey) } }

    private let defaults: UserDefaults

    private enum Keys {
        static let server = "serverAddress"
        static let wakeHost = "wakeHost"
        static let wakePort = "wakePort"
        static let mac = "macAddress"
        static let appKey = "appKey"
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        serverAddress = defaults.string(forKey: Keys.server) ?? ""
        wakeHost = defaults.string(forKey: Keys.wakeHost) ?? ""
        wakePort = defaults.object(forKey: Keys.wakePort) as? Int ?? 9
        macAddress = defaults.string(forKey: Keys.mac) ?? ""
        appKey = Keychain.read(account: Keys.appKey) ?? ""
    }

    var serverURL: URL? { Self.serverURL(from: serverAddress) }

    /// Turns a typed server address into a URL, accepting it with or without https://.
    static func serverURL(from address: String) -> URL? {
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    var isServerConfigured: Bool { serverURL != nil && !appKey.isEmpty }
    var isWakeConfigured: Bool { !wakeHost.isEmpty && WakeOnLAN.parseMAC(macAddress) != nil }
    var isConfigured: Bool { isServerConfigured && isWakeConfigured }
}

/// Minimal Keychain wrapper for a few strings.
enum Keychain {
    private static let service = "app.homeydeck"

    private static func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // Keeps macOS on the modern keychain, with no password prompts.
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    static func read(account: String) -> String? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ value: String, account: String) {
        SecItemDelete(baseQuery(account) as CFDictionary)
        guard !value.isEmpty else { return }
        var query = baseQuery(account)
        query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }
}
