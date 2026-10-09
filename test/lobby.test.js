const test = require("node:test");
const assert = require("node:assert/strict");
const { assignSeat } = require("../lobby");

function player(id, seat = null) {
  return { id, name: id, seat };
}

test("an unassigned player can choose an empty role", () => {
  const first = player("first");
  const players = new Map([[first.id, first]]);
  assignSeat(players, first, "red-master");
  assert.equal(first.seat, "red-master");
});

test("seated players can swap occupied roles", () => {
  const first = player("first", "red-master");
  const second = player("second", "blue-agent");
  const players = new Map([[first.id, first], [second.id, second]]);
  assignSeat(players, first, "blue-agent");
  assert.equal(first.seat, "blue-agent");
  assert.equal(second.seat, "red-master");
});

test("choosing your own role makes it empty", () => {
  const first = player("first", "red-agent");
  const players = new Map([[first.id, first]]);
  assignSeat(players, first, "red-agent");
  assert.equal(first.seat, null);
});
