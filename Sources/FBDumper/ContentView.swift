import AppKit
import SwiftUI

struct ContentView: View {
    @ObservedObject private var runner = DumpRunner.shared
    @AppStorage("destination") private var destination = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Downloads").path
    @State private var pageURL = ""
    @State private var showLog = false

    private var trimmedURL: String { pageURL.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canStart: Bool { !trimmedURL.isEmpty && !destination.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 10) {
                GridRow {
                    Text("Seite / Reel").gridColumnAlignment(.trailing)
                    TextField("https://www.facebook.com/…", text: $pageURL)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(start)
                }
                GridRow {
                    Text("Zielordner")
                    HStack {
                        TextField("", text: $destination)
                            .textFieldStyle(.roundedBorder)
                        Button("Wählen …", action: chooseDestination)
                    }
                }
            }
            .disabled(runner.isRunning)

            VStack(alignment: .leading, spacing: 8) {
                if runner.isRunning {
                    if let progress = runner.progress {
                        ProgressView(value: progress)
                    } else {
                        ProgressView().progressViewStyle(.linear)
                    }
                }
                HStack {
                    Text(runner.status)
                        .foregroundStyle(runner.failed ? Color.red : Color.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(runner.status)
                    Spacer()
                    if let folder = runner.outputFolder, !runner.isRunning {
                        Button("Im Finder zeigen") { NSWorkspace.shared.open(folder) }
                    }
                    if runner.isRunning {
                        Button("Abbrechen") { runner.cancel() }
                            .keyboardShortcut(.cancelAction)
                    } else {
                        Button("Dump", action: start)
                            .keyboardShortcut(.defaultAction)
                            .disabled(!canStart)
                    }
                }
            }

            DisclosureGroup("Protokoll", isExpanded: $showLog) {
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(runner.log.isEmpty ? " " : runner.log)
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(6)
                        Color.clear.frame(height: 1).id("end")
                    }
                    .frame(height: 220)
                    .background(Color(nsColor: .textBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .onChange(of: runner.log) { _ in proxy.scrollTo("end", anchor: .bottom) }
                }
                .padding(.top, 6)
            }
        }
        .padding(20)
        .frame(width: 580)
        .onChange(of: runner.failed) { failed in
            if failed { showLog = true }
        }
    }

    private func start() {
        guard canStart, !runner.isRunning else { return }
        let path = (destination as NSString).expandingTildeInPath
        destination = path
        runner.start(pageURL: trimmedURL, destination: path)
    }

    private func chooseDestination() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Auswählen"
        panel.directoryURL = URL(fileURLWithPath: (destination as NSString).expandingTildeInPath)
        if panel.runModal() == .OK, let url = panel.url {
            destination = url.path
        }
    }
}
