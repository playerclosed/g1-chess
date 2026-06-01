import { AppServer, AppSession } from "@mentra/sdk";
import { Chess } from "chess.js";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────
interface GameState {
  chess: Chess;
  playerColor: "w" | "b";
  gameOver: boolean;
  lastMsg: string;
}

// ────────────────────────────────────────────────────────────
// Chess App
// ────────────────────────────────────────────────────────────
class G1ChessApp extends AppServer {
  private games = new Map<string, GameState>();

  protected async onSession(
    session: AppSession,
    sessionId: string,
    _userId: string
  ): Promise<void> {
    console.log(`[Chess] Neue Session: ${sessionId}`);

    // Start new game (player = White)
    const state: GameState = {
      chess: new Chess(),
      playerColor: "w",
      gameOver: false,
      lastMsg: "",
    };
    this.games.set(sessionId, state);

    session.layouts.showTextWall(this.render(state,
      "♟ G1 Schach!\nDu = Weiss (W)\n\nSprich deinen Zug:\nz.B. \"e2 e4\" oder\n\"e2 nach e4\"\n\nOder: \"neu\" = Neustart\n\"aufgeben\" = Aufgabe"));

    // ── Voice input ──────────────────────────────────────────
    session.events.onTranscription(async (data) => {
      if (!data.isFinal) return;
      const raw = data.text.trim();
      if (!raw) return;

      const state = this.games.get(sessionId);
      if (!state) return;

      const input = raw.toLowerCase();
      console.log(`[Chess] Eingabe: "${raw}"`);

      // ── Restart ──────────────────────────────────────────
      if (input.includes("neu") || input.includes("restart") || input.includes("new game")) {
        const fresh: GameState = {
          chess: new Chess(),
          playerColor: "w",
          gameOver: false,
          lastMsg: "",
        };
        this.games.set(sessionId, fresh);
        session.layouts.showTextWall(this.render(fresh, "Neues Spiel!\nDu = Weiss. Dein Zug:"));
        return;
      }

      // ── Resign ───────────────────────────────────────────
      if (input.includes("aufgeb") || input.includes("resign")) {
        state.gameOver = true;
        session.layouts.showTextWall(this.render(state, "Du hast aufgegeben.\nSage \"neu\" für neues Spiel."));
        return;
      }

      // ── Game over guard ───────────────────────────────────
      if (state.gameOver) {
        session.layouts.showTextWall(this.render(state, "Spiel beendet.\nSage \"neu\" um neu zu spielen."));
        return;
      }

      // ── Not player's turn ─────────────────────────────────
      if (state.chess.turn() !== state.playerColor) {
        session.layouts.showTextWall(this.render(state, "KI denkt noch..."));
        return;
      }

      // ── Parse move ────────────────────────────────────────
      const moveStr = this.parseVoiceMove(input);
      if (!moveStr) {
        session.layouts.showTextWall(this.render(state,
          `Nicht verstanden: "${raw}"\nBitte spreche z.B.:\n"e2 e4"\n"d7 nach d5"`));
        return;
      }

      // ── Execute player move ───────────────────────────────
      let result;
      try {
        result = state.chess.move(moveStr);
      } catch {
        result = null;
      }

      if (!result) {
        session.layouts.showTextWall(this.render(state,
          `Ungültiger Zug: ${moveStr}\nVersuche es erneut.`));
        return;
      }

      // ── Check game over after player move ─────────────────
      if (state.chess.isGameOver()) {
        state.gameOver = true;
        const msg = state.chess.isCheckmate()
          ? "SCHACHMATT! Du gewinnst! 🎉"
          : state.chess.isStalemate()
          ? "PATT! Unentschieden."
          : "REMIS! Unentschieden.";
        session.layouts.showTextWall(this.render(state, `Dein Zug: ${result.san}\n\n${msg}\nSage "neu" für neues Spiel.`));
        return;
      }

      // ── Show board while AI thinks ────────────────────────
      const checkAfterPlayer = state.chess.inCheck() ? "\nSCHACH!" : "";
      session.layouts.showTextWall(this.render(state,
        `Dein Zug: ${result.san}${checkAfterPlayer}\nKI denkt...`));

      // ── AI move (small delay for UX) ─────────────────────
      await new Promise(r => setTimeout(r, 400));
      const aiMove = this.chooseAIMove(state.chess);
      state.chess.move(aiMove);

      // ── Check game over after AI move ─────────────────────
      if (state.chess.isGameOver()) {
        state.gameOver = true;
        const msg = state.chess.isCheckmate()
          ? "SCHACHMATT! KI gewinnt! 😢"
          : state.chess.isStalemate()
          ? "PATT! Unentschieden."
          : "REMIS!";
        session.layouts.showTextWall(this.render(state,
          `KI: ${aiMove}\n\n${msg}\nSage "neu" für neues Spiel.`));
        return;
      }

      // ── Continue game ─────────────────────────────────────
      const checkMsg = state.chess.inCheck() ? "\n⚠ SCHACH!" : "";
      session.layouts.showTextWall(this.render(state,
        `KI: ${aiMove}${checkMsg}\nDein Zug:`));
    });
  }

