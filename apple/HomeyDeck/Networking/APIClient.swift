import Foundation

/// What the server knows about the PC, as reported by the Windows agent.
struct PCStatus: Decodable, Equatable {
    var online: Bool
    var steamRunning: Bool
    var hostname: String?
    var uptimeSeconds: Int?
    var agentVersion: String?
    var lastSeen: Date?
}

enum PCAction: String {
    case launchSteam = "launch_steam"
    case sleep
    case reboot
}

enum APIError: LocalizedError {
    case notConfigured
    case unauthorized
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Add your server address and key in Settings."
        case .unauthorized: "The server rejected your app key. Check it in Settings."
        case .server(let message): message.prefix(1).uppercased() + message.dropFirst()
        }
    }
}

/// Talks to the HomeyDeck Cloudflare Worker.
struct APIClient {
    let baseURL: URL
    let appKey: String

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15 // the server waits up to 10 s for the PC to answer
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: text) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "bad date \(text)"))
        }
        return decoder
    }()

    init(serverAddress: String, appKey: String) throws {
        guard let url = AppSettings.serverURL(from: serverAddress), !appKey.isEmpty else { throw APIError.notConfigured }
        baseURL = url
        self.appKey = appKey
    }

    init(settings: AppSettings) throws {
        try self.init(serverAddress: settings.serverAddress, appKey: settings.appKey)
    }

    func status() async throws -> PCStatus {
        let data = try await send(path: "api/status", method: "GET")
        return try Self.decoder.decode(PCStatus.self, from: data)
    }

    func run(_ action: PCAction) async throws {
        let body = try JSONEncoder().encode(["action": action.rawValue])
        _ = try await send(path: "api/command", method: "POST", body: body)
    }

    private func send(path: String, method: String, body: Data? = nil) async throws -> Data {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(appKey)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }

        let (data, response) = try await Self.session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(code) else {
            struct ErrorBody: Decodable { let error: String? }
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError.server(message ?? "Server error (\(code)).")
        }
        return data
    }
}
