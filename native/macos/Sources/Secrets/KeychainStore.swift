import Foundation
import Security

/// Generic-password Keychain access for provider secrets. The secret itself is passed as base64 on
/// the helper's stdin pipe, so it never shows up in argv, the environment, or a log line.
enum KeychainStore {
    static func put(service: String, account: String, secretBase64: String) throws {
        guard let secretData = Data(base64Encoded: secretBase64) else {
            throw HelperError.invalidParams("secretBase64 is not valid base64")
        }
        SecItemDelete(baseQuery(service: service, account: account) as CFDictionary)
        var attributes = baseQuery(service: service, account: account)
        attributes[kSecValueData as String] = secretData
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw HelperError.keychain(status) }
    }

    static func get(service: String, account: String) throws -> String? {
        var query = baseQuery(service: service, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw HelperError.keychain(status) }
        guard let data = item as? Data else { return nil }
        return data.base64EncodedString()
    }

    static func delete(service: String, account: String) throws {
        let status = SecItemDelete(baseQuery(service: service, account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw HelperError.keychain(status) }
    }

    private static func baseQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
