const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Server } = require("socket.io");
const { WORDS, newGame, submitClue, markCard, guessCard, endTurn, publicGame } = require("./game");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1_000_000 });
const rooms = new Map();
const PORT = process.env.PORT || 3000;
const SEATS = ["red-master", "red-agent", "blue-master", "blue-agent"];
const MAX_WORD_POOL = 5_000;

app.disable("x-powered-by");
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/*splat", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 16);
}

function getPlayer(socket) {
  const room = rooms.get(socket.data.roomCode);
  return { room, player: room?.players.get(socket.data.playerId) };
}

function serializeRoom(room, player) {
  return {
    code: room.code,
    isOwner: player?.id === room.ownerId,
    wordCount: room.wordPool.length,
    deckName: room.deckName,
    me: player ? { id: player.id, name: player.name, seat: player.seat } : null,
    players: SEATS.map((seat) => {
      const occupant = [...room.players.values()].find((p) => p.seat === seat);
      return { seat, name: occupant?.name || null, connected: Boolean(occupant?.socketId) };
    }),
    game: publicGame(room.game, player?.seat)
  };
}

function broadcast(room) {
  for (const player of room.players.values()) {
    if (player.socketId) {
      io.to(player.socketId).emit("room-state", serializeRoom(room, player));
    }
  }
}

function error(socket, message) {
  socket.emit("game-error", message);
}

function enterRoom(socket, room, player) {
  if (player.socketId && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.disconnect(true);
  player.socketId = socket.id;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  broadcast(room);
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ name, playerId } = {}) => {
    const validName = cleanName(name);
    if (!validName) return error(socket, "名前を入力してください。");
    const code = roomCode();
    const id = String(playerId || crypto.randomUUID()).slice(0, 64);
    const player = { id, name: validName, seat: "red-master", socketId: socket.id };
    const room = { code, ownerId: id, wordPool: [...WORDS], deckName: "標準カード", players: new Map([[id, player]]), game: { status: "lobby", cards: [] } };
    rooms.set(code, room);
    enterRoom(socket, room, player);
  });

  socket.on("join-room", ({ code, name, playerId } = {}) => {
    const room = rooms.get(String(code || "").trim().toUpperCase());
    const validName = cleanName(name);
    if (!room) return error(socket, "ルームが見つかりません。");
    if (!validName) return error(socket, "名前を入力してください。");
    const id = String(playerId || crypto.randomUUID()).slice(0, 64);
    const returning = room.players.get(id);
    if (returning) {
      returning.name = validName;
      return enterRoom(socket, room, returning);
    }
    if (room.game.status !== "lobby") return error(socket, "ゲームはすでに始まっています。");
    const freeSeat = SEATS.find((seat) => ![...room.players.values()].some((p) => p.seat === seat));
    if (!freeSeat) return error(socket, "このルームは満員です。");
    const player = { id, name: validName, seat: freeSeat, socketId: socket.id };
    room.players.set(id, player);
    enterRoom(socket, room, player);
  });

  socket.on("change-seat", (seat) => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || room.game.status !== "lobby" || !SEATS.includes(seat)) return;
    if ([...room.players.values()].some((p) => p.seat === seat)) return error(socket, "その席は使用中です。");
    player.seat = seat;
    broadcast(room);
  });

  socket.on("update-word-pool", (payload) => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || player.id !== room.ownerId || room.game.status !== "lobby") {
      return error(socket, "カード候補を変更できるのは開始前のルーム作成者だけです。");
    }
    const words = Array.isArray(payload) ? payload : payload?.words;
    if (!Array.isArray(words)) return error(socket, "カード候補の形式が正しくありません。");
    const cleaned = [...new Set(words.map((word) => String(word).trim().replace(/\s+/g, " ").slice(0, 20)).filter(Boolean))];
    if (cleaned.length < 25) return error(socket, "重複しないカード候補を25語以上入力してください。");
    if (cleaned.length > MAX_WORD_POOL) return error(socket, `カード候補は合計${MAX_WORD_POOL.toLocaleString("ja-JP")}語までです。`);
    room.wordPool = cleaned;
    room.deckName = String(payload?.name || "読み込みカード").trim().slice(0, 60);
    broadcast(room);
    socket.emit("word-pool-saved", `${room.deckName}（${cleaned.length}語）を読み込みました。`);
  });

  socket.on("start-game", () => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || player.id !== room.ownerId) return error(socket, "ゲームを開始できるのはルーム作成者だけです。");
    if (room.game.status !== "lobby") return error(socket, "ゲームはすでに始まっています。");
    if (!room || room.players.size !== 4 || SEATS.some((seat) => ![...room.players.values()].some((p) => p.seat === seat))) {
      return error(socket, "4つの役割すべてにプレイヤーが必要です。");
    }
    room.game = newGame(Math.random, room.wordPool);
    broadcast(room);
  });

  socket.on("submit-clue", ({ word, count } = {}) => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || player.seat !== `${room.game.turn}-master`) return error(socket, "あなたのヒント番ではありません。");
    try { submitClue(room.game, room.game.turn, word, Number(count)); broadcast(room); }
    catch (err) { error(socket, err.message); }
  });

  socket.on("guess-card", (index) => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || player.seat !== `${room.game.turn}-agent`) return error(socket, "あなたの回答番ではありません。");
    try { guessCard(room.game, room.game.turn, Number(index)); broadcast(room); }
    catch (err) { error(socket, err.message); }
  });

  socket.on("mark-card", (index) => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || player.seat !== `${room.game.turn}-agent`) return error(socket, "あなたの回答番ではありません。");
    try { markCard(room.game, room.game.turn, Number(index)); broadcast(room); }
    catch (err) { error(socket, err.message); }
  });

  socket.on("end-turn", () => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || room.game.phase !== "guess" || player.seat !== `${room.game.turn}-agent`) return error(socket, "今はターンを終了できません。");
    endTurn(room.game);
    broadcast(room);
  });

  socket.on("rematch", () => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || player.id !== room.ownerId) return error(socket, "再戦を開始できるのはルーム作成者だけです。");
    if (room.game.status !== "finished") return error(socket, "終了したゲームがありません。");
    room.game = newGame(Math.random, room.wordPool);
    broadcast(room);
  });

  socket.on("end-game", () => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || player.id !== room.ownerId) return error(socket, "ゲームを終了できるのはルーム作成者だけです。");
    if (room.game.status !== "playing") return error(socket, "進行中のゲームがありません。");
    const currentLog = room.game.history?.at(-1);
    if (currentLog) currentLog.ended = true;
    room.game.status = "finished";
    room.game.phase = "finished";
    room.game.markedCard = null;
    room.game.winner = null;
    room.game.message = "ルーム作成者がゲームを終了しました。";
    broadcast(room);
  });

  socket.on("return-to-lobby", () => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || player.id !== room.ownerId) return error(socket, "ルームに戻せるのはルーム作成者だけです。");
    if (room.game.status !== "finished") return error(socket, "ゲーム終了後にルームへ戻れます。");
    room.game = { status: "lobby", cards: [] };
    broadcast(room);
  });

  socket.on("keep-alive", (ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const { room, player } = getPlayer(socket);
    if (!room || !player || player.id !== room.ownerId) {
      return reply({ ok: false, error: "接続を延長できるのはルーム作成者だけです。" });
    }
    reply({ ok: true, extendedAt: new Date().toISOString() });
  });

  socket.on("disconnect", () => {
    const { room, player } = getPlayer(socket);
    if (!room || !player || player.socketId !== socket.id) return;
    player.socketId = null;
    broadcast(room);
    if (room.game.status === "lobby") {
      setTimeout(() => {
        if (!player.socketId) room.players.delete(player.id);
        if (room.players.size === 0) rooms.delete(room.code); else broadcast(room);
      }, 60_000);
    }
  });
});

server.listen(PORT, () => console.log(`Signal Words listening on ${PORT}`));
