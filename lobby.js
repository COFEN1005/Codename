function assignSeat(players, player, seat) {
  const occupant = [...players.values()].find((candidate) => candidate.seat === seat);
  if (occupant?.id === player.id) {
    player.seat = null;
    return;
  }
  if (occupant) {
    if (!player.seat) throw new Error("先に空いている役割を選んでください。");
    occupant.seat = player.seat;
  }
  player.seat = seat;
}

module.exports = { assignSeat };
