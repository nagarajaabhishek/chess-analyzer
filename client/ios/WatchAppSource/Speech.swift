import Foundation
import AVFoundation

/// Speaks the `speech` field the server returns on move/hint/control responses —
/// mirrors the phone bot's spoken feedback, just via on-watch TTS instead of Twilio <Say>.
final class Speech {
    static let shared = Speech()
    private let synthesizer = AVSpeechSynthesizer()

    private init() {}

    func speak(_ text: String) {
        guard !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }
}
