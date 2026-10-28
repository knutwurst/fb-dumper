import Foundation

final class DumpRunner: ObservableObject {
    static let shared = DumpRunner()

    @Published private(set) var isRunning = false
    @Published private(set) var status = "Bereit"
    @Published private(set) var progress: Double?
    @Published private(set) var log = ""
    @Published private(set) var outputFolder: URL?
    @Published private(set) var failed = false

    private var process: Process?
    private var pipe: Pipe?
    private var buffer = Data()
    private var lines: [String] = []
    private var cancelled = false
    private var summary: String?
    private var lastError: String?

    private var cacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.github.knutwurst.fb-dumper")
    }

    func start(pageURL: String, destination: String) {
        guard !isRunning else { return }
        guard let cli = Bundle.main.resourceURL?.appendingPathComponent("dumper/src/cli.js"),
              FileManager.default.fileExists(atPath: cli.path) else {
            status = "Dumper fehlt im App-Bundle"
            failed = true
            return
        }

        reset()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", cli.path, pageURL, "--dest", destination]

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        env["NODE_NO_WARNINGS"] = "1"
        env["FB_DUMPER_CACHE"] = cacheDir.path
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.finish(proc) }
        }

        do {
            try process.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            status = "Start fehlgeschlagen: \(error.localizedDescription)"
            failed = true
            return
        }
        self.process = process
        self.pipe = pipe
        isRunning = true
        status = "Starte …"
    }

    func cancel() {
        guard let process, process.isRunning else { return }
        cancelled = true
        process.terminate()
    }

    private func reset() {
        buffer = Data()
        lines = []
        log = ""
        progress = nil
        outputFolder = nil
        failed = false
        cancelled = false
        summary = nil
        lastError = nil
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let index = buffer.firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
            let line = String(decoding: buffer[buffer.startIndex..<index], as: UTF8.self)
            buffer = Data(buffer[buffer.index(after: index)...])
            if !line.trimmingCharacters(in: .whitespaces).isEmpty { handle(line) }
        }
    }

    private func handle(_ line: String) {
        if line.hasPrefix("Output:") {
            outputFolder = URL(fileURLWithPath: line.dropFirst("Output:".count).trimmingCharacters(in: .whitespaces))
        } else if line.hasPrefix("→") {
            status = "Öffne Seite …"
            progress = nil
        } else if let m = line.firstMatch(of: /\((\d+) total\)/) {
            status = "Sammle Links … \(m.1) gefunden"
        } else if let m = line.firstMatch(of: /Downloading item (\d+) of (\d+)/), let i = Double(m.1), let n = Double(m.2) {
            status = "Lade Video \(m.1) von \(m.2)"
            progress = (i - 1) / n
        } else if let m = line.firstMatch(of: /^Converting (\d+)\/(\d+)/), let i = Double(m.1), let n = Double(m.2) {
            status = "Konvertiere \(m.1) von \(m.2) nach H.264"
            progress = (i - 1) / n
        } else if let m = line.firstMatch(of: /^Done: (\d+) videos/) {
            summary = "Fertig: \(m.1) Videos"
        } else if line.hasPrefix("Error:") {
            lastError = line.dropFirst("Error:".count).trimmingCharacters(in: .whitespaces)
        }

        guard line.firstMatch(of: /^\[download\]\s+[\d.]+%/) == nil else { return }
        lines.append(line)
        if lines.count > 2000 { lines.removeFirst(lines.count - 2000) }
        log = lines.joined(separator: "\n")
    }

    private func finish(_ proc: Process) {
        if let pipe {
            pipe.fileHandleForReading.readabilityHandler = nil
            consume(pipe.fileHandleForReading.readDataToEndOfFile())
        }
        if !buffer.isEmpty { consume(Data([0x0A])) }

        isRunning = false
        progress = nil
        process = nil
        pipe = nil

        if cancelled {
            status = "Abgebrochen"
        } else if proc.terminationStatus == 0 {
            status = summary ?? "Fertig"
        } else if let summary {
            status = "\(summary), einige fehlen – siehe Protokoll"
            failed = true
        } else {
            status = "Fehler: \(lastError ?? "siehe Protokoll")"
            failed = true
        }
    }
}
