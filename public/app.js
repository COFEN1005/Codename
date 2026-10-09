const socket = io();
const $ = (selector) => document.querySelector(selector);
const playerId = localStorage.playerId || (localStorage.playerId = crypto.randomUUID());
let state = null;
let importedDeck = null;
let bgmEnabled = localStorage.bgmEnabled !== "false";
let seEnabled = localStorage.seEnabled !== "false";
let bgmVolume = storedVolume("bgmVolume", 0.14);
let seVolume = storedVolume("seVolume", 0.22);
let audioUnlocked = false;
let currentBgm = null;
let bgmAudioContext = null;
let currentBgmSource = null;
let currentBgmGain = null;
let bgmRequestId = 0;
const bgmBufferPromises = new Map();
let adminMode = false;
let nextReminderAt = 0;
let keepAliveTimer = null;
const KEEP_ALIVE_REMINDER = 10 * 60 * 1000;

const bgmTracks = {
  lobby: { src: "/audio/lobby.mp3", gain: 0.9, fallback: Object.assign(new Audio("/audio/lobby.mp3"), { loop: true, preload: "auto" }) },
  battle: { src: "/audio/battle.mp3", gain: 1, fallback: Object.assign(new Audio("/audio/battle.mp3"), { loop: true, preload: "auto" }) }
};
const seTracks = {
  select: { src: "/audio/selectSE.mp3", gain: 0.65 },
  turn: { src: "/audio/turn.mp3", gain: 0.85 },
  hint: { src: "/audio/hint.mp3", gain: 0.85 },
  team: { src: "/audio/teamcardSE.mp3", gain: 0.9 },
  enemy: { src: "/audio/enemycardSE.mp3", gain: 0.9 },
  neutral: { src: "/audio/neutralcard.mp3", gain: 0.85 },
  assassin: { src: "/audio/badcard.mp3", gain: 1 }
};
for (const sound of Object.values(seTracks)) { const audio = new Audio(sound.src); audio.preload = "auto"; }
applyBgmVolume();

