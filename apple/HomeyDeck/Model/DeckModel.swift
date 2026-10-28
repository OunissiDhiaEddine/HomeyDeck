import Foundation
import Observation

/// The app's single source of truth: polls the server and runs actions.
@MainActor
@Observable
final class DeckModel {
    /// What the main card shows.
    enum Phase: Equatable {
        case notConfigured
        case unknown
        case offline
        case online
        case waking
        case goingToSleep
        case restarting
    }

    /// A state change we started and are waiting to see on the server.
    private struct Transition {
        enum Kind { case waking, sleeping, restarting, launchingSteam }
        let kind: Kind
        let deadline: Date
        var sawOffline = false
    }

    let settings: AppSettings

    private(set) var status: PCStatus?
    private(set) var lastError: String?
    private(set) var busy = false
    private(set) var lastUpdated: Date?
    private var transition: Transition?

    /// Set by the views: true while a window or the menu bar panel is visible.
    var isVisible = true { didSet { if isVisible && !oldValue { refreshSoon() } } }

    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var wakeTrigger: CheckedContinuation<Void, Never>?
    @ObservationIgnored private var pauseGeneration = 0

    init(settings: AppSettings = AppSettings()) {
        self.settings = settings
    }

    // MARK: Derived state

    var phase: Phase {
        guard settings.isServerConfigured else { return .notConfigured }
        switch transition?.kind {
        case .waking: return .waking
        case .sleeping: return .goingToSleep
        case .restarting: return .restarting
        default: break
        }
        guard let status else { return .unknown }
        return status.online ? .online : .offline
    }

    var isLaunchingSteam: Bool { transition?.kind == .launchingSteam }

    // MARK: Polling

    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                await self.pause(for: self.pollInterval)
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        refreshSoon()
    }

    /// Fast while something is changing, relaxed when nobody is looking,
    /// so a menu bar app left open all day stays far inside the free tier.
    private var pollInterval: TimeInterval {
        if transition != nil { return 2 }
        return isVisible ? 5 : 60
    }

    /// Sleeps until the interval passes or `refreshSoon()` is called.
    private func pause(for seconds: TimeInterval) async {
        pauseGeneration += 1
        let generation = pauseGeneration
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            wakeTrigger = continuation
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(seconds))
                // Ignore if this pause was already cut short and a newer one started.
                guard let self, self.pauseGeneration == generation else { return }
                self.refreshSoon()
            }
        }
    }

    func refreshSoon() {
        wakeTrigger?.resume()
        wakeTrigger = nil
    }

    func refresh() async {
        guard let client = try? APIClient(settings: settings) else {
            status = nil
            return
        }
        do {
            let new = try await client.status()
            status = new
            lastUpdated = .now
            if lastError != nil && !busy { lastError = nil }
            advanceTransition(with: new)
        } catch {
            lastError = message(for: error)
            if let transition, transition.deadline < .now { self.transition = nil }
        }
    }

    private func advanceTransition(with status: PCStatus) {
        guard var current = transition else { return }
        if !status.online { current.sawOffline = true }

        let done: Bool = switch current.kind {
        case .waking: status.online
        case .sleeping: !status.online
        case .restarting: current.sawOffline && status.online
        case .launchingSteam: status.steamRunning || !status.online
        }
        transition = (done || current.deadline < .now) ? nil : current
    }

    // MARK: Actions

    func wake() async {
        await perform(.waking, timeout: 150) {
            try await WakeOnLAN.wake(
                mac: self.settings.macAddress,
                host: self.settings.wakeHost,
                port: self.settings.wakePort
            )
        }
    }

    func launchSteam() async {
        await perform(.launchingSteam, timeout: 60) {
            try await APIClient(settings: self.settings).run(.launchSteam)
        }
    }

    func sleep() async {
        await perform(.sleeping, timeout: 90) {
            try await APIClient(settings: self.settings).run(.sleep)
        }
    }

    func restart() async {
        await perform(.restarting, timeout: 240) {
            try await APIClient(settings: self.settings).run(.reboot)
        }
    }

    private func perform(_ kind: Transition.Kind, timeout: TimeInterval, _ work: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        lastError = nil
        defer { busy = false }
        do {
            try await work()
            transition = Transition(kind: kind, deadline: .now.addingTimeInterval(timeout))
            refreshSoon()
        } catch {
            lastError = message(for: error)
        }
    }

    func dismissError() { lastError = nil }

    private func message(for error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet: return "You're offline."
            case .timedOut: return "The server took too long to answer."
            case .cannotFindHost, .cannotConnectToHost: return "Can't reach the server. Check the address in Settings."
            default: break
            }
        }
        return error.localizedDescription
    }
}
