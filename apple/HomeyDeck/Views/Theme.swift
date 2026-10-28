import SwiftUI

extension DeckModel.Phase {
    var tint: Color {
        switch self {
        case .online: Color(red: 0.30, green: 0.85, blue: 0.55)
        case .waking, .restarting: Color(red: 1.00, green: 0.72, blue: 0.28)
        case .goingToSleep: Color(red: 0.55, green: 0.55, blue: 1.00)
        case .offline, .unknown, .notConfigured: Color(white: 0.55)
        }
    }

    var title: String {
        switch self {
        case .online: "Online"
        case .offline: "Asleep or off"
        case .waking: "Waking up…"
        case .goingToSleep: "Going to sleep…"
        case .restarting: "Restarting…"
        case .unknown: "Checking…"
        case .notConfigured: "Not set up yet"
        }
    }

    var isTransitioning: Bool {
        self == .waking || self == .goingToSleep || self == .restarting || self == .unknown
    }
}

enum Theme {
    static let steam = Color(red: 0.40, green: 0.65, blue: 1.00)
    static let background = LinearGradient(
        colors: [Color(red: 0.05, green: 0.06, blue: 0.10), Color(red: 0.09, green: 0.10, blue: 0.17)],
        startPoint: .top,
        endPoint: .bottom
    )
}

/// A translucent rounded card used for every section.
struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(.white.opacity(0.08))
            )
    }
}

/// A large square-ish button with an icon over a label.
struct ActionTile: View {
    let title: String
    let systemImage: String
    let tint: Color
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.system(size: 24, weight: .semibold))
                    .frame(height: 28)
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(enabled ? tint : .secondary)
            .frame(maxWidth: .infinity, minHeight: 92)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(enabled ? tint.opacity(0.14) : Color.white.opacity(0.04))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(enabled ? tint.opacity(0.35) : .white.opacity(0.06))
            )
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(PressableStyle())
        .disabled(!enabled)
    }
}

struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

func formatUptime(_ seconds: Int) -> String {
    let formatter = DateComponentsFormatter()
    formatter.allowedUnits = seconds >= 86_400 ? [.day, .hour] : [.hour, .minute]
    formatter.unitsStyle = .abbreviated
    formatter.zeroFormattingBehavior = .dropAll
    return formatter.string(from: TimeInterval(max(seconds, 60))) ?? ""
}
