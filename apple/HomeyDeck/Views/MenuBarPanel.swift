#if os(macOS)
import SwiftUI

/// The compact panel that drops down from the Mac menu bar.
struct MenuBarPanel: View {
    @Environment(DeckModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @State private var armed: PCAction?

    var body: some View {
        let phase = model.phase
        let online = phase == .online && !model.busy
        let steamRunning = phase == .online && (model.status?.steamRunning ?? false)

        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "desktopcomputer")
                    .font(.title2)
                    .foregroundStyle(phase.tint)
                    .symbolEffect(.pulse, isActive: phase.isTransitioning)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.status?.hostname ?? "My PC").font(.headline)
                    Text(phase.title).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
            }

            HStack(spacing: 8) {
                Image(systemName: "gamecontroller.fill").foregroundStyle(Theme.steam)
                Text(steamRunning ? "Steam is running" : "Steam is not running")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
                if online && !steamRunning {
                    if model.isLaunchingSteam {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Launch") { Task { await model.launchSteam() } }
                            .controlSize(.small)
                    }
                }
            }

            HStack(spacing: 8) {
                smallButton("Wake", "power", DeckModel.Phase.online.tint,
                            enabled: model.settings.isWakeConfigured && !model.busy && phase != .online) {
                    Task { await model.wake() }
                }
                smallButton(armed == .sleep ? "Confirm" : "Sleep", "moon.zzz.fill",
                            DeckModel.Phase.goingToSleep.tint, enabled: online) {
                    confirmTwice(.sleep) { await model.sleep() }
                }
                smallButton(armed == .reboot ? "Confirm" : "Restart", "arrow.clockwise",
                            DeckModel.Phase.restarting.tint, enabled: online) {
                    confirmTwice(.reboot) { await model.restart() }
                }
            }

            if let error = model.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            HStack {
                Button("Open HomeyDeck") {
                    openWindow(id: "main")
                    NSApp.activate(ignoringOtherApps: true)
                }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
            .buttonStyle(.borderless)
            .font(.subheadline)
        }
        .padding(16)
        .frame(width: 300)
        .onAppear {
            model.startPolling()
            model.refreshSoon()
        }
    }

    /// Sleep and Restart need a second click within three seconds.
    private func confirmTwice(_ action: PCAction, run: @escaping () async -> Void) {
        if armed == action {
            armed = nil
            Task { await run() }
        } else {
            armed = action
            Task {
                try? await Task.sleep(for: .seconds(3))
                if armed == action { armed = nil }
            }
        }
    }

    private func smallButton(_ title: String, _ icon: String, _ tint: Color,
                             enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 15, weight: .semibold))
                Text(title).font(.caption.weight(.semibold))
            }
            .foregroundStyle(enabled ? tint : .secondary)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(enabled ? tint.opacity(0.14) : Color.primary.opacity(0.04))
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(PressableStyle())
        .disabled(!enabled)
    }
}
#endif
