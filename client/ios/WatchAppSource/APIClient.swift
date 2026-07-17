import Foundation

enum APIError: Error, LocalizedError {
    case notAuthenticated
    case server(String)
    case network(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Open ChessNow on your iPhone to sign in."
        case .server(let msg): return msg
        case .network(let err): return err.localizedDescription
        case .decoding: return "Unexpected response from server."
        }
    }
}

final class APIClient {
    static let shared = APIClient()
    private let baseURL = URL(string: "https://chessnow.app")!
    private let session = URLSession(configuration: .default)

    private init() {}

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        guard let token = SessionStore.shared.token else {
            throw APIError.notAuthenticated
        }
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.network(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.network(URLError(.badServerResponse))
        }

        if http.statusCode == 401 {
            throw APIError.notAuthenticated
        }

        if !(200...299).contains(http.statusCode) {
            if let errResp = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
                throw APIError.server(errResp.error)
            }
            throw APIError.server("Server error (\(http.statusCode))")
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    func newGame() async throws -> NewGameResponse {
        try await request("/api/games/new", method: "POST", body: [:])
    }

    func state(gameId: String) async throws -> GameStateResponse {
        try await request("/api/games/\(gameId)/state")
    }

    func move(gameId: String, text: String) async throws -> MoveResponse {
        try await request("/api/games/\(gameId)/move", method: "POST", body: ["text": text])
    }

    func control(gameId: String, action: String) async throws -> ControlResponse {
        try await request("/api/games/\(gameId)/control", method: "POST", body: ["action": action])
    }

    func hint(gameId: String) async throws -> HintResponse {
        try await request("/api/games/\(gameId)/hint", method: "POST", body: [:])
    }
}
