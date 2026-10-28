import AppKit

let iconsetDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: iconsetDir, withIntermediateDirectories: true)

func whiteSymbol(_ name: String, pointSize: CGFloat) -> NSImage? {
    let cfg = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .semibold)
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil),
          let sym = base.withSymbolConfiguration(cfg) else { return nil }
    let s = sym.size
    let out = NSImage(size: s)
    out.lockFocus()
    sym.draw(in: NSRect(origin: .zero, size: s))
    NSColor.white.set()
    NSRect(origin: .zero, size: s).fill(using: .sourceAtop)
    out.unlockFocus()
    return out
}

func renderPNG(_ px: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    let size = CGFloat(px)
    let inset = size * 0.045
    let bg = NSRect(x: 0, y: 0, width: size, height: size).insetBy(dx: inset, dy: inset)
    let radius = bg.width * 0.2237
    let path = NSBezierPath(roundedRect: bg, xRadius: radius, yRadius: radius)
    let blue = NSColor(srgbRed: 0.03, green: 0.40, blue: 1.0, alpha: 1)
    let gradient = NSGradient(starting: NSColor(srgbRed: 0.13, green: 0.55, blue: 1.0, alpha: 1), ending: blue)!
    path.addClip()
    gradient.draw(in: bg, angle: -90)

    let base = NSFont.systemFont(ofSize: size * 0.78, weight: .heavy)
    let font = base.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: size * 0.78) } ?? base
    let letter = NSAttributedString(string: "f", attributes: [.font: font, .foregroundColor: NSColor.white])
    let bounds = letter.boundingRect(with: NSSize(width: size, height: size), options: [.usesDeviceMetrics])
    letter.draw(at: NSPoint(x: bg.minX + bg.width * 0.40 - bounds.midX, y: bg.minY - bounds.minY - bg.height * 0.02))

    let badgeSize = bg.width * 0.40
    let badge = NSRect(x: bg.maxX - badgeSize - bg.width * 0.07, y: bg.minY + bg.height * 0.07, width: badgeSize, height: badgeSize)
    NSColor.white.setFill()
    NSBezierPath(ovalIn: badge).fill()
    let cfg = NSImage.SymbolConfiguration(pointSize: badgeSize * 0.55, weight: .black)
    if let arrow = NSImage(systemSymbolName: "arrow.down", accessibilityDescription: nil)?.withSymbolConfiguration(cfg) {
        let tinted = NSImage(size: arrow.size)
        tinted.lockFocus()
        arrow.draw(in: NSRect(origin: .zero, size: arrow.size))
        blue.set()
        NSRect(origin: .zero, size: arrow.size).fill(using: .sourceAtop)
        tinted.unlockFocus()
        let s = tinted.size
        tinted.draw(in: NSRect(x: badge.midX - s.width / 2, y: badge.midY - s.height / 2, width: s.width, height: s.height))
    }

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

let targets: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

for (name, px) in targets {
    guard let data = renderPNG(px) else { print("FAIL \(name)"); continue }
    try? data.write(to: URL(fileURLWithPath: "\(iconsetDir)/\(name)"))
}
print("wrote \(targets.count) PNGs to \(iconsetDir)")
