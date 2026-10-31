/// The remaining time on an approval row. A request may wait 10 minutes, and "587초 남음" is hard to read at a glance.
public enum ControlCountdown {
    public static func text(secondsLeft: Int) -> String {
        let seconds = max(0, secondsLeft)
        return seconds >= 60 ? "\(seconds / 60)분 \(seconds % 60)초 남음" : "\(seconds)초 남음"
    }
}
