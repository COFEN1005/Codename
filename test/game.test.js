const test = require("node:test");
const assert = require("node:assert/strict");
const { createBoard, newGame, submitClue, markCard, guessCard, publicGame } = require("../game");

test("board has 25 unique cards and correct role distribution", () => {
  const board = createBoard(() => 0.1);
  assert.equal(board.cards.length, 25);
  assert.equal(new Set(board.cards.map((c) => c.word)).size, 25);
  assert.equal(board.cards.filter((c) => c.role === "red").length, 9);
  assert.equal(board.cards.filter((c) => c.role === "blue").length, 8);
  assert.equal(board.cards.filter((c) => c.role === "neutral").length, 7);
  assert.equal(board.cards.filter((c) => c.role === "assassin").length, 1);
});

test("custom word pool is used", () => {
  const words = Array.from({ length: 30 }, (_, i) => `custom-${i}`);
  const board = createBoard(() => 0.2, words);
  assert.ok(board.cards.every((card) => card.word.startsWith("custom-")));
});

test("clue allows count plus one guesses", () => {
  const game = newGame(() => 0.1);
  submitClue(game, game.turn, "空", 2);
  assert.equal(game.phase, "guess");
  assert.equal(game.guessesLeft, 3);
  assert.deepEqual(game.history[0], {
    team: game.turn,
    clue: { word: "空", count: 2 },
    guesses: [],
    ended: false
  });
});

test("history connects guesses to the active clue", () => {
  const game = newGame(() => 0.1);
  const team = game.turn;
  submitClue(game, team, "自然", 2);
  const matchingIndex = game.cards.findIndex((card) => card.role === team);
  const selected = game.cards[matchingIndex];
  markCard(game, team, matchingIndex);
  guessCard(game, team, matchingIndex);
  assert.deepEqual(game.history[0].guesses, [{ word: selected.word, role: team }]);
  assert.equal(game.history[0].ended, false);
});

test("assassin ends game for opposite team", () => {
  const game = newGame(() => 0.1);
  const team = game.turn;
  submitClue(game, team, "危険", 1);
  const assassinIndex = game.cards.findIndex((c) => c.role === "assassin");
  markCard(game, team, assassinIndex);
  guessCard(game, team, assassinIndex);
  assert.equal(game.status, "finished");
  assert.notEqual(game.winner, team);
});

test("a card must be marked before it can be revealed", () => {
  const game = newGame(() => 0.1);
  const team = game.turn;
  submitClue(game, team, "確認", 1);
  const index = game.cards.findIndex((card) => card.role === team);
  assert.throws(() => guessCard(game, team, index), /マーク/);
  markCard(game, team, index);
  assert.equal(game.markedCard, index);
  guessCard(game, team, index);
  assert.equal(game.cards[index].revealed, true);
  assert.equal(game.markedCard, null);
});

test("field agents cannot see unrevealed key", () => {
  const game = newGame(() => 0.1);
  const view = publicGame(game, "red-agent");
  assert.ok(view.cards.every((c) => c.role === null));
  const masterView = publicGame(game, "red-master");
  assert.ok(masterView.cards.every((c) => c.role));
});