  // ────────────────────────────────────────────────────────
  // Parse voice command to UCI move string (e.g. "e2e4")
  // ────────────────────────────────────────────────────────
  private parseVoiceMove(input: string): string | null {
    // Remove common filler words
    const cleaned = input
      .replace(/\b(nach|to|bis|von|from|auf|on)\b/g, " ")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Match two squares: e.g. "e2 e4" or "e2e4"
    const uci = cleaned.match(/\b([a-h][1-8])\s*([a-h][1-8])\b/i);
    if (uci) return uci[1] + uci[2];

    // Named pieces (German + English) + destination
    const pieceMap: Record<string, string> = {
      springer: "N", knight: "N", pferd: "N",
      läufer: "B", bishop: "B", laufer: "B",
      turm: "R", rook: "R",
      dame: "Q", queen: "Q", königin: "Q",
      könig: "K", king: "K",
    };
    for (const [name, symbol] of Object.entries(pieceMap)) {
      const r = new RegExp(`${name}\\s+([a-h][1-8])`, "i");
      const m = cleaned.match(r);
      if (m) return symbol + m[1]; // SAN like "Nf3"
    }

    // Rochade / castle
    if (input.includes("rochade") || input.includes("castle") || input.includes("kurz")) return "O-O";
    if (input.includes("lang") && (input.includes("rochade") || input.includes("castle"))) return "O-O-O";

    return null;
  }

  // ────────────────────────────────────────────────────────
  // Simple AI: prefer checkmate > captures > checks > random
  // ────────────────────────────────────────────────────────
  private chooseAIMove(chess: Chess): string {
    const moves = chess.moves();
    if (moves.length === 0) return "";

    // Checkmate
    const checkmates = moves.filter(m => {
      const c = new Chess(chess.fen());
      c.move(m);
      return c.isCheckmate();
    });
    if (checkmates.length) return checkmates[0];

    // Captures
    const captures = moves.filter(m => m.includes("x"));
    // Checks
    const checks = moves.filter(m => m.includes("+"));

    // Priority: captures + checks > just captures > just checks > random
    const priority = [...new Set([...captures.filter(m => m.includes("+")), ...captures, ...checks])];
    if (priority.length) return priority[Math.floor(Math.random() * Math.min(priority.length, 3))];

    return moves[Math.floor(Math.random() * moves.length)];
  }

  // ────────────────────────────────────────────────────────
  // Render board + status message for G1 display
  // ────────────────────────────────────────────────────────
  private render(state: GameState, msg: string): string {
    const board = this.boardToText(state.chess, state.playerColor);
    const turn = state.chess.turn() === "w" ? "Weiss" : "Schwarz";
    const moveNum = state.chess.moveNumber();
    return `${board}\nZug ${moveNum} | ${turn} am Zug\n${msg}`;
  }

  private boardToText(chess: Chess, perspective: "w" | "b"): string {
    const fen = chess.fen().split(" ")[0];
    const rows = fen.split("/");

    // Expand FEN row to array of pieces
    const expand = (row: string): string[] => {
      const cells: string[] = [];
      for (const c of row) {
        if (c >= "1" && c <= "8") {
          for (let i = 0; i < parseInt(c); i++) cells.push(".");
        } else {
          cells.push(c);
        }
      }
      return cells;
    };

    const matrix: string[][] = rows.map(expand);

    // Flip for black perspective
    const displayRows = perspective === "w" ? matrix : [...matrix].reverse().map(r => [...r].reverse());
    const files = perspective === "w" ? "abcdefgh" : "hgfedcba";
    const rankStart = perspective === "w" ? 8 : 1;
    const rankDir = perspective === "w" ? -1 : 1;

    let board = ` ${[...files].join(" ")}\n`;
    for (let i = 0; i < 8; i++) {
      const rank = rankStart + rankDir * i;
      board += `${rank}${displayRows[i].join(" ")}\n`;
    }
    return board;
  }
}

// ────────────────────────────────────────────────────────────
// Start
// ────────────────────────────────────────────────────────────
const app = new G1ChessApp({
  packageName: process.env.PACKAGE_NAME || "com.player.codewords-chess",
  apiKey: process.env.MENTRA_API_KEY!,
  port: parseInt(process.env.PORT || "3000"),
});

app.start();
console.log(`♟ G1 Chess running on port ${process.env.PORT || 3000}`);
