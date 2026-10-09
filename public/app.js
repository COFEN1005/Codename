const socket = io();
const $ = (selector) => document.querySelector(selector);
const playerId = localStorage.playerId || (localStorage.playerId = crypto.randomUUID());
let state = null;
let importedDeck = null;
let adminMode = false;
let nextReminderAt = 0;
let keepAliveTimer = null;
const KEEP_ALIVE_REMINDER = 10 * 60 * 1000;

const roleLabels = {
  "red-master": "レッド・マスター", "red-agent": "レッド・エージェント",
  "blue-master": "ブルー・マスター", "blue-agent": "ブルー・エージェント"
};

function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function name() {
  const value = $("#player-name").value.trim();
  if (!value) { toast("コードネームを入力してください"); return null; }
  localStorage.playerName = value; return value;
}

$("#player-name").value = localStorage.playerName || "";
$("#join-code").value = new URLSearchParams(location.search).get("room") || "";
$("#join-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""); });
$("#create-room").onclick = () => { const n = name(); if (n) socket.emit("create-room", { name: n, playerId }); };
$("#join-room").onclick = () => { const n = name(); if (n) socket.emit("join-room", { code: $("#join-code").value, name: n, playerId }); };
$("#copy-room").onclick = async () => { await navigator.clipboard.writeText(`${location.origin}/?room=${state.code}`); toast("招待リンクをコピーしました"); };
$("#start-game").onclick = () => socket.emit("start-game");
$("#end-turn").onclick = () => socket.emit("end-turn");
$("#rematch").onclick = () => socket.emit("rematch");
$("#admin-mode-button").onclick = enableAdminMode;
$("#close-admin").onclick = disableAdminMode;
$("#keep-alive-now").onclick = () => extendConnection(false);
$("#reminder-extend").onclick = () => extendConnection(true);
$("#reminder-snooze").onclick = () => {
  setHidden("#keep-alive-reminder", true);
  nextReminderAt = Date.now() + 60_000;
  updateKeepAliveCountdown();
};

$("#clue-form").onsubmit = (event) => {
  event.preventDefault();
  socket.emit("submit-clue", { word: $("#clue-word").value, count: $("#clue-count").value });
  $("#clue-word").value = "";
};

$("#open-editor").onclick = () => $("#word-editor").showModal();
$("#deck-file").onchange = importDeckFile;
$("#save-words").onclick = () => {
  if (importedDeck) socket.emit("update-word-pool", importedDeck);
};

async function importDeckFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let words;
    if (file.name.toLowerCase().endsWith(".json")) {
      const data = JSON.parse(text);
      words = Array.isArray(data) ? data : data.words;
      if (!Array.isArray(words)) throw new Error("JSONは文字列の配列、または words 配列にしてください。");
    } else if (file.name.toLowerCase().endsWith(".csv")) {
      words = text.split(/\r?\n/).map((line) => line.split(",")[0].replace(/^\s*[\"']|[\"']\s*$/g, ""));
    } else {
      words = text.split(/\r?\n/);
    }
    words = [...new Set(words.map((word) => String(word).trim()).filter((word) => word && !word.startsWith("#")))];
    if (words.length < 25 || words.length > 300) throw new Error(`重複を除いて25〜300語必要です（現在${words.length}語）。`);
    importedDeck = { name: file.name, words };
    $("#deck-preview").classList.remove("empty");
    $("#deck-preview").innerHTML = words.slice(0, 40).map((word) => `<span>${escapeHtml(word)}</span>`).join("") + (words.length > 40 ? `<i>ほか ${words.length - 40}語</i>` : "");
    $("#editor-count").textContent = `${file.name} · ${words.length}語`;
    $("#save-words").disabled = false;
  } catch (error) {
    importedDeck = null; $("#save-words").disabled = true;
    $("#deck-preview").className = "deck-preview empty"; $("#deck-preview").textContent = error.message;
    $("#editor-count").textContent = "読み込みエラー";
  }
}

function setHidden(selector, hidden) { $(selector).classList.toggle("hidden", hidden); }

function enableAdminMode() {
  if (!state?.isOwner) return;
  adminMode = true;
  document.body.classList.add("admin-active");
  setHidden("#admin-console", false);
  $("#admin-mode-button").classList.add("active");
  $("#admin-mode-button").lastChild.textContent = " 管理者モード ON";
  nextReminderAt = Date.now() + KEEP_ALIVE_REMINDER;
  updateKeepAliveCountdown();
  clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(updateKeepAliveCountdown, 1000);
  toast("管理者モードを起動しました");
}

function disableAdminMode() {
  adminMode = false;
  document.body.classList.remove("admin-active");
  setHidden("#admin-console", true);
  setHidden("#keep-alive-reminder", true);
  $("#admin-mode-button").classList.remove("active");
  $("#admin-mode-button").lastChild.textContent = " 管理者モード";
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

function updateKeepAliveCountdown() {
  if (!adminMode || !state?.isOwner) return;
  const left = Math.max(0, nextReminderAt - Date.now());
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);
  $("#keep-alive-countdown").textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  if (left === 0) setHidden("#keep-alive-reminder", false);
}

async function extendConnection(fromReminder) {
  if (!state?.isOwner || !adminMode) return;
  const button = $("#keep-alive-now");
  const reminderButton = $("#reminder-extend");
  button.disabled = true;
  reminderButton.disabled = true;
  try {
    const result = await new Promise((resolve, reject) => {
      socket.timeout(5000).emit("keep-alive", (timeoutError, reply) => timeoutError ? reject(new Error("サーバーに接続できません。")) : resolve(reply));
    });
    if (!result?.ok) throw new Error(result?.error || "接続延長に失敗しました");
    const time = new Date(result.extendedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    $("#last-keep-alive").textContent = `${time} に延長済み`;
    nextReminderAt = Date.now() + KEEP_ALIVE_REMINDER;
    setHidden("#keep-alive-reminder", true);
    updateKeepAliveCountdown();
    toast(fromReminder ? "接続を延長しました。" : "接続を延長しました。10分後に確認します。");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    reminderButton.disabled = false;
  }
}

function renderLobby() {
  const occupied = state.players.filter((p) => p.name).length;
  $("#player-count").textContent = `${occupied} / 4`;
  $("#start-game").disabled = occupied !== 4;
  $("#start-game").innerHTML = occupied === 4 ? "ゲーム開始 <span>→</span>" : "4人そろったらゲーム開始 <span>→</span>";
  $("#word-count").textContent = `使用中：${state.deckName}（${state.wordCount}語）`;
  setHidden("#open-editor", !state.isOwner);

  for (const seat of state.players) {
    const el = document.getElementById(seat.seat);
    const type = seat.seat.endsWith("master") ? "SPYMASTER" : "FIELD AGENT";
    el.className = `seat ${seat.name ? "occupied" : "empty"} ${state.me?.seat === seat.seat ? "mine" : ""}`;
    el.innerHTML = `<div class="seat-icon">${seat.name ? seat.name.charAt(0) : "+"}</div><div><small>${type}</small><strong>${seat.name || "空席"}</strong></div>${seat.name && !seat.connected ? '<i>OFFLINE</i>' : ""}`;
    el.onclick = () => { if (!seat.name) socket.emit("change-seat", seat.seat); };
  }
}

function renderGame() {
  const game = state.game;
  const mySeat = state.me.seat;
  const myTeam = mySeat.startsWith("red") ? "red" : "blue";
  const isMaster = mySeat.endsWith("master");
  const isMyTurn = game.turn === myTeam;
  const myAction = game.status === "playing" && isMyTurn && ((isMaster && game.phase === "clue") || (!isMaster && game.phase === "guess"));

  $("#my-role").textContent = roleLabels[mySeat];
  $("#my-role").className = myTeam;
  $("#role-guide").textContent = isMaster ? "盤面の色を見て、仲間に1語のヒントを送ります。" : "マスターのヒントから、自チームのカードを見つけます。";
  $("#turn-chip").textContent = `${game.turn === "red" ? "RED" : "BLUE"} TURN`;
  $("#turn-chip").className = `turn-chip ${game.turn}`;
  $("#game-message").textContent = game.message;
  $("#red-left").textContent = game.remaining.red;
  $("#blue-left").textContent = game.remaining.blue;

  $("#clue-display").innerHTML = game.clue ? `<small>CURRENT SIGNAL</small><strong>${escapeHtml(game.clue.word)} <b>${game.clue.count}</b></strong>${game.phase === "guess" ? `<span>残り最大 ${game.guessesLeft} 回</span>` : ""}` : "<small>CURRENT SIGNAL</small><strong>ヒント待ち</strong>";
  setHidden("#clue-form", !(myAction && isMaster));
  setHidden("#guess-controls", !(myAction && !isMaster));
  setHidden("#waiting-copy", myAction || game.status === "finished");
  setHidden("#rematch", game.status !== "finished");

  const board = $("#board"); board.innerHTML = "";
  game.cards.forEach((card, index) => {
    const button = document.createElement("button");
    button.className = `word-card ${card.role || "unknown"} ${card.revealed ? "revealed" : ""}`;
    button.innerHTML = `<span>${escapeHtml(card.word)}</span>${card.role && !card.revealed ? `<i>${roleMark(card.role)}</i>` : ""}`;
    button.disabled = card.revealed || !(myAction && !isMaster);
    button.onclick = () => socket.emit("guess-card", index);
    board.appendChild(button);
  });
}

function roleMark(role) { return ({ red: "●", blue: "●", neutral: "◆", assassin: "×" })[role] || ""; }
function escapeHtml(text) { const div = document.createElement("div"); div.textContent = text; return div.innerHTML; }

function render() {
  setHidden("#home", true); setHidden("#room", false); setHidden("#room-badge", false);
  $("#room-code").textContent = state.code;
  setHidden("#admin-mode-button", !state.isOwner);
  if (!state.isOwner && adminMode) disableAdminMode();
  const inLobby = state.game.status === "lobby";
  setHidden("#lobby", !inLobby); setHidden("#game", inLobby); setHidden("#turn-chip", inLobby);
  if (inLobby) renderLobby(); else renderGame();
}

socket.on("room-state", (next) => {
  state = next; history.replaceState({}, "", `/?room=${next.code}`); render();
});
socket.on("game-error", toast);
socket.on("word-pool-saved", (message) => { toast(message); $("#word-editor").close(); });
socket.on("connect", () => {
  const code = new URLSearchParams(location.search).get("room");
  if (code && localStorage.playerName) socket.emit("join-room", { code, name: localStorage.playerName, playerId });
});
