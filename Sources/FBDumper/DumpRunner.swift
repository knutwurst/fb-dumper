import AppKit
import Foundation

enum Phase {
    case idle, starting, collecting, downloading, converting, done, partial, failed, cancelled
}

final class DumpRunner: ObservableObject {
    static let shared = DumpRunner()

    @Published private(set) var phase = Phase.idle
    @Published private(set) var status = "Bereit"
    @Published private(set) var progress: Double?
    @Published private(set) var pageName: String?
    @Published private(set) var currentFile: String?
    @Published private(set) var fileDetail: String?
    @Published private(set) var links = 0
    @Published private(set) var loaded = 0
    @Published private(set) var skipped = 0
    @Published private(set) var errors = 0
    @Published private(set) var converted = 0
    @Published private(set) var log = ""
    @Published private(set) var outputFolder: URL?

    var isRunning: Bool { [.starting, .collecting, .downloading, .converting].contains(phase) }
    var failed: Bool { phase == .failed || phase == .partial }
    var hasStats: Bool { links + loaded + skipped + errors + converted > 0 }

    private var process: Process?
    private var pipe: Pipe?
    private var buffer = Data()
    private var lines: [String] = []
    private var cancelled = false
    private var summary: String?
    private var lastError: String?
    private var item = 0
    private var items = 0
    private var itemCounted = false
    private var itemFailed = false
    private var currentId: String?

    private var cacheDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.github.knutwurst.fb-dumper")
    }

    func start(pageURL: String, destination: String, quality: Quality) {
        guard !isRunning else { return }
        guard let cli = Bundle.main.resourceURL?.appendingPathComponent("dumper/src/cli.js"),
              FileManager.default.fileExists(atPath: cli.path) else {
            status = "Dumper fehlt im App-Bundle"
            phase = .failed
            return
        }

        reset()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", cli.path, pageURL, "--dest", destination] + quality.arguments

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
            phase = .failed
            return
        }
        self.process = process
        self.pipe = pipe
        phase = .starting
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
        pageName = nil
        currentFile = nil
        fileDetail = nil
        links = 0
        loaded = 0
        skipped = 0
        errors = 0
        converted = 0
        cancelled = false
        summary = nil
        lastError = nil
        item = 0
        items = 0
        itemCounted = false
        itemFailed = false
        currentId = nil
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let index = buffer.firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
            let line = String(decoding: buffer[buffer.startIndex..<index], as: UTF8.self)
            buffer = Data(buffer[buffer.index(after: index)...])
            if !line.trimmingCharacters(in: .whitespaces).isEmpty { handle(line) }
        }
    }

    private func touch(_ id: Substring) {
        guard String(id) != currentId else { return }
        currentId = String(id)
        phase = .downloading
        item += 1
        items = max(items, item)
        itemCounted = false
        itemFailed = false
        status = "Lade Video \(item) von \(items)"
        progress = Double(item - 1) / Double(items)
        currentFile = nil
        fileDetail = nil
    }

    private func displayName(_ path: String) -> String {
        URL(fileURLWithPath: path).lastPathComponent
            .replacing(/\.f[\w-]+(?=\.\w+$)/, with: "")
            .replacing(/\.m4a$/, with: ".mp4")
    }

    private func pretty(_ size: String) -> String {
        guard let m = size.firstMatch(of: /^([\d.]+)([A-Za-z]+)/) else { return size }
        return "\(m.1.replacingOccurrences(of: ".", with: ",")) \(m.2)"
    }

    private func videos(_ n: Int) -> String { n == 1 ? "1 Video" : "\(n) Videos" }

    private func handle(_ line: String) {
        if line.hasPrefix("Output:") {
            let folder = URL(fileURLWithPath: line.dropFirst("Output:".count).trimmingCharacters(in: .whitespaces))
            outputFolder = folder
            pageName = folder.lastPathComponent
        } else if line.hasPrefix("→") {
            phase = .collecting
            status = line.contains("video") ? "Sammle Videos …" : "Sammle Reels …"
            progress = nil
        } else if let m = line.firstMatch(of: /\((\d+) total\)/), let n = Int(m.1) {
            links = n
        } else if let m = line.firstMatch(of: /^\d+ links found, (\d+) in/), let n = Int(m.1) {
            links = n
        } else if let m = line.firstMatch(of: /^Downloading (\d+) videos?$/), let n = Int(m.1) {
            phase = .downloading
            items = n
            item = 0
            status = "Lade \(videos(n)) …"
            progress = 0
        } else if let m = line.firstMatch(of: /^\[info\] (\S+): Downloading \d+ format/) {
            touch(m.1)
        } else if let m = line.firstMatch(of: /^\[download\] Destination: (.+)$/) {
            currentFile = displayName(String(m.1))
            fileDetail = nil
            if !itemCounted && !itemFailed {
                loaded += 1
                itemCounted = true
            }
        } else if let m = line.firstMatch(of: /^\[download\]\s+([\d.]+)% of\s+~?\s*(\S+)(?:\s+at\s+(\S+))?/),
                  let pct = Double(m.1) {
            var detail = "\(Int(pct)) % von \(pretty(String(m.2)))"
            if let speed = m.3, speed.first?.isNumber == true { detail += " · \(pretty(String(speed)))/s" }
            fileDetail = detail
            if items > 0 {
                progress = max(progress ?? 0, (Double(item - 1) + pct / 100) / Double(items))
            }
        } else if let m = line.firstMatch(of: /^\[download\] (\S+): has already been recorded in the archive/) {
            touch(m.1)
            skipped += 1
            currentFile = nil
            fileDetail = "Schon vorhanden, übersprungen"
        } else if line.hasPrefix("ERROR:") {
            if let m = line.firstMatch(of: /^ERROR: \[[\w:]+\] (\w+):/) { touch(m.1) }
            errors += 1
            if itemCounted {
                loaded -= 1
                itemCounted = false
            }
            itemFailed = true
        } else if let m = line.firstMatch(of: /^\[Merger\] Merging formats into "(.+)"$/) {
            currentFile = displayName(String(m.1))
            fileDetail = "Bild und Ton zusammenfügen"
        } else if line.firstMatch(of: /^Checking \d+ videos for H\.264/) != nil {
            phase = .converting
            status = "Prüfe Videoformate …"
            progress = nil
            currentFile = nil
            fileDetail = nil
        } else if let m = line.firstMatch(of: /^Converting (\d+)\/(\d+): (.+)$/), let i = Double(m.1), let n = Double(m.2) {
            phase = .converting
            status = "Wandle in H.264 um: \(m.1) von \(m.2)"
            progress = (i - 1) / n
            currentFile = String(m.3)
            fileDetail = nil
        } else if let m = line.firstMatch(of: /^Converted (\d+) videos/), let n = Int(m.1) {
            converted = n
        } else if let m = line.firstMatch(of: /^Done: (\d+) videos/), let n = Int(m.1) {
            summary = "Fertig: \(videos(n))"
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

        progress = nil
        currentFile = nil
        fileDetail = nil
        process = nil
        pipe = nil

        if cancelled {
            phase = .cancelled
            status = "Abgebrochen"
        } else if proc.terminationStatus == 0 {
            phase = .done
            status = summary ?? "Fertig"
        } else if let summary {
            phase = .partial
            status = errors > 0 ? "\(summary), \(errors) fehlgeschlagen" : "\(summary), einige fehlen"
        } else {
            phase = .failed
            status = "Fehler: \(lastError ?? "siehe Protokoll")"
        }

        if !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
    }
}
