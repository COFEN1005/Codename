const WORDS = [
  "灯台", "砂時計", "彗星", "珊瑚", "羅針盤", "稲妻", "温泉", "潜水艦", "忍者", "図書館",
  "虹", "砂漠", "望遠鏡", "風船", "迷路", "ピアノ", "氷山", "火山", "銀河", "王冠",
  "竹", "鏡", "ロボット", "恐竜", "花火", "宇宙船", "郵便", "コーヒー", "扇風機", "城",
  "電車", "太鼓", "カメラ", "翼", "鍵", "雪だるま", "サーカス", "宝石", "滝", "雲",
  "船長", "探偵", "博士", "騎士", "魔法", "時計", "トンネル", "島", "地図", "森",
  "月", "太陽", "星", "海", "山", "川", "橋", "塔", "庭", "工場",
  "劇場", "美術館", "病院", "学校", "市場", "空港", "港", "駅", "公園", "神殿",
  "ライオン", "ペンギン", "クジラ", "タコ", "フクロウ", "カメ", "キツネ", "ウサギ", "ワシ", "イルカ",
  "リンゴ", "レモン", "パン", "チーズ", "カレー", "寿司", "はちみつ", "コショウ", "ケーキ", "スープ",
  "ギター", "映画", "小説", "絵筆", "仮面", "切符", "手紙", "指輪", "帽子", "靴"
];

const TEAMS = ["red", "blue"];

function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function createBoard(random = Math.random, wordPool = WORDS) {
  const startingTeam = random() < 0.5 ? "red" : "blue";
  const otherTeam = startingTeam === "red" ? "blue" : "red";
  const roles = shuffle([
    ...Array(9).fill(startingTeam),
    ...Array(8).fill(otherTeam),
    ...Array(7).fill("neutral"),
    "assassin"
  ], random);
  const words = shuffle(wordPool, random).slice(0, 25);
  return {
    startingTeam,
    cards: words.map((word, index) => ({ word, role: roles[index], revealed: false }))
  };
}

function newGame(random = Math.random, wordPool = WORDS) {
  const board = createBoard(random, wordPool);
  return {
    status: "playing",
    cards: board.cards,
    turn: board.startingTeam,
    phase: "clue",
    clue: null,
    guessesLeft: 0,
    markedCards: [],
    history: [],
    winner: null,
    message: `${teamName(board.startingTeam)}のスパイマスターがヒントを出してください。`
  };
}

function teamName(team) {
  return team === "red" ? "レッド" : "ブルー";
}

function remaining(game, team) {
  return game.cards.filter((card) => card.role === team && !card.revealed).length;
}

function submitClue(game, team, word, count) {
  if (game.status !== "playing" || game.phase !== "clue" || game.turn !== team) {
    throw new Error("今はヒントを出せません。");
  }
  const cleanWord = String(word || "").trim().slice(0, 20);
  const cleanCount = Number(count);
  if (!cleanWord || !Number.isInteger(cleanCount) || cleanCount < 1 || cleanCount > 9) {
    throw new Error("ヒントと1〜9の数字を入力してください。");
  }
  const normalized = cleanWord.replace(/\s/g, "").toLowerCase();
  if (game.cards.some((card) => card.word.replace(/\s/g, "").toLowerCase() === normalized)) {
    throw new Error("盤面と同じ単語はヒントに使えません。");
  }
  game.clue = { word: cleanWord, count: cleanCount };
  game.markedCards = [];
  game.history.push({
    team,
    clue: { word: cleanWord, count: cleanCount },
    guesses: [],
    ended: false
  });
  game.guessesLeft = cleanCount + 1;
  game.phase = "guess";
  game.message = `${teamName(team)}のエージェントがカードを選んでください。`;
}

function endTurn(game) {
  const currentLog = game.history?.at(-1);
  if (currentLog && !currentLog.ended) currentLog.ended = true;
  game.turn = game.turn === "red" ? "blue" : "red";
  game.phase = "clue";
  game.clue = null;
  game.guessesLeft = 0;
  game.markedCards = [];
  game.message = `${teamName(game.turn)}のスパイマスターがヒントを出してください。`;
}

function markCard(game, team, index) {
  if (game.status !== "playing" || game.phase !== "guess" || game.turn !== team) {
    throw new Error("今はカードにマークできません。");
  }
  const card = game.cards[index];
  if (!card || card.revealed) throw new Error("そのカードにはマークできません。");
  const markedCards = game.markedCards || (game.markedCards = []);
  game.markedCards = markedCards.includes(index)
    ? markedCards.filter((markedIndex) => markedIndex !== index)
    : [...markedCards, index];
}

function guessCard(game, team, index) {
  if (game.status !== "playing" || game.phase !== "guess" || game.turn !== team) {
    throw new Error("今はカードを選べません。");
  }
  const card = game.cards[index];
  if (!card || card.revealed) throw new Error("そのカードは選べません。");
  if (!game.markedCards?.includes(index)) throw new Error("先にカードへマークしてください。");
  card.revealed = true;
  game.markedCards = game.markedCards.filter((markedIndex) => markedIndex !== index);
  const currentLog = game.history?.at(-1);
  if (currentLog) currentLog.guesses.push({ word: card.word, role: card.role });
  game.guessesLeft -= 1;

  if (card.role === "assassin") {
    game.status = "finished";
    game.winner = team === "red" ? "blue" : "red";
    if (currentLog) currentLog.ended = true;
    game.message = `暗殺者！ ${teamName(game.winner)}の勝利です。`;
    return;
  }

  for (const candidate of TEAMS) {
    if (remaining(game, candidate) === 0) {
      game.status = "finished";
      game.winner = candidate;
      if (currentLog) currentLog.ended = true;
      game.message = `${teamName(candidate)}が全エージェントを発見しました！`;
      return;
    }
  }

  if (card.role !== team || game.guessesLeft <= 0) {
    endTurn(game);
  } else {
    game.message = `正解！ あと${game.guessesLeft}回まで選べます。`;
  }
}

function publicGame(game, viewerRole) {
  if (!game) return null;
  const canSeeKey = viewerRole?.endsWith("master") && game.status !== "lobby";
  return {
    ...game,
    remaining: game.cards?.length ? { red: remaining(game, "red"), blue: remaining(game, "blue") } : null,
    cards: game.cards?.map((card) => ({
      word: card.word,
      revealed: card.revealed,
      role: card.revealed || canSeeKey ? card.role : null
    }))
  };
}

module.exports = { WORDS, createBoard, newGame, submitClue, markCard, guessCard, endTurn, publicGame, remaining };
