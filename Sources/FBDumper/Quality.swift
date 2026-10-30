enum Quality: String, CaseIterable, Identifiable {
    case standard, full, fullH264

    var id: Self { self }

    var title: String {
        switch self {
        case .standard: "Facebook-Standard – meist 720p H.264, unverändert"
        case .full: "Volle Auflösung – meist AV1, läuft nicht in der Vorschau"
        case .fullH264: "Volle Auflösung, in H.264 umgewandelt – läuft überall"
        }
    }

    var arguments: [String] {
        switch self {
        case .standard: ["--quality", "hd", "--keep-codec"]
        case .full: ["--quality", "full", "--keep-codec"]
        case .fullH264: ["--quality", "full"]
        }
    }
}
