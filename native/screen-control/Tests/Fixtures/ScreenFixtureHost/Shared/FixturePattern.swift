// Emulator e2e fixture only. The synthetic picture the fixture host "captures" and the stand-in viewer reads back.
import CoreVideo
import Foundation

/// A flat-colour test card in 4:2:0 video range (what ScreenCaptureKit hands the real host): a grey field, a light bar
/// that moves with the frame number, and along the top a light marker, a dark marker and the frame number in 16 large
/// blocks, most significant bit first. Large flat blocks survive H.264 at any of the session's bit rates, so a viewer
/// that decodes a picture can tell which synthetic frame it is and that the frames arrive in order.
enum FixturePattern {
    static let counterBits = 16
    static let blocks = 2 + counterBits
    static let dark: UInt8 = 16, light: UInt8 = 235, field: UInt8 = 96, bar: UInt8 = 200, chroma: UInt8 = 128

    /// Block edge for a picture `width` pixels wide: the counter row fills a little over half the width.
    static func unit(width: Int) -> Int { max(8, (width / 30) & ~1) }

    /// Paints frame `frame` into an NV12 (`420YpCbCr8BiPlanarVideoRange`) buffer.
    static func paint(_ buffer: CVPixelBuffer, frame: Int64) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let width = CVPixelBufferGetWidthOfPlane(buffer, 0), height = CVPixelBufferGetHeightOfPlane(buffer, 0)
        guard let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return }
        let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let unit = unit(width: width)
        let top = unit / 2, left = unit / 2
        let barWidth = unit
        let barX = Int((frame * Int64(unit / 4)) % Int64(max(1, width - barWidth)))
        let value = UInt16(truncatingIfNeeded: frame)
        for y in 0..<height {
            let row = luma.advanced(by: y * lumaStride)
            memset(row, Int32(field), lumaStride)
            if y >= top, y < top + unit {
                for block in 0..<blocks {
                    let x = left + block * unit
                    guard x + unit <= width else { break }
                    let on = block == 0 ? true : block == 1 ? false : (value >> UInt16(counterBits - 1 - (block - 2))) & 1 == 1
                    memset(row.advanced(by: x), Int32(on ? light : dark), unit)
                }
            } else if y >= top + 2 * unit {
                memset(row.advanced(by: barX), Int32(bar), barWidth)
            }
        }
        if let chromaPlane = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) {
            let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
            memset(chromaPlane, Int32(chroma), stride * CVPixelBufferGetHeightOfPlane(buffer, 1))
        }
    }

    /// The frame number a decoded NV12 picture shows, or nil when its markers are not where this pattern puts them.
    static func read(_ buffer: CVPixelBuffer) -> Int? {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let width = CVPixelBufferGetWidthOfPlane(buffer, 0), height = CVPixelBufferGetHeightOfPlane(buffer, 0)
        guard let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }
        let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let unit = unit(width: width)
        let top = unit / 2, left = unit / 2
        guard left + blocks * unit <= width, top + unit <= height else { return nil }
        let bytes = luma.assumingMemoryBound(to: UInt8.self)
        // The mean of the block's middle quarter: away from the edges where compression rings.
        func level(_ block: Int) -> Int {
            let x0 = left + block * unit + unit * 3 / 8, y0 = top + unit * 3 / 8, side = max(1, unit / 4)
            var sum = 0
            for y in y0..<(y0 + side) { for x in x0..<(x0 + side) { sum += Int(bytes[y * stride + x]) } }
            return sum / (side * side)
        }
        guard level(0) > 170, level(1) < 80 else { return nil }
        var value = 0
        for bit in 0..<counterBits { value = value << 1 | (level(2 + bit) > 125 ? 1 : 0) }
        return value
    }
}
