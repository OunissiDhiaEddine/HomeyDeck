import SwiftUI

/// The main screen: PC status, Steam, and the power controls.
struct DeckView: View {
    @Environment(DeckModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSettings = false
    @State private var confirming: PCAction?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    StatusHero(phase: model.phase, hostname: model.status?.hostname, detail: detail)
                        .padding(.top, 12)

                    if model.phase == .notConfigured || !model.settings.isWakeConfigured {
                        SetupCard { showSettings = true }
                    }

                    SteamCard()
                    actions
                    footer
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background { background }
            .overlay(alignment: .bottom) { errorBanner }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
                }
            }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .refreshable { await model.refresh() }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environment(model)
        }
        .confirmationDialog(confirmTitle, isPresented: confirmingBinding, titleVisibility: .visible) {
            if confirming == .sleep {
                Button("Sleep") { Task { await model.sleep() } }
            } else {
                Button("Restart", role: .destructive) { Task { await model.restart() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(confirming == .sleep
                 ? "You can wake it again from here."
                 : "Anything unsaved on the PC will be lost.")
        }
        .sensoryFeedback(.success, trigger: model.phase) { _, new in new == .online }
        .onAppear { model.startPolling() }
        .onChange(of: scenePhase, initial: true) { _, phase in
            model.isVisible = phase == .active
        }
        .preferredColorScheme(.dark)
    }

    // MARK: Sections

    private var actions: some View {
        let phase = model.phase
        let online = phase == .online && !model.busy
        let canWake = model.settings.isWakeConfigured && !model.busy
            && (phase == .offline || phase == .unknown || phase == .goingToSleep)

        return HStack(spacing: 12) {
            ActionTile(title: "Wake", systemImage: "power", tint: DeckModel.Phase.online.tint, enabled: canWake) {
                Task { await model.wake() }
            }
            ActionTile(title: "Sleep", systemImage: "moon.zzz.fill", tint: DeckModel.Phase.goingToSleep.tint, enabled: online) {
                confirming = .sleep
            }
            ActionTile(title: "Restart", systemImage: "arrow.clockwise", tint: DeckModel.Phase.restarting.tint, enabled: online) {
                confirming = .reboot
            }
        }
    }

    @ViewBuilder private var footer: some View {
        if let updated = model.lastUpdated {
            HStack(spacing: 4) {
                Text("Updated")
                Text(updated, style: .relative)
                Text("ago")
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
            .padding(.top, 4)
        }
    }

    private var background: some View {
        ZStack {
            Theme.background
            RadialGradient(
                colors: [model.phase.tint.opacity(0.22), .clear],
                center: .top,
                startRadius: 0,
                endRadius: 420
            )
            .animation(.easeInOut(duration: 0.8), value: model.phase)
        }
        .ignoresSafeArea()
    }

    @ViewBuilder private var errorBanner: some View {
        if let error = model.lastError {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text(error)
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button { model.dismissError() } label: {
                    Image(systemName: "xmark").font(.footnote.weight(.bold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            .padding(14)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
            .frame(maxWidth: 520)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: Helpers

    private var detail: String {
        guard let status = model.status else { return "" }
        if model.phase == .online, let up = status.uptimeSeconds { return "Up for \(formatUptime(up))" }
        if model.phase == .offline, let seen = status.lastSeen {
            return "Last seen " + seen.formatted(.relative(presentation: .named))
        }
        return ""
    }

    private var confirmTitle: String {
        confirming == .sleep ? "Put the PC to sleep?" : "Restart the PC?"
    }

    private var confirmingBinding: Binding<Bool> {
        Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })
    }
}

/// The big glowing PC icon with its state underneath.
struct StatusHero: View {
    let phase: DeckModel.Phase
    let hostname: String?
    let detail: String

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(phase.tint.opacity(phase == .offline ? 0.10 : 0.30))
                    .frame(width: 150, height: 150)
                    .blur(radius: 28)
                    .phaseAnimator([false, true]) { glow, expanded in
                        glow.scaleEffect(expanded ? 1.12 : 0.92)
                    } animation: { _ in .easeInOut(duration: 2.2) }

                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 112, height: 112)
                    .overlay(Circle().strokeBorder(phase.tint.opacity(0.55), lineWidth: 1.5))

                Image(systemName: "desktopcomputer")
                    .font(.system(size: 44, weight: .medium))
                    .foregroundStyle(phase.tint)
                    .symbolEffect(.pulse, isActive: phase.isTransitioning)
                    .contentTransition(.symbolEffect(.replace))
            }
            .animation(.easeInOut(duration: 0.6), value: phase)

            VStack(spacing: 6) {
                Text(hostname ?? "My PC")
                    .font(.title2.weight(.bold))
                HStack(spacing: 7) {
                    Circle().fill(phase.tint).frame(width: 8, height: 8)
                    Text(phase.title)
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

struct SteamCard: View {
    @Environment(DeckModel.self) private var model

    var body: some View {
        let online = model.phase == .online
        let running = online && (model.status?.steamRunning ?? false)

        Card {
            HStack(spacing: 14) {
                Image(systemName: "gamecontroller.fill")
                    .font(.title2)
                    .foregroundStyle(Theme.steam)
                    .frame(width: 46, height: 46)
                    .background(Theme.steam.opacity(0.15), in: RoundedRectangle(cornerRadius: 13, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text("Steam").font(.headline)
                    Text(subtitle(online: online, running: running))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                if model.isLaunchingSteam && !running {
                    ProgressView().controlSize(.small)
                } else if running {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(DeckModel.Phase.online.tint)
                } else if online {
                    Button("Launch") { Task { await model.launchSteam() } }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.steam)
                        .disabled(model.busy)
                }
            }
        }
        .animation(.easeInOut(duration: 0.3), value: running)
    }

    private func subtitle(online: Bool, running: Bool) -> String {
        if !online { return "Available when the PC is on" }
        if running { return "Running, ready for Remote Play" }
        if model.isLaunchingSteam { return "Starting…" }
        return "Not running"
    }
}

struct SetupCard: View {
    let openSettings: () -> Void

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Label("Finish setting up", systemImage: "sparkles")
                    .font(.headline)
                Text("Add your server address, app key and Wake-on-LAN details to start controlling your PC.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Open Settings", action: openSettings)
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 2)
            }
        }
    }
}
