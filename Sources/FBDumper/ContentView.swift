import AppKit
import SwiftUI

struct ContentView: View {
    @ObservedObject private var runner = DumpRunner.shared
    @AppStorage("destination") private var destination = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Downloads").path
    @AppStorage("quality") private var quality = Quality.fullH264
    @AppStorage("withVideos") private var withVideos = true
    @AppStorage("withPhotos") private var withPhotos = true
    @State private var pageURL = ""
    @State private var showLog = false

    private var trimmedURL: String { pageURL.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canStart: Bool { !trimmedURL.isEmpty && !destination.isEmpty && (withVideos || withPhotos) }
    private var tabs: [String] { (withVideos ? ["reels", "videos"] : []) + (withPhotos ? ["photos"] : []) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 10) {
                GridRow {
                    Text("Seite / Link").gridColumnAlignment(.trailing)
                    TextField("facebook.com/… oder instagram.com/…", text: $pageURL)
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
                GridRow {
                    Text("Inhalt")
                    HStack(spacing: 20) {
                        Toggle("Reels & Videos", isOn: $withVideos)
                        Toggle("Fotos", isOn: $withPhotos)
                    }
                    .toggleStyle(.checkbox)
                }
                GridRow(alignment: .firstTextBaseline) {
                    Text("Videoqualität")
                    Picker("Qualität", selection: $quality) {
                        ForEach(Quality.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.radioGroup)
                    .labelsHidden()
                    .disabled(!withVideos)
                }
            }
            .disabled(runner.isRunning)

            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        statusIcon.frame(width: 28, height: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(runner.status)
                                .font(.headline)
                                .foregroundStyle(runner.phase == .failed ? Color.red : Color.primary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .help(runner.status)
                            Text(runner.pageName ?? " ")
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer()
                    }

                    Group {
                        if let progress = runner.progress {
                            ProgressView(value: progress)
                        } else {
                            ProgressView().progressViewStyle(.linear)
                        }
                    }
                    .opacity(runner.isRunning ? 1 : 0)

                    HStack(spacing: 6) {
                        if let file = runner.currentFile {
                            Image(systemName: file.hasSuffix(".mp4") ? "film" : "photo").foregroundStyle(.secondary)
                            Text(file)
                                .font(.system(.callout, design: .monospaced))
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer(minLength: 0)
                        Text(runner.fileDetail ?? " ")
                            .font(.callout)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .frame(height: 18)

                    HStack(spacing: 16) {
                        if runner.links > 0 {
                            stat("link", "Links", runner.links)
                        }
                        stat("arrow.down.circle", "Neu geladen", runner.loaded)
                        if runner.skipped > 0 {
                            stat("checkmark.circle", "Schon da", runner.skipped)
                        }
                        if runner.converted > 0 {
                            stat("arrow.triangle.2.circlepath", "Umgewandelt", runner.converted)
                        }
                        if runner.errors > 0 {
                            stat("exclamationmark.triangle", "Fehler", runner.errors).foregroundStyle(.red)
                        }
                    }
                    .font(.callout)
                    .frame(height: 18)
                    .opacity(runner.hasStats ? 1 : 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(6)
            }

            HStack {
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

    @ViewBuilder private var statusIcon: some View {
        switch runner.phase {
        case .idle:
            Image(systemName: "arrow.down.circle").font(.title).foregroundStyle(.secondary)
        case .starting, .collecting, .downloading, .converting:
            ProgressView().controlSize(.small)
        case .done:
            Image(systemName: "checkmark.circle.fill").font(.title).foregroundStyle(.green)
        case .partial:
            Image(systemName: "exclamationmark.triangle.fill").font(.title).foregroundStyle(.orange)
        case .failed:
            Image(systemName: "xmark.octagon.fill").font(.title).foregroundStyle(.red)
        case .cancelled:
            Image(systemName: "stop.circle.fill").font(.title).foregroundStyle(.secondary)
        }
    }

    private func stat(_ symbol: String, _ label: String, _ value: Int) -> some View {
        Label {
            Text("\(label): \(value)").monospacedDigit()
        } icon: {
            Image(systemName: symbol)
        }
        .help(label)
    }

    private func start() {
        guard canStart, !runner.isRunning else { return }
        let path = (destination as NSString).expandingTildeInPath
        destination = path
        runner.start(pageURL: trimmedURL, destination: path, quality: quality, tabs: tabs)
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