function storedVolume(key, fallback) {
  const value = Number.parseFloat(localStorage.getItem(key));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function applyBgmVolume() {
  for (const track of Object.values(bgmTracks)) track.fallback.volume = bgmVolume * track.gain;
  if (currentBgmGain && currentBgm && bgmAudioContext) {
    const target = bgmVolume * bgmTracks[currentBgm].gain;
    currentBgmGain.gain.cancelScheduledValues(bgmAudioContext.currentTime);
    currentBgmGain.gain.setTargetAtTime(target, bgmAudioContext.currentTime, 0.025);
  }
}

function getBgmContext() {
  if (!bgmAudioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio API is not supported");
    bgmAudioContext = new AudioContextClass();
  }
  return bgmAudioContext;
}

function loadBgmBuffer(type) {
  if (!bgmBufferPromises.has(type)) {
    const context = getBgmContext();
    const promise = fetch(bgmTracks[type].src)
      .then((response) => {
        if (!response.ok) throw new Error(`BGM load failed: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => context.decodeAudioData(data));
    bgmBufferPromises.set(type, promise);
  }
  return bgmBufferPromises.get(type);
}

function stopCurrentBgmPlayback() {
  if (currentBgmSource) {
    try { currentBgmSource.stop(); } catch {}
    currentBgmSource.disconnect();
  }
  if (currentBgmGain) currentBgmGain.disconnect();
  currentBgmSource = null;
  currentBgmGain = null;
  for (const track of Object.values(bgmTracks)) {
    track.fallback.pause();
    track.fallback.currentTime = 0;
  }
}

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
$("#end-game").onclick = () => { if (confirm("このゲームを終了して、カードファイルを選ぶ画面へ戻りますか？")) socket.emit("end-game"); };
$("#toggle-bgm").onclick = () => {
  bgmEnabled = !bgmEnabled; localStorage.bgmEnabled = bgmEnabled;
  updateAudioControls();
  if (bgmEnabled) playBgm(state?.game?.status === "playing" || state?.game?.status === "finished" ? "battle" : "lobby");
  else stopBgm();
};
$("#toggle-se").onclick = () => { seEnabled = !seEnabled; localStorage.seEnabled = seEnabled; updateAudioControls(); };
$("#open-audio-settings").onclick = (event) => {
  event.stopPropagation();
  const panel = $("#audio-settings");
  const opening = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !opening);
  $("#open-audio-settings").setAttribute("aria-expanded", String(opening));
};
$("#audio-settings").onclick = (event) => event.stopPropagation();
$("#bgm-volume").oninput = (event) => {
  bgmVolume = Number(event.target.value) / 100;
  localStorage.setItem("bgmVolume", String(bgmVolume));
  applyBgmVolume();
  updateAudioControls();
};
$("#se-volume").oninput = (event) => {
  seVolume = Number(event.target.value) / 100;
  localStorage.setItem("seVolume", String(seVolume));
  updateAudioControls();
};
$("#se-volume").onchange = () => playSe("select");
document.addEventListener("click", () => {
  $("#audio-settings").classList.add("hidden");
  $("#open-audio-settings").setAttribute("aria-expanded", "false");
});
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

function updateAudioControls() {
  $("#toggle-bgm").classList.toggle("muted", !bgmEnabled);
  $("#toggle-bgm").setAttribute("aria-pressed", String(bgmEnabled));
  $("#toggle-se").classList.toggle("muted", !seEnabled);
  $("#toggle-se").setAttribute("aria-pressed", String(seEnabled));
  $("#bgm-volume").value = String(Math.round(bgmVolume * 100));
  $("#bgm-volume-value").value = `${Math.round(bgmVolume * 100)}%`;
  $("#se-volume").value = String(Math.round(seVolume * 100));
  $("#se-volume-value").value = `${Math.round(seVolume * 100)}%`;
}

function unlockAudio() {
  audioUnlocked = true;
  if (bgmAudioContext?.state === "suspended") bgmAudioContext.resume().catch(() => {});
  playBgm(state?.game?.status === "playing" || state?.game?.status === "finished" ? "battle" : "lobby");
}

async function playBgm(type) {
  if (!bgmEnabled || !audioUnlocked || currentBgm === type) return;
  currentBgm = type;
  const requestId = ++bgmRequestId;
  try {
    const context = getBgmContext();
    if (context.state === "suspended") await context.resume();
    const buffer = await loadBgmBuffer(type);
    if (requestId !== bgmRequestId || currentBgm !== type || !bgmEnabled) return;
    stopCurrentBgmPlayback();
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain).connect(context.destination);
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(bgmVolume * bgmTracks[type].gain, context.currentTime + 0.12);
    source.start();
    currentBgmSource = source;
    currentBgmGain = gain;
  } catch {
    if (requestId !== bgmRequestId || currentBgm !== type || !bgmEnabled) return;
    stopCurrentBgmPlayback();
    bgmTracks[type].fallback.play().catch(() => { currentBgm = null; });
  }
}

function stopBgm() {
  bgmRequestId += 1;
  stopCurrentBgmPlayback();
  currentBgm = null;
}

function playSe(name) {
  if (!seEnabled || !audioUnlocked || !seTracks[name]) return;
  const audio = new Audio(seTracks[name].src);
  audio.volume = seVolume * seTracks[name].gain;
  audio.play().catch(() => {});
}

function handleStateAudio(previous, next) {
  const nextBgm = next.game.status === "playing" || next.game.status === "finished" ? "battle" : "lobby";
  playBgm(nextBgm);
  if (!previous?.game || previous.code !== next.code) return;
  const before = previous.game;
  const after = next.game;
  if (before.status === "lobby" && after.status === "playing") {
    setTimeout(() => playSe("turn"), 250);
    return;
  }
  if (!before.clue && after.clue) playSe("hint");
  const revealedIndex = after.cards?.findIndex((card, index) => card.revealed && !before.cards?.[index]?.revealed) ?? -1;
  if (revealedIndex >= 0) {
    const role = after.cards[revealedIndex].role;
    const guessingTeam = after.history?.at(-1)?.team;
    playSe(role === "assassin" ? "assassin" : role === "neutral" ? "neutral" : role === guessingTeam ? "team" : "enemy");
  }
  if (before.turn !== after.turn) setTimeout(() => playSe("turn"), revealedIndex >= 0 ? 650 : 0);
}

function handleStateVisual(previous, next) {
  if (!previous?.game?.cards || previous.code !== next.code) return;
  const revealedIndex = next.game.cards?.findIndex((card, index) => card.revealed && !previous.game.cards[index]?.revealed) ?? -1;
  if (revealedIndex < 0) return;
  const card = $("#board")?.children[revealedIndex];
  if (!card) return;
  card.classList.add("just-revealed");
  const role = next.game.cards[revealedIndex].role;
  const guessingTeam = next.game.history?.at(-1)?.team;
  if (role === guessingTeam) {
    card.classList.add("successful-reveal");
    const burst = document.createElement("span");
    burst.className = "success-burst";
    for (let i = 0; i < 14; i += 1) {
      const particle = document.createElement("i");
      const angle = (Math.PI * 2 * i) / 14;
      const distance = 42 + (i % 3) * 12;
      particle.style.setProperty("--x", `${Math.cos(angle) * distance}px`);
      particle.style.setProperty("--y", `${Math.sin(angle) * distance}px`);
      particle.style.setProperty("--delay", `${(i % 4) * 25}ms`);
      burst.appendChild(particle);
    }
    const label = document.createElement("span");
    label.className = "success-label";
    label.textContent = "SUCCESS";
    card.append(burst, label);
    $("#board").classList.add(`success-pulse-${role}`);
    setTimeout(() => $("#board")?.classList.remove(`success-pulse-${role}`), 900);
  }
  setTimeout(() => {
    card.classList.remove("just-revealed", "successful-reveal");
    card.querySelectorAll(".success-burst,.success-label").forEach((node) => node.remove());
  }, 1300);
}

document.addEventListener("pointerdown", unlockAudio, { once: true, capture: true });
document.addEventListener("keydown", unlockAudio, { once: true, capture: true });
document.addEventListener("click", (event) => {
  if (event.target.closest("button:not(:disabled)")) playSe("select");
}, { capture: true });
updateAudioControls();

async function importDeckFile(event) {
  const files = [...event.target.files];
  if (!files.length) return;
  try {
    const lists = await Promise.all(files.map(async (file) => {
      try {
        const text = await file.text();
        if (file.name.toLowerCase().endsWith(".json")) {
          const data = JSON.parse(text);
          const words = Array.isArray(data) ? data : data.words;
          if (!Array.isArray(words)) throw new Error("文字列の配列、または words 配列ではありません");
          return words;
        }
        if (file.name.toLowerCase().endsWith(".csv")) {
          return text.split(/\r?\n/).map((line) => line.split(",")[0].replace(/^\s*[\"']|[\"']\s*$/g, ""));
        }
        return text.split(/\r?\n/);
      } catch (error) {
        throw new Error(`${file.name}: ${error.message}`);
      }
    }));
    const words = [...new Set(lists.flat()
      .map((word) => String(word).trim())
      .filter((word) => word && !word.startsWith("#"))
      .map((word) => word.replace(/\s+/g, " ").slice(0, 20))
      .filter(Boolean))];
    if (words.length < 25 || words.length > 5_000) throw new Error(`重複を除いて合計25〜5,000語必要です（現在${words.length.toLocaleString("ja-JP")}語）。`);
    const deckName = files.length === 1 ? files[0].name : `${files.length}ファイル統合`;
    importedDeck = { name: deckName, words };
    $("#deck-preview").classList.remove("empty");
    $("#deck-preview").innerHTML = words.slice(0, 40).map((word) => `<span>${escapeHtml(word)}</span>`).join("") + (words.length > 40 ? `<i>ほか ${(words.length - 40).toLocaleString("ja-JP")}語</i>` : "");
    $("#editor-count").textContent = `${files.length}ファイル · ${words.length.toLocaleString("ja-JP")}語`;
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
  $("#game-message").textContent = occupied === 4 ? "カードを選んでゲームを開始できます" : "プレイヤーを待っています";
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
  setHidden("#owner-game-controls", !(state.isOwner && game.status === "playing"));

  const board = $("#board"); board.innerHTML = "";
  game.cards.forEach((card, index) => {
    const button = document.createElement("button");
    const marked = game.markedCard === index;
    button.className = `word-card ${card.role || "unknown"} ${card.revealed ? "revealed" : ""} ${marked ? `marked marked-${game.turn}` : ""}`;
    button.innerHTML = `<span>${escapeHtml(card.word)}</span>${card.role && !card.revealed ? `<i class="role-key">${roleMark(card.role)}</i>` : ""}${marked ? `<span class="card-marker" title="このカードを開く"><b>✓</b><small>OPEN</small></span>` : ""}`;
    button.disabled = card.revealed || !(myAction && !isMaster);
    button.onclick = (event) => socket.emit(event.target.closest(".card-marker") ? "guess-card" : "mark-card", index);
    board.appendChild(button);
  });
  renderGameLog(game.history || []);
}

function renderGameLog(history) {
  $("#log-count").textContent = history.length;
  const log = $("#game-log");
  if (!history.length) {
    log.innerHTML = '<p class="empty-log">最初のヒントを待っています。</p>';
    return;
  }
  log.innerHTML = [...history].reverse().map((entry, reverseIndex) => {
    const turnNumber = history.length - reverseIndex;
    const guesses = entry.guesses.length
      ? entry.guesses.map((guess, index) => `<li><b>${index + 1}</b><span>${escapeHtml(guess.word)}</span><i class="log-role ${guess.role}">${roleLabel(guess.role)}</i></li>`).join("")
      : '<li class="no-guess">まだカードを開いていません</li>';
    return `<article class="log-entry ${entry.team}"><header><span>TURN ${String(turnNumber).padStart(2, "0")}</span><strong>${escapeHtml(entry.clue.word)} <b>${entry.clue.count}</b></strong><i>${entry.team === "red" ? "RED" : "BLUE"}</i></header><ol>${guesses}</ol></article>`;
  }).join("");
}

function roleMark(role) { return ({ red: "●", blue: "●", neutral: "◆", assassin: "×" })[role] || ""; }
function roleLabel(role) { return ({ red: "RED", blue: "BLUE", neutral: "NEUTRAL", assassin: "ASSASSIN" })[role] || ""; }
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
  const previous = state;
  handleStateAudio(previous, next);
  state = next; history.replaceState({}, "", `/?room=${next.code}`); render();
  requestAnimationFrame(() => handleStateVisual(previous, next));
});
socket.on("game-error", toast);
socket.on("word-pool-saved", (message) => { toast(message); $("#word-editor").close(); });
socket.on("connect", () => {
  const code = new URLSearchParams(location.search).get("room");
  if (code && localStorage.playerName) socket.emit("join-room", { code, name: localStorage.playerName, playerId });
});
