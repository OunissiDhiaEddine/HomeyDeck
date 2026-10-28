import SwiftUI

/// Edits a draft copy of the settings and saves it in one go.
struct SettingsView: View {
    @Environment(DeckModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var server = ""
    @State private var appKey = ""
    @State private var wakeHost = ""
    @State private var wakePort = "9"
    @State private var mac = ""
    @State private var revealKey = false
    @State private var testResult: TestResult?
    @State private var testing = false

    private enum TestResult {
        case ok(String), failed(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("homeydeck.you.workers.dev", text: $server)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                    HStack {
                        Group {
                            if revealKey {
                                TextField("App key", text: $appKey)
                            } else {
                                SecureField("App key", text: $appKey)
                            }
                        }
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        Button { revealKey.toggle() } label: {
                            Image(systemName: revealKey ? "eye.slash" : "eye")
                        }
                        .buttonStyle(.borderless)
                    }
                    testRow
                } header: {
                    Text("Server")
                } footer: {
                    Text("Your Cloudflare Worker address and the APP_KEY you set on it. The key is stored in your Keychain.")
                }

                Section {
                    TextField("myhome.ddns.net", text: $wakeHost)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                    TextField("UDP port", text: $wakePort)
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                    TextField("MAC address, e.g. AA:BB:CC:DD:EE:FF", text: $mac)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                    if !mac.isEmpty && WakeOnLAN.parseMAC(mac) == nil {
                        Label("That doesn't look like a MAC address.", systemImage: "exclamationmark.circle")
                            .foregroundStyle(.orange)
                            .font(.footnote)
                    }
                } header: {
                    Text("Wake-on-LAN")
                } footer: {
                    Text("Your router's DDNS address, the UDP port you forwarded, and the MAC address of the PC's network adapter.")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(); dismiss() }
                        .disabled(!canSave)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
        .onAppear(perform: load)
    }

    @ViewBuilder private var testRow: some View {
        HStack {
            Button("Test connection") { Task { await test() } }
                .disabled(testing || server.isEmpty || appKey.isEmpty)
            Spacer()
            if testing {
                ProgressView().controlSize(.small)
            } else if let testResult {
                switch testResult {
                case .ok(let text):
                    Label(text, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                case .failed(let text):
                    Label(text, systemImage: "xmark.circle.fill").foregroundStyle(.red)
                }
            }
        }
        .font(.callout)
    }

    private var port: Int? {
        Int(wakePort.trimmingCharacters(in: .whitespaces)).flatMap { (1...65535).contains($0) ? $0 : nil }
    }

    private var canSave: Bool {
        port != nil && (mac.isEmpty || WakeOnLAN.parseMAC(mac) != nil)
    }

    private func load() {
        let s = model.settings
        server = s.serverAddress
        appKey = s.appKey
        wakeHost = s.wakeHost
        wakePort = String(s.wakePort)
        mac = s.macAddress
    }

    private func save() {
        let s = model.settings
        s.serverAddress = server.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.appKey != appKey { s.appKey = appKey.trimmingCharacters(in: .whitespacesAndNewlines) }
        s.wakeHost = wakeHost.trimmingCharacters(in: .whitespacesAndNewlines)
        s.wakePort = port ?? 9
        s.macAddress = mac.trimmingCharacters(in: .whitespaces).uppercased()
        model.refreshSoon()
    }

    /// Tries the draft values without saving them.
    private func test() async {
        testing = true
        defer { testing = false }
        do {
            let client = try APIClient(
                serverAddress: server,
                appKey: appKey.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            let status = try await client.status()
            testResult = .ok(status.online ? "Connected, PC is on" : "Connected, PC is off")
        } catch {
            testResult = .failed((error as? LocalizedError)?.errorDescription ?? "Couldn't connect")
        }
    }
}
