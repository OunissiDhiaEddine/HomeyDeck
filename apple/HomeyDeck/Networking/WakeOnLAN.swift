import Foundation
import Network

/// Sends a Wake-on-LAN magic packet over UDP to the router's DDNS address,
/// which forwards it to the PC. Native apps can send UDP directly, so the
/// server is not involved in waking.
enum WakeOnLAN {
    enum WakeError: LocalizedError {
        case invalidMAC, invalidPort, missingHost, timedOut
        case network(String)

        var errorDescription: String? {
            switch self {
            case .invalidMAC: "The MAC address should look like AA:BB:CC:DD:EE:FF."
            case .invalidPort: "The wake port must be between 1 and 65535."
            case .missingHost: "Add your DDNS address in Settings."
            case .timedOut: "Couldn't reach your DDNS address. Check your connection."
            case .network(let message): message
            }
        }
    }

    /// Accepts AA:BB:CC:DD:EE:FF, AA-BB-..., or AABBCCDDEEFF.
    static func parseMAC(_ text: String) -> [UInt8]? {
        let hex = text.filter(\.isHexDigit)
        guard hex.count == 12, hex.count == text.filter({ !":-. ".contains($0) }).count else { return nil }
        var bytes: [UInt8] = []
        var index = hex.startIndex
        for _ in 0..<6 {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        return bytes
    }

    /// 6 x 0xFF followed by the MAC address repeated 16 times.
    static func magicPacket(for mac: [UInt8]) -> Data {
        var data = Data(repeating: 0xFF, count: 6)
        for _ in 0..<16 { data.append(contentsOf: mac) }
        return data
    }

    /// Sends the packet a few times, since UDP gives no delivery guarantee.
    static func wake(mac: String, host: String, port: Int, repeats: Int = 3) async throws {
        guard let bytes = parseMAC(mac) else { throw WakeError.invalidMAC }
        let host = host.trimmingCharacters(in: .whitespaces)
        guard !host.isEmpty else { throw WakeError.missingHost }
        guard (1...65535).contains(port), let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
            throw WakeError.invalidPort
        }

        let packet = magicPacket(for: bytes)
        let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .udp)
        let queue = DispatchQueue(label: "homeydeck.wake")
        let finish = Once()
        defer { connection.cancel() }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            func complete(_ error: Error?) {
                finish.run {
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }

            func send(_ remaining: Int) {
                connection.send(content: packet, completion: .contentProcessed { error in
                    if let error { return complete(WakeError.network(error.localizedDescription)) }
                    if remaining > 1 {
                        queue.asyncAfter(deadline: .now() + 0.15) { send(remaining - 1) }
                    } else {
                        complete(nil)
                    }
                })
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: send(repeats)
                case .failed(let error), .waiting(let error):
                    complete(WakeError.network(error.localizedDescription))
                default: break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 8) { complete(WakeError.timedOut) }
        }
    }
}

/// Runs a closure at most once, from any thread.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func run(_ body: () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard !done else { return }
        done = true
        body()
    }
}
